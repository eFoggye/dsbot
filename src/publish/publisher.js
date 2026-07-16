/**
 * Реверс-публикатор: периодически опрашивает очередь заданий в таблице (через Web App)
 * и публикует в Discord — дела в «дела-ск» (embed) и состав в «состав-ск» (embeds).
 * Плюс архивация дела по реакции ✅ от прокуратуры.
 */

import { fetchPublishQueueFromApi, postActionToApi, postPublicationFailureToApi } from "../sinks/botApiSink.js";
import { buildCaseMessage } from "./caseEmbeds.js";
import { buildPgSkOMessage } from "./pgskoEmbeds.js";
import { buildRosterMessages } from "./rosterContent.js";
import { deleteRosterMessages, reconcileRosterMessages, selectRosterMessageIds } from "./rosterReconciler.js";
import { buildReportMessage } from "./reportEmbed.js";
import { buildActReviewMessage, buildActDecisionEdit } from "./actReviewEmbed.js";
import { buildDisciplineMessage } from "./disciplineEmbed.js";
import { buildKsoAssignmentMessage } from "./ksoAssignment.js";
import {
  findPublicationMessages,
  publicationQueueIdFromMessage,
  publishOnce,
  withPublicationMarker,
} from "./publicationDelivery.js";
import {
  ARCHIVE_EMOJI,
  PGSKO_APPROVE_EMOJI,
  casePublicationChannelIds,
  pgskoApproverRoleIdForUnit,
  prosecutorRoleIdForUnit,
  publicationChannelsForUnit,
} from "./publishConfig.js";

// 30 сек: публикация состава/дел не требует секундной реактивности, а редкий
// опрос бережёт лимит API портала (бот с одного IP не должен долбить бэкенд).
const POLL_INTERVAL_MS = 30000;

export function startPublisher(client, config, logger) {
  if (!config.useApi) {
    logger.info("Публикатор выключен: не заданы BOT_API_URL/BOT_API_SECRET");
    return { stop() {}, async drain() {} };
  }
  // botUnit печатаем в лог. На бою BOT_UNIT обязателен, чтобы публиковать
  // только задания своего управления.
  logger.info("Публикатор запущен (polling очереди)", { intervalMs: POLL_INTERVAL_MS, storage: config.storage, botUnit: config.botUnit });
  let stopped = false;
  let activeTick = null;
  const tick = () => {
    // Долгая очистка Discord не должна пересекаться со следующим interval tick:
    // иначе более старые publish/delete jobs могут завершиться в обратном порядке.
    if (stopped) return Promise.resolve();
    if (activeTick) return activeTick;
    activeTick = pollOnce(client, config, logger)
      .catch((error) => logger.error("Ошибка опроса очереди", { error: error.message }))
      .finally(() => { activeTick = null; });
    return activeTick;
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  const startup = preflightPublicationChannels(client, config, logger).then(tick);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async drain() {
      await startup;
      if (activeTick) await activeTick;
    },
  };
}

export async function pollOnce(client, config, logger) {
  // Управление бота (env BOT_UNIT) → сервер отдаёт задания строго этого управления.
  const queue = await fetchQueue(config, logger, config.botUnit);
  if (!queue || !Array.isArray(queue.jobs) || queue.jobs.length === 0) return;

  for (const job of queue.jobs) {
    try {
      if (job.type === "case") {
        await publishCase(client, job, config, logger);
      } else if (job.type === "case_publications_delete") {
        await deleteCasePublications(client, job, config, logger);
      } else if (job.type === "roster") {
        // Ответ API уже отфильтрован по BOT_UNIT, поэтому прямой список —
        // актуальные ID именно этого бота. Раньше при непустом job.unit он
        // ошибочно игнорировался, и каждый снимок создавал новые сообщения.
        const rosterIds = selectRosterMessageIds(queue, job.unit);
        await publishRoster(client, job, rosterIds, config, logger);
      } else if (job.type === "roster_delete") {
        await deleteRosterPublications(client, job, config, logger);
      } else if (job.type === "report") {
        await publishReport(client, job, config, logger);
      } else if (job.type === "pgsko_report") {
        await publishPgSkOReport(client, job, config, logger);
      } else if (job.type === "act_review") {
        await publishActReview(client, job, config, logger);
      } else if (job.type === "act_decided") {
        await editActDecision(client, job, config, logger);
      } else if (job.type === "discipline") {
        await publishDiscipline(client, job, config, logger);
      } else if (job.type === "kso_assignment") {
        await publishKsoAssignment(client, job, config, logger);
      } else {
        throw Object.assign(new Error(`Неизвестный тип задания публикации: ${job.type || "<empty>"}`), {
          code: "UNSUPPORTED_PUBLICATION_JOB",
        });
      }
    } catch (error) {
      logger.error("Не удалось выполнить задание публикации", { error: error.message, jobId: job.id });
      await postPublicationFailureToApi(job, error, config, logger);
    }
  }
}

