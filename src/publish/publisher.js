/**
 * Реверс-публикатор: периодически опрашивает очередь заданий в таблице (через Web App)
 * и публикует в Discord — дела в «дела-ск» (embed) и состав в «состав-ск» (embeds).
 * Плюс архивация дела по реакции ✅ от прокуратуры.
 */

import { fetchPublishQueue, postAction } from "../sinks/httpSink.js";
import { buildCaseMessage } from "./caseEmbeds.js";
import { buildPgSkOMessage } from "./pgskoEmbeds.js";
import { buildRosterMessages } from "./rosterContent.js";
import { buildReportMessage } from "./reportEmbed.js";
import {
  CHANNELS,
  PROSECUTOR_ROLE_ID,
  ARCHIVE_EMOJI,
  ARCHIVE_REQUIRE_PROSECUTOR,
  PGSKO_APPROVE_EMOJI,
  PGSKO_APPROVER_ROLE_ID,
} from "./publishConfig.js";

const POLL_INTERVAL_MS = 15000;

export function startPublisher(client, config, logger) {
  if (!config.webhookUrl) {
    logger.info("Публикатор выключен: не задан OUTPUT_WEBHOOK_URL");
    return;
  }
  logger.info("Публикатор запущен (polling очереди)", { intervalMs: POLL_INTERVAL_MS });
  const tick = () => pollOnce(client, config, logger).catch((e) =>
    logger.error("Ошибка опроса очереди", { error: e.message }));
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

async function pollOnce(client, config, logger) {
  const queue = await fetchPublishQueue(config, logger);
  if (!queue || !Array.isArray(queue.jobs) || queue.jobs.length === 0) return;

  for (const job of queue.jobs) {
    try {
      if (job.type === "case") {
        await publishCase(client, job, config, logger);
      } else if (job.type === "roster") {
        await publishRoster(client, job, queue.rosterMessageIds || [], config, logger);
      } else if (job.type === "report") {
        await publishReport(client, job, config, logger);
      } else if (job.type === "pgsko_report") {
        await publishPgSkOReport(client, job, config, logger);
      } else {
        logger.warn("Неизвестный тип задания публикации", { type: job.type });
      }
    } catch (error) {
      logger.error("Не удалось выполнить задание публикации", { error: error.message, jobId: job.id });
    }
  }
}

async function publishCase(client, job, config, logger) {
  const channel = await client.channels.fetch(CHANNELS.cases);
  const msg = buildCaseMessage({ status: job.status, caseNumber: job.caseNumber, investigator: job.investigator });
  if (!msg) {
    logger.warn("Статус дела не публикуется", { status: job.status, caseNumber: job.caseNumber });
    await postAction(
      { type: "case_published", queueId: job.id, messageId: "", caseNumber: job.caseNumber, status: job.status },
      {}, config, logger,
    );
    return;
  }
  const sent = await channel.send(msg);
  logger.info("Дело опубликовано в дела-ск", { caseNumber: job.caseNumber, status: job.status, messageId: sent.id });
  await postAction(
    { type: "case_published", queueId: job.id, messageId: sent.id, caseNumber: job.caseNumber, status: job.status },
    {}, config, logger,
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
  await postAction({ type: "roster_published", queueId: job.id, messageIds: newIds }, {}, config, logger);
}

async function publishReport(client, job, config, logger) {
  if (!CHANNELS.report) {
    logger.warn("Канал отчёта не задан (REPORT_CHANNEL_ID) — отчёт пропущен");
    await postAction({ type: "report_published", queueId: job.id, messageId: "" }, {}, config, logger);
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.report);
  const sent = await channel.send(buildReportMessage(job));
  logger.info("Еженедельный отчёт опубликован", { messageId: sent.id, period: job.period });
  await postAction({ type: "report_published", queueId: job.id, messageId: sent.id }, {}, config, logger);
}

async function publishPgSkOReport(client, job, config, logger) {
  if (!CHANNELS.pgskoReports) {
    logger.warn("Канал ПГСкО-отчётов не задан (PGSKO_REPORT_CHANNEL_ID) — публикация пропущена", {
      reportId: job.reportId,
    });
    await postAction(
      { type: "pgsko_published", queueId: job.id, reportId: job.reportId || "", messageId: "", messageUrl: "" },
      {}, config, logger,
    );
    return;
  }
  const channel = await client.channels.fetch(CHANNELS.pgskoReports);
  const sent = await channel.send(buildPgSkOMessage(job));
  const messageUrl = `https://discord.com/channels/${sent.guildId}/${sent.channelId}/${sent.id}`;
  logger.info("Отчёт ПГСкО опубликован", { reportId: job.reportId, messageId: sent.id });
  await postAction(
    {
      type: "pgsko_published",
      queueId: job.id,
      reportId: job.reportId || "",
      messageId: sent.id,
      messageUrl,
    },
    {}, config, logger,
  );
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
    await postAction({ type: "archive_case_by_message", messageId: message.id }, {}, config, logger);
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
    if (PGSKO_APPROVER_ROLE_ID && (!member || !member.roles.cache.has(PGSKO_APPROVER_ROLE_ID))) return;

    logger.info("Реакция ✅ на отчёте ПГСкО — засчитываю", {
      messageId: message.id,
      approvedBy: member?.displayName || user.username,
    });
    await postAction(
      {
        type: "approve_pgsko_by_message",
        messageId: message.id,
        approvedById: user.id,
        approvedByName: member?.displayName || user.username,
      },
      {}, config, logger,
    );
  } catch (error) {
    logger.error("Ошибка обработки реакции ПГСкО", { error: error.message });
  }
}
