import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import { loadConfig } from "./config.js";
import { getChannelRule } from "./channelRules.js";
import { createLogger } from "./logger.js";
import { normalizeMessage } from "./messageNormalizer.js";
import { saveMessageToFiles } from "./sinks/fileSink.js";
import { postMessageEvent, postAction } from "./sinks/httpSink.js";
import { postMessageEventToSql, postActionToSql } from "./sinks/sqlSink.js";
import { recognizeOrder, orderActionsToSheetActions } from "./ocr/orderOcr.js";
import { startPublisher, handleArchiveReaction, handlePgSkOReaction } from "./publish/publisher.js";

const config = loadConfig({ requireRuntime: true });
const logger = createLogger(config.logLevel);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    // PRIVILEGED: нужен для резолва ников в @плашки при публикации состава.
    // Включить в Developer Portal → Bot → Server Members Intent.
    GatewayIntentBits.GuildMembers,
  ],
  // partials нужны, чтобы ловить реакции и на сообщения, которых нет в кеше (старые).
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info("Discord listener started", {
    botUser: readyClient.user.tag,
    botUserId: readyClient.user.id,
    channels: Array.from(config.channelIds),
    outputDir: config.outputDir,
    webhookEnabled: Boolean(config.webhookUrl),
    sqlEnabled: config.useSql,
    storage: config.storage,
    ignoreBots: config.ignoreBots,
  });
  // Реверс-публикации (таблица → Discord): опрос очереди заданий.
  startPublisher(readyClient, config, logger);
});

async function processMessage(message, source) {
  try {
    const event = normalizeMessage(message);
    await saveMessageToFiles(event, config);
    await deliverMessageEvent(event);
    logger.info("Captured message", {
      source,
      channelId: event.channelId,
      messageId: event.messageId,
      authorId: event.author.id,
      actionType: event.sheetAction?.type || undefined,
      caseNumber: event.parsed.caseNumber || undefined,
    });

    // Приказы-картинки из «внутреннего оборота» → OCR через Claude Vision (если задан ключ).
    if (config.ocrApiKey && event.sheetAction?.type === "internal_order_needs_ocr") {
      await processOrderOcr(event);
    }
  } catch (error) {
    logger.error("Failed to process message", {
      error: error.message,
      channelId: message.channelId,
      messageId: message.id,
    });
  }
}

async function deliverMessageEvent(event) {
  if (config.useWebhook) await postMessageEvent(event, config, logger);
  if (config.useSql) await postMessageEventToSql(event, config, logger);
}

async function deliverAction(action, meta) {
  if (config.useWebhook) await postAction(action, meta, config, logger);
  if (config.useSql) await postActionToSql(action, meta, config, logger);
}

async function processOrderOcr(event) {
  const imageUrls = event.sheetAction?.data?.imageUrls || [];
  const meta = { messageUrl: event.messageUrl, channel: event.channel };

  for (const url of imageUrls) {
    try {
      const { isOrder, actions } = await recognizeOrder(url, {
        apiKey: config.ocrApiKey,
        model: config.ocrModel,
        baseUrl: config.ocrBaseUrl,
        httpTimeoutMs: config.httpTimeoutMs,
      });
      if (!isOrder) {
        logger.info("OCR: документ не кадровый приказ, пропуск", { messageId: event.messageId });
        continue;
      }
      const sheetActions = orderActionsToSheetActions(actions);
      for (const action of sheetActions) {
        await deliverAction(action, meta);
      }
      logger.info("OCR: приказ обработан", { messageId: event.messageId, actions: sheetActions.length });
    } catch (error) {
      logger.error("OCR: ошибка распознавания приказа", { error: error.message, messageId: event.messageId });
    }
  }
}

// Новые сообщения. Каналы с trigger="reaction" здесь пропускаем — их ждём по реакции.
client.on(Events.MessageCreate, async (message) => {
  if (!config.channelIds.has(message.channelId)) return;
  // Игнорируем только САМИХ СЕБЯ. Сообщения RMRP Forms (дела/статусы) — нужны.
  if (message.author?.id === client.user?.id) return;

  const rule = getChannelRule(message.channelId);
  if (rule.trigger === "reaction") return;

  await processMessage(message, "create");
});

// Реакции. Обрабатываем только каналы с trigger="reaction" и нужным эмодзи (✅).
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (config.ignoreBots && user?.bot) return;

    // Реакция/сообщение могут быть partial (старое сообщение) — дотягиваем.
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    // ✅ под опубликованным делом в «дела-ск» → архивация (отдельная ветка).
    await handleArchiveReaction(reaction, user, config, logger);
    // ✅ под отчётом ПГСкО → зачёт отчёта в таблице.
    await handlePgSkOReaction(reaction, user, config, logger);

    if (!config.channelIds.has(message.channelId)) return;

    const rule = getChannelRule(message.channelId);
    if (rule.trigger !== "reaction") return;

    const emojiName = reaction.emoji?.name ?? "";
    if (rule.approveEmoji && emojiName !== rule.approveEmoji) return;

    if (config.ignoreBots && message.author?.bot) return;

    await processMessage(message, `reaction:${emojiName}`);
  } catch (error) {
    logger.error("Failed to process reaction", { error: error.message });
  }
});

// Редактирования. Канал состава — это одно редактируемое сообщение, поэтому
// его правки тоже нужно ловить и переотправлять список (upsert).
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (!config.channelIds.has(message.channelId)) return;
    if (message.author?.id === client.user?.id) return;

    const rule = getChannelRule(message.channelId);
    if (rule.key !== "staff") return; // правки обрабатываем только для состава

    await processMessage(message, "update");
  } catch (error) {
    logger.error("Failed to process update", { error: error.message });
  }
});

client.on(Events.Error, (error) => {
  logger.error("Discord client error", { error: error.message });
});

function shutdown(signal) {
  logger.info("Shutting down", { signal });
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", { error: error?.message ?? String(error) });
});

// Транзиентные сетевые ошибки (ETIMEDOUT/ECONNRESET от Discord Gateway) не должны
// ронять процесс — discord.js сам переподключается. Логируем и продолжаем работу.
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception (продолжаем работу)", {
    error: error?.message ?? String(error),
    code: error?.code,
  });
});

await client.login(config.token);