async function fetchQueue(config, logger, unit) {
  return fetchPublishQueueFromApi(config, logger, unit);
}

async function acknowledge(job, action, config, logger) {
  return postActionToApi({
    ...(action || {}),
    queueId: String(job?.id || ""),
    claimToken: String(job?.claimToken || ""),
    unit: String(job?.unit || config.botUnit || ""),
  }, {}, config, logger);
}

function channelsFor(job, config) {
  return publicationChannelsForUnit(job?.unit || config.botUnit);
}

function requireChannel(job, config, key, envName) {
  const id = String(channelsFor(job, config)[key] || "").trim();
  if (!id) {
    throw Object.assign(new Error(`Не задан Discord-канал (${envName}) для ${job?.unit || config.botUnit}`), {
      code: "MISSING_PUBLICATION_CHANNEL",
    });
  }
  return id;
}

export async function preflightPublicationChannels(client, config, logger) {
  const channels = publicationChannelsForUnit(config.botUnit);
  const required = [
    ["cases", "CASES_CHANNEL_ID"], ["roster", "ROSTER_CHANNEL_ID"],
    ["report", "REPORT_CHANNEL_ID"], ["pgskoReports", "PGSKO_REPORT_CHANNEL_ID"],
    ["actReview", "ACT_REVIEW_CHANNEL_ID"], ["discipline", "DISCIPLINE_CHANNEL_ID"],
    ["ksoTasks", "KSO_TASKS_CHANNEL_ID"],
  ];
  const permissions = [
    ["ViewChannel", "ViewChannel"],
    ["ReadMessageHistory", "ReadMessageHistory"],
    ["SendMessages", "SendMessages"],
    ["EmbedLinks", "EmbedLinks"],
    ["AddReactions", "AddReactions"],
  ];
  for (const [key, envName] of required) {
    const channelId = String(channels[key] || "").trim();
    if (!channelId) {
      logger.error("Канал публикации не настроен", { unit: config.botUnit, channel: key, envName });
      continue;
    }
    try {
      const channel = await client.channels.fetch(channelId);
      const ownPermissions = channel?.permissionsFor?.(client.user);
      const missing = ownPermissions
        ? permissions.filter(([flag]) => !ownPermissions.has(flag)).map(([, name]) => name)
        : [];
      if (missing.length) logger.error("Боту не хватает прав в канале публикации", { channelId, channel: key, missing });
    } catch (error) {
      logger.error("Канал публикации недоступен", { channelId, channel: key, error: error.message });
    }
  }
}

async function publishCase(client, job, config, logger) {
  const channelId = requireChannel(job, config, "cases", "CASES_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const msg = buildCaseMessage({
    status: job.status,
    caseNumber: job.caseNumber,
    investigator: job.investigator,
    docUrl: job.docUrl,
    unit: job.unit,
  });
  if (!msg) {
    logger.warn("Статус дела не публикуется", { status: job.status, caseNumber: job.caseNumber });
    await acknowledge(job, {
      type: "case_published", messageId: "", channelId, caseNumber: job.caseNumber,
      status: job.status, outcome: "not_publishable",
    }, config, logger);
    return;
  }
  const result = await publishOnce(channel, client.user?.id, job, msg);
  const sent = result.message;
  logger.info("Дело синхронизировано в дела-ск", {
    caseNumber: job.caseNumber, status: job.status, messageId: sent.id, reused: result.reused,
  });
  await acknowledge(job, {
    type: "case_published", messageId: sent.id, channelId: sent.channelId || channelId,
    caseNumber: job.caseNumber, status: job.status,
  }, config, logger);
}

