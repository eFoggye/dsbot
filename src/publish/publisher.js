/**
 * Реверс-публикатор: периодически опрашивает очередь заданий в таблице (через Web App)
 * и публикует в Discord — дела в «дела-ск» (embed) и состав в «состав-ск» (embeds).
 * Плюс архивация дела по реакции ✅ от прокуратуры.
 */

import { fetchPublishQueueFromApi, postActionToApi } from "../sinks/botApiSink.js";
import { buildCaseMessage } from "./caseEmbeds.js";
import { buildPgSkOMessage } from "./pgskoEmbeds.js";
import { buildRosterMessages } from "./rosterContent.js";
import { deleteRosterMessages, reconcileRosterMessages, selectRosterMessageIds } from "./rosterReconciler.js";
import { buildReportMessage } from "./reportEmbed.js";
import { buildActReviewMessage, buildActDecisionEdit } from "./actReviewEmbed.js";
import { buildDisciplineMessage } from "./disciplineEmbed.js";
import { buildKsoAssignmentMessage } from "./ksoAssignment.js";
import {
  CHANNELS,
  PROSECUTOR_ROLE_ID,
  ARCHIVE_EMOJI,
  ARCHIVE_REQUIRE_PROSECUTOR,
  PGSKO_APPROVE_EMOJI,
  PGSKO_APPROVER_ROLE_ID,
} from "./publishConfig.js";

// 30 сек: публикация состава/дел не требует секундной реактивности, а редкий
// опрос бережёт лимит API портала (бот с одного IP не должен долбить бэкенд).
const POLL_INTERVAL_MS = 30000;
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;
const memberFetchState = new Map();

async function ensureGuildMembers(guild, logger) {
  const current = memberFetchState.get(guild.id);
  const now = Date.now();
  if (current?.promise) return current.promise;
  if (current?.loadedAt && now - current.loadedAt < MEMBER_CACHE_TTL_MS) return;

  const promise = guild.members.fetch()
    .then(() => {
      memberFetchState.set(guild.id, { loadedAt: Date.now(), promise: null });
    })
    .catch((error) => {
      // Не повторяем gateway-запрос на каждом задании: при rate limit следующая
      // публикация использует уже имеющийся cache и попробует обновить его позже.
      memberFetchState.set(guild.id, { loadedAt: Date.now(), promise: null });
      logger.warn("Не удалось обновить кэш участников Discord", { error: error.message });
    });
  memberFetchState.set(guild.id, { loadedAt: current?.loadedAt || 0, promise });
  return promise;
}

export function startPublisher(client, config, logger) {
  if (!config.useApi) {
    logger.info("Публикатор выключен: не заданы BOT_API_URL/BOT_API_SECRET");
    return;
  }
  // botUnit печатаем в лог. На бою BOT_UNIT обязателен, чтобы публиковать
  // только задания своего управления.
  logger.info("Публикатор запущен (polling очереди)", { intervalMs: POLL_INTERVAL_MS, storage: config.storage, botUnit: config.botUnit });
  let polling = false;
  const tick = async () => {
    // Долгая очистка Discord не должна пересекаться со следующим interval tick:
    // иначе более старые publish/delete jobs могут завершиться в обратном порядке.
    if (polling) return;
    polling = true;
    try {
      await pollOnce(client, config, logger);
    } catch (error) {
      logger.error("Ошибка опроса очереди", { error: error.message });
    } finally {
      polling = false;
    }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

async function pollOnce(client, config, logger) {
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
        logger.warn("Неизвестный тип задания публикации", { type: job.type });
      }
    } catch (error) {
      logger.error("Не удалось выполнить задание публикации", { error: error.message, jobId: job.id });
    }
  }
}

async function fetchQueue(config, logger, unit) {
  return fetchPublishQueueFromApi(config, logger, unit);
}

async function acknowledge(action, config, logger) {
  return postActionToApi(action, {}, config, logger);
}

async function publishCase(client, job, config, logger) {
  const channel = await client.channels.fetch(CHANNELS.cases);
  const msg = buildCaseMessage({ status: job.status, caseNumber: job.caseNumber, investigator: job.investigator, docUrl: job.docUrl });
  if (!msg) {
    logger.warn("Статус дела не публикуется", { status: job.status, caseNumber: job.caseNumber });
    await acknowledge(
      { type: "case_published", queueId: job.id, unit: job.unit || "", messageId: "", caseNumber: job.caseNumber, status: job.status },
      config, logger,
    );
    return;
  }
  const sent = await channel.send(msg);
  logger.info("Дело опубликовано в дела-ск", { caseNumber: job.caseNumber, status: job.status, messageId: sent.id });
  await acknowledge(
    { type: "case_published", queueId: job.id, unit: job.unit || "", messageId: sent.id, caseNumber: job.caseNumber, status: job.status },
    config, logger,
  );
}

