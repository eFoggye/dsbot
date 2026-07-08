/**
 * Реверс-публикатор: периодически опрашивает очередь заданий в таблице (через Web App)
 * и публикует в Discord — дела в «дела-ск» (embed) и состав в «состав-ск» (embeds).
 * Плюс архивация дела по реакции ✅ от прокуратуры.
 */

import { fetchPublishQueueFromApi, postActionToApi } from "../sinks/botApiSink.js";
import { buildCaseMessage } from "./caseEmbeds.js";
import { buildPgSkOMessage } from "./pgskoEmbeds.js";
import { buildRosterMessages } from "./rosterContent.js";
import { buildReportMessage } from "./reportEmbed.js";
import { buildActReviewMessage, buildActDecisionEdit } from "./actReviewEmbed.js";
import { buildDisciplineMessage } from "./disciplineEmbed.js";
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

export function startPublisher(client, config, logger) {
  if (!config.useApi) {
    logger.info("Публикатор выключен: не заданы BOT_API_URL/BOT_API_SECRET");
    return;
  }
  logger.info("Публикатор запущен (polling очереди)", { intervalMs: POLL_INTERVAL_MS, storage: config.storage });
  const tick = () => pollOnce(client, config, logger).catch((e) =>
    logger.error("Ошибка опроса очереди", { error: e.message }));
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

async function pollOnce(client, config, logger) {
  const queue = await fetchQueue(config, logger);
  if (!queue || !Array.isArray(queue.jobs) || queue.jobs.length === 0) return;

  for (const job of queue.jobs) {
    try {
      if (job.type === "case") {
        await publishCase(client, job, config, logger);
      } else if (job.type === "roster") {
        const idsByUnit = queue.rosterMessageIdsByUnit || {};
        const rosterIds = idsByUnit[job.unit || ""] || (job.unit ? [] : (queue.rosterMessageIds || []));
        await publishRoster(client, job, rosterIds, config, logger);
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
      } else {
        logger.warn("Неизвестный тип задания публикации", { type: job.type });
      }
    } catch (error) {
      logger.error("Не удалось выполнить задание публикации", { error: error.message, jobId: job.id });
    }
  }
}

async function fetchQueue(config, logger) {
  return fetchPublishQueueFromApi(config, logger);
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

async function publishRoster(client, job, rosterMessageIds, config, logger) {
  const channel = await client.channels.fetch(CHANNELS.roster);
  const guild = channel.guild;
  try { await guild.members.fetch(); } catch (e) { logger.warn("Не удалось загрузить участников (нужен Server Members Intent)", { error: e.message }); }

  const messages = buildRosterMessages(job.roster || [], guild);
  const newIds = [];

  // Если число сообщений совпало — редактируем; иначе удаляем старые и создаём заново.
  const canEdit = rosterMessageIds.length === messages.length && messages.length > 0;
  if (canEdit) {
    for (let i = 0; i < messages.length; i++) {
      const m = await channel.messages.fetch(rosterMessageIds[i]).catch(() => null);
      if (m) { await m.edit(messages[i]); newIds.push(m.id); }
      else { const sent = await channel.send(messages[i]); newIds.push(sent.id); }
    }
  } else {
    for (const oldId of rosterMessageIds) {
      const m = await channel.messages.fetch(oldId).catch(() => null);
      if (m) await m.delete().catch(() => {});
    }
    for (const payload of messages) {
      const sent = await channel.send(payload);
      newIds.push(sent.id);
    }
  }
  logger.info("Состав опубликован в состав-ск", { messages: newIds.length });
  await acknowledge({ type: "roster_published", queueId: job.id, unit: job.unit || "", messageIds: newIds }, config, logger);
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