// Физическое удаление дела на портале должно убрать и связанные публикации
// в «дела-ск». Канал берётся только из локальной конфигурации бота: сохранённый
// порталом channelId используется для сверки, но никогда не позволяет удалить
// сообщение в произвольном Discord-канале.
export async function deleteCasePublications(client, job, config, logger) {
  const allowedChannelIds = casePublicationChannelIds(job.unit || config.botUnit);
  if (!allowedChannelIds.length) throw new Error("Не задан канал дел (CASES_CHANNEL_ID)");
  const primaryChannelId = allowedChannelIds[0];
  const publications = Array.isArray(job.publications) ? job.publications : [];
  const byChannel = new Map(allowedChannelIds.map((id) => [id, new Set()]));
  for (const publication of publications) {
    const storedChannelId = String(publication?.channelId || "").trim();
    if (storedChannelId && !byChannel.has(storedChannelId)) {
      throw Object.assign(new Error(`Канал старой публикации ${storedChannelId} не входит в CASES_LEGACY_CHANNEL_IDS`), {
        code: "UNTRUSTED_PUBLICATION_CHANNEL",
      });
    }
    const messageId = String(publication?.messageId || "").trim();
    if (messageId) byChannel.get(storedChannelId || primaryChannelId).add(messageId);
  }

  const publicationJobs = Array.isArray(job.publicationJobs) ? job.publicationJobs : [];
  const channels = new Map();
  for (const channelId of allowedChannelIds) {
    channels.set(channelId, await client.channels.fetch(channelId));
  }
  // An in-flight case send may not have ACKed and therefore has no stored
  // message ID. Its queue marker still lets deletion find it safely.
  for (const publicationJob of publicationJobs) {
    for (const [channelId, channel] of channels) {
      const marked = await findPublicationMessages(channel, client.user?.id, publicationJob);
      for (const message of marked) byChannel.get(channelId).add(String(message.id));
    }
  }

  let deleted = 0;
  let missing = 0;
  const messageIds = [];
  for (const [channelId, ids] of byChannel) {
    const channel = channels.get(channelId);
    for (const id of ids) {
      messageIds.push(id);
    let message;
    try {
      message = await channel.messages.fetch(id);
    } catch (error) {
      if (String(error?.code || "") !== "10008") throw error;
      message = null;
    }
    if (!message) {
      missing += 1;
      continue;
    }
    if (message.author?.id !== client.user?.id) {
      logger.warn("Удаление чужого сообщения в дела-ск заблокировано", { messageId: id });
      continue;
    }
    try {
      await message.delete();
      deleted += 1;
    } catch (error) {
      if (String(error?.code || "") !== "10008") throw error;
      missing += 1;
    }
    }
  }

  logger.info("Публикации удалённого дела очищены", {
    requested: messageIds.length,
    deleted,
    missing,
  });
  await acknowledge(job, {
    type: "case_publications_deleted",
    messageIds,
    deletedCount: deleted,
    missingCount: missing,
  }, config, logger);
}

async function publishRoster(client, job, rosterMessageIds, config, logger) {
  const channel = await client.channels.fetch(requireChannel(job, config, "roster", "ROSTER_CHANNEL_ID"));
  const guild = channel.guild;

  const messages = buildRosterMessages(job.roster || [], guild, { unit: job.unit || config.botUnit });
  const result = await reconcileRosterMessages(channel, client.user?.id, messages, rosterMessageIds);
  logger.info("Состав синхронизирован в состав-ск", {
    messages: result.messageIds.length,
    created: result.created,
    edited: result.edited,
    deletedDuplicates: result.deletedDuplicates,
  });
  await acknowledge(job, {
    type: "roster_published",
    messageIds: result.messageIds,
  }, config, logger);
}