// Физическое удаление дела на портале должно убрать и связанные публикации
// в «дела-ск». Канал берётся только из локальной конфигурации бота: сохранённый
// порталом channelId используется для сверки, но никогда не позволяет удалить
// сообщение в произвольном Discord-канале.
async function deleteCasePublications(client, job, config, logger) {
  const channelId = String(CHANNELS.cases || "").trim();
  if (!channelId) throw new Error("Не задан канал дел (CASE_CHANNEL_ID)");
  const channel = await client.channels.fetch(channelId);
  const publications = Array.isArray(job.publications) ? job.publications : [];
  const messageIds = [...new Set(publications.map((publication) => {
    const storedChannelId = String(publication?.channelId || "").trim();
    if (storedChannelId && storedChannelId !== channelId) {
      logger.warn("Публикация дела относится к другому каналу и пропущена", {
        messageId: String(publication?.messageId || ""),
        channelId: storedChannelId,
      });
      return "";
    }
    return String(publication?.messageId || "").trim();
  }).filter(Boolean))];

  let deleted = 0;
  let missing = 0;
  for (const id of messageIds) {
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

  logger.info("Публикации удалённого дела очищены", {
    requested: messageIds.length,
    deleted,
    missing,
  });
  await acknowledge({
    type: "case_publications_deleted",
    queueId: job.id,
    unit: job.unit || "",
    messageIds,
    deletedCount: deleted,
    missingCount: missing,
  }, config, logger);
}

async function publishRoster(client, job, rosterMessageIds, config, logger) {
  const channel = await client.channels.fetch(CHANNELS.roster);
  const guild = channel.guild;
  await ensureGuildMembers(guild, logger);

  const messages = buildRosterMessages(job.roster || [], guild);
  const result = await reconcileRosterMessages(channel, client.user?.id, messages, rosterMessageIds);
  logger.info("Состав синхронизирован в состав-ск", {
    messages: result.messageIds.length,
    created: result.created,
    edited: result.edited,
    deletedDuplicates: result.deletedDuplicates,
  });
  await acknowledge({
    type: "roster_published",
    queueId: job.id,
    unit: job.unit || "",
    messageIds: result.messageIds,
  }, config, logger);
}

// Удаляет сохранённые публикации состава, а при purge дополнительно сканирует
// канал и находит исторические дубли. Поэтому число messageIds от портала — это
// лишь актуальный снимок, а не полный фактический счётчик сообщений в Discord.
// Ошибки "Unknown Message" считаются успешным результатом: карточка уже могла
// быть удалена вручную в Discord.
async function deleteRosterPublications(client, job, config, logger) {
  const channel = await client.channels.fetch(CHANNELS.roster);
  const payloads = buildRosterMessages([], channel.guild);
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
  await acknowledge({
    type: "roster_deleted",
    queueId: job.id,
    unit: job.unit || "",
    messageIds,
    discoveredCount: messageIds.length,
    deletedCount: result.deleted,
  }, config, logger);
}

async function publishReport(client, job, config, logger) {
  if (!CHANNELS.report) {
    logger.warn("Канал отчёта не задан (REPORT_CHANNEL_ID) — отчёт пропущен");
    await acknowledge({ type: "report_published", queueId: job.id, messageId: "" }, config, logger);
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.report);
  const sent = await channel.send(buildReportMessage(job));
  logger.info("Еженедельный отчёт опубликован", { messageId: sent.id, period: job.period });
  await acknowledge({ type: "report_published", queueId: job.id, messageId: sent.id }, config, logger);
}

async function publishPgSkOReport(client, job, config, logger) {
  if (!CHANNELS.pgskoReports) {
    logger.warn("Канал ПГСкО-отчётов не задан (PGSKO_REPORT_CHANNEL_ID) — публикация пропущена", {
      reportId: job.reportId,
    });
    await acknowledge(
      { type: "pgsko_published", queueId: job.id, unit: job.unit || "", reportId: job.reportId || "", messageId: "", messageUrl: "" },
      config, logger,
    );
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.pgskoReports);
  const sent = await channel.send(buildPgSkOMessage(job));
  const messageUrl = `https://discord.com/channels/${sent.guildId}/${sent.channelId}/${sent.id}`;
  logger.info("Отчёт ПГСкО опубликован", { reportId: job.reportId, messageId: sent.id });
  await acknowledge(
    {
      type: "pgsko_published",
      queueId: job.id,
      unit: job.unit || "",
      reportId: job.reportId || "",
      messageId: sent.id,
      messageUrl,
    },
    config, logger,
  );
}

async function publishActReview(client, job, config, logger) {
  if (!CHANNELS.actReview) {
    logger.warn("Канал «акты-и-делоодобрение» не задан (ACT_REVIEW_CHANNEL_ID) — пропуск", { actId: job.actId });
    await acknowledge({ type: "act_review_published", queueId: job.id, unit: job.unit || "", actId: job.actId || "", messageId: "" }, config, logger);
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.actReview);
  const sent = await channel.send(buildActReviewMessage(job));
  logger.info("Акт отправлен на рассмотрение в акты-и-делоодобрение", { actId: job.actId, caseNumber: job.caseNumber, messageId: sent.id });
  await acknowledge(
    { type: "act_review_published", queueId: job.id, unit: job.unit || "", actId: job.actId || "", messageId: sent.id },
    config, logger,
  );
}

// Решение по акту принято на сайте → редактируем карточку в «акты-и-делоодобрение».
async function editActDecision(client, job, config, logger) {
  if (!CHANNELS.actReview || !job.messageId) {
    await acknowledge({ type: "act_decided_done", queueId: job.id, unit: job.unit || "", actId: job.actId || "" }, config, logger);
    return;
  }
  try {
    const channel = await client.channels.fetch(CHANNELS.actReview);
    const message = await channel.messages.fetch(job.messageId).catch(() => null);
    if (message) {
      await message.edit(buildActDecisionEdit(job));
      logger.info("Карточка акта обновлена решением", { actId: job.actId, decision: job.decision || job.status });
    }
  } catch (error) {
    logger.error("Не удалось обновить карточку акта", { error: error.message, actId: job.actId });
  }
  await acknowledge({ type: "act_decided_done", queueId: job.id, unit: job.unit || "", actId: job.actId || "" }, config, logger);
}

// Дисциплинарное взыскание выдано/снято на сайте → публикуем уведомление в канал взысканий.
async function publishDiscipline(client, job, config, logger) {
  if (!CHANNELS.discipline) {
    logger.warn("Канал взысканий не задан (DISCIPLINE_CHANNEL_ID) — пропуск", { recordId: job.recordId });
    await acknowledge({ type: "discipline_published", queueId: job.id, unit: job.unit || "" }, config, logger);
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.discipline);
  const sent = await channel.send(buildDisciplineMessage(job));
  logger.info("Взыскание опубликовано", { recordId: job.recordId, action: job.action, type: job.type, messageId: sent.id });
  await acknowledge({ type: "discipline_published", queueId: job.id, unit: job.unit || "", messageId: sent.id }, config, logger);
}

async function publishKsoAssignment(client, job, config, logger) {
  if (!CHANNELS.ksoTasks) {
    throw new Error("Не задан канал задач КСУ (KSO_TASKS_CHANNEL_ID)");
  }
  const channel = await client.channels.fetch(CHANNELS.ksoTasks);
  const sent = await channel.send(buildKsoAssignmentMessage(job));
  logger.info("Уведомление КСУ опубликовано", {
    supervisionId: job.supervisionId,
    kind: job.kind,
    messageId: sent.id,
  });
  await acknowledge({
    type: "kso_assignment_published",
    queueId: job.id,
    unit: job.unit || "",
    supervisionId: job.supervisionId || "",
    messageId: sent.id,
  }, config, logger);
}

// Обработчик реакции ✅ в «дела-ск» → архивация дела (вызывается из index.js).
export async function handleArchiveReaction(reaction, user, config, logger) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (message.channelId !== CHANNELS.cases) return;
    if (reaction.emoji.name !== ARCHIVE_EMOJI) return;

    if (ARCHIVE_REQUIRE_PROSECUTOR && PROSECUTOR_ROLE_ID) {
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member || !member.roles.cache.has(PROSECUTOR_ROLE_ID)) return; // ✅ не от прокуратуры
    }
    logger.info("Реакция ✅ на деле — архивирую", { messageId: message.id });
    await acknowledge({ type: "archive_case_by_message", messageId: message.id }, config, logger);
  } catch (error) {
    logger.error("Ошибка обработки реакции архивации", { error: error.message });
  }
}

// Обработчик реакции ✅ в канале ПГСкО → зачёт отчёта в таблице.
export async function handlePgSkOReaction(reaction, user, config, logger) {
  try {
    if (user.bot) return;
    if (!CHANNELS.pgskoReports) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (message.channelId !== CHANNELS.pgskoReports) return;
    if (reaction.emoji.name !== PGSKO_APPROVE_EMOJI) return;

    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!PGSKO_APPROVER_ROLE_ID) {
      logger.warn("Реакция ПГСкО проигнорирована: не задан PGSKO_APPROVER_ROLE_ID", { messageId: message.id });
      return;
    }
    if (!member || !member.roles.cache.has(PGSKO_APPROVER_ROLE_ID)) return;

    logger.info("Реакция ✅ на отчёте ПГСкО — засчитываю", {
      messageId: message.id,
      approvedBy: member?.displayName || user.username,
    });
    await acknowledge(
      {
        type: "approve_pgsko_by_message",
        messageId: message.id,
        approvedById: user.id,
        approvedByName: member?.displayName || user.username,
      },
      config, logger,
    );
  } catch (error) {
    logger.error("Ошибка обработки реакции ПГСкО", { error: error.message });
  }
}