// Удаляет сохранённые публикации состава, а при purge дополнительно сканирует
// канал и находит исторические дубли. Поэтому число messageIds от портала — это
// лишь актуальный снимок, а не полный фактический счётчик сообщений в Discord.
// Ошибки "Unknown Message" считаются успешным результатом: карточка уже могла
// быть удалена вручную в Discord.
async function deleteRosterPublications(client, job, config, logger) {
  const channel = await client.channels.fetch(requireChannel(job, config, "roster", "ROSTER_CHANNEL_ID"));
  const payloads = buildRosterMessages([], channel.guild, { unit: job.unit || config.botUnit });
  const result = await deleteRosterMessages(
    channel,
    client.user?.id,
    payloads,
    Array.isArray(job.messageIds) ? job.messageIds : [],
    { purge: job.purge === true },
  );
  const messageIds = result.messageIds;
  logger.info("Карточки состава удалены по команде портала", {
    tracked: Array.isArray(job.messageIds) ? job.messageIds.length : 0,
    discovered: messageIds.length,
    deleted: result.deleted,
    purge: !!job.purge,
  });
  await acknowledge(job, {
    type: "roster_deleted",
    messageIds,
    discoveredCount: messageIds.length,
    deletedCount: result.deleted,
  }, config, logger);
}

async function publishReport(client, job, config, logger) {
  const channelId = requireChannel(job, config, "report", "REPORT_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const result = await publishOnce(channel, client.user?.id, job, buildReportMessage(job));
  const sent = result.message;
  logger.info("Еженедельный отчёт синхронизирован", { messageId: sent.id, period: job.period, reused: result.reused });
  await acknowledge(job, { type: "report_published", messageId: sent.id, channelId: sent.channelId || channelId }, config, logger);
}

async function publishPgSkOReport(client, job, config, logger) {
  const channelId = requireChannel(job, config, "pgskoReports", "PGSKO_REPORT_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const result = await publishOnce(channel, client.user?.id, job, buildPgSkOMessage(job));
  const sent = result.message;
  const messageUrl = `https://discord.com/channels/${sent.guildId}/${sent.channelId}/${sent.id}`;
  logger.info("Отчёт ПГСкО синхронизирован", { reportId: job.reportId, messageId: sent.id, reused: result.reused });
  await acknowledge(job,
    {
      type: "pgsko_published",
      reportId: job.reportId || "",
      messageId: sent.id,
      channelId: sent.channelId || channelId,
      messageUrl,
    },
    config, logger,
  );
}

async function publishActReview(client, job, config, logger) {
  const channelId = requireChannel(job, config, "actReview", "ACT_REVIEW_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const result = await publishOnce(channel, client.user?.id, job, buildActReviewMessage(job));
  const sent = result.message;
  logger.info("Акт синхронизирован в акты-и-делоодобрение", {
    actId: job.actId, caseNumber: job.caseNumber, messageId: sent.id, reused: result.reused,
  });
  await acknowledge(job,
    { type: "act_review_published", actId: job.actId || "", messageId: sent.id, channelId: sent.channelId || channelId },
    config, logger,
  );
}

// Решение по акту принято на сайте → редактируем карточку в «акты-и-делоодобрение».
export async function editActDecision(client, job, config, logger) {
  const channel = await client.channels.fetch(requireChannel(job, config, "actReview", "ACT_REVIEW_CHANNEL_ID"));
  let message = null;
  if (job.messageId) {
    try {
      message = await channel.messages.fetch(job.messageId);
    } catch (error) {
      if (String(error?.code || "") !== "10008") throw error;
    }
  }
  if (!message && job.publicationQueueId) {
    [message] = await findPublicationMessages(channel, client.user?.id, {
      id: job.publicationQueueId,
      createdAt: job.publicationCreatedAt,
    });
  }
  if (!message) {
    throw Object.assign(new Error(`Карточка акта ${job.actId || ""} ещё не опубликована`), {
      code: "ACT_PUBLICATION_NOT_READY",
    });
  }
  const originalQueueId = job.publicationQueueId || publicationQueueIdFromMessage(message);
  const payload = originalQueueId
    ? withPublicationMarker(buildActDecisionEdit(job), originalQueueId)
    : buildActDecisionEdit(job);
  await message.edit(payload);
  logger.info("Карточка акта обновлена решением", { actId: job.actId, decision: job.decision || job.status });
  await acknowledge(job, { type: "act_decided_done", actId: job.actId || "" }, config, logger);
}

// Дисциплинарное взыскание выдано/снято на сайте → публикуем уведомление в канал взысканий.
async function publishDiscipline(client, job, config, logger) {
  const channelId = requireChannel(job, config, "discipline", "DISCIPLINE_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const result = await publishOnce(channel, client.user?.id, job, buildDisciplineMessage(job));
  const sent = result.message;
  logger.info("Взыскание синхронизировано", {
    recordId: job.recordId, action: job.action, type: job.type, messageId: sent.id, reused: result.reused,
  });
  await acknowledge(job, { type: "discipline_published", messageId: sent.id, channelId: sent.channelId || channelId }, config, logger);
}

async function publishKsoAssignment(client, job, config, logger) {
  const channelId = requireChannel(job, config, "ksoTasks", "KSO_TASKS_CHANNEL_ID");
  const channel = await client.channels.fetch(channelId);
  const result = await publishOnce(channel, client.user?.id, job, buildKsoAssignmentMessage(job));
  const sent = result.message;
  logger.info("Уведомление КСУ синхронизировано", {
    supervisionId: job.supervisionId,
    kind: job.kind,
    messageId: sent.id,
    reused: result.reused,
  });
  await acknowledge(job, {
    type: "kso_assignment_published",
    supervisionId: job.supervisionId || "",
    messageId: sent.id,
    channelId: sent.channelId || channelId,
  }, config, logger);
}

// Обработчик реакции ✅ в «дела-ск» → архивация дела (вызывается из index.js).
export async function handleArchiveReaction(reaction, user, config, logger) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const channels = publicationChannelsForUnit(config.botUnit);
    if (message.channelId !== channels.cases) return;
    if (reaction.emoji.name !== ARCHIVE_EMOJI) return;

    const prosecutorRoleId = prosecutorRoleIdForUnit(config.botUnit);
    if (!prosecutorRoleId) {
      logger.warn("Реакция архивации проигнорирована: не задан PROSECUTOR_ROLE_ID", { messageId: message.id });
      return;
    }
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member || !member.roles.cache.has(prosecutorRoleId)) return; // ✅ не от прокуратуры
    logger.info("Реакция ✅ на деле — архивирую", { messageId: message.id });
    await postActionToApi({
      type: "archive_case_by_message",
      unit: config.botUnit,
      messageId: message.id,
      publicationQueueId: publicationQueueIdFromMessage(message),
    }, {}, config, logger);
  } catch (error) {
    logger.error("Ошибка обработки реакции архивации", { error: error.message });
  }
}

// Обработчик реакции ✅ в канале ПГСкО → зачёт отчёта в таблице.
export async function handlePgSkOReaction(reaction, user, config, logger) {
  try {
    if (user.bot) return;
    const channels = publicationChannelsForUnit(config.botUnit);
    if (!channels.pgskoReports) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (message.channelId !== channels.pgskoReports) return;
    if (reaction.emoji.name !== PGSKO_APPROVE_EMOJI) return;

    const member = await message.guild.members.fetch(user.id).catch(() => null);
    const approverRoleId = pgskoApproverRoleIdForUnit(config.botUnit);
    if (!approverRoleId) {
      logger.warn("Реакция ПГСкО проигнорирована: не задан PGSKO_APPROVER_ROLE_ID", { messageId: message.id });
      return;
    }
    if (!member || !member.roles.cache.has(approverRoleId)) return;

    logger.info("Реакция ✅ на отчёте ПГСкО — засчитываю", {
      messageId: message.id,
      approvedBy: member?.displayName || user.username,
    });
    await postActionToApi(
      {
        type: "approve_pgsko_by_message",
        unit: config.botUnit,
        messageId: message.id,
        publicationQueueId: publicationQueueIdFromMessage(message),
        approvedById: user.id,
        approvedByName: member?.displayName || user.username,
      },
      {}, config, logger,
    );
  } catch (error) {
    logger.error("Ошибка обработки реакции ПГСкО", { error: error.message });
  }
}
