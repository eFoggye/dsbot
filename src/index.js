import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import { loadConfig } from "./config.js";
import { getChannelRule } from "./channelRules.js";
import { createLogger } from "./logger.js";
import { normalizeMessage } from "./messageNormalizer.js";
import { saveMessageToFiles } from "./sinks/fileSink.js";
import { postMessageEventToApi, postActionToApi, startApiRetryLoop } from "./sinks/botApiSink.js";
import { recognizeOrder, orderActionsToSheetActions } from "./ocr/orderOcr.js";
import { startPublisher, handleArchiveReaction, handlePgSkOReaction } from "./publish/publisher.js";

const config = loadConfig({ requireRuntime: true });
const logger = createLogger(config.logLevel);

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMessageReactions,
];

if (config.enableGuildMembersIntent) {
  intents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({
  intents,
  // partials нужны, чтобы ловить реакции и на сообщения, которых нет в кеше (старые).
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info("Discord listener started", {
    botUser: readyClient.user.tag,
    botUserId: readyClient.user.id,
    channels: Array.from(config.channelIds),
    outputDir: config.outputDir,
    apiEnabled: config.useApi,
    storage: config.storage,
    guildMembersIntent: config.enableGuildMembersIntent,
    ignoreBots: config.ignoreBots,
  });
  // Реверс-публикации (таблица → Discord): опрос очереди заданий.
  startPublisher(readyClient, config, logger);
  // Досылка событий, не доехавших до API (retry-queue.ndjson).
  startApiRetryLoop(config, logger);
});

// Все обрабатываемые сообщения учитываем, чтобы при SIGTERM дождаться их
// завершения (graceful drain) и не потерять полузаписанные события.
let shuttingDown = false;
const inFlight = new Set();

function processMessageTracked(message, source) {
  const task = processMessage(message, source);
  inFlight.add(task);
  task.finally(() => inFlight.delete(task));
  return task;
}

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

// Канал состава пишет прямо в таблицу сотрудников, поэтому для него можно задать
// allowlist авторов (STAFF_ALLOWED_AUTHOR_IDS). Пусто = полагаемся на права канала.
function staffAuthorAllowed(message) {
  if (config.staffAllowedAuthorIds.size === 0) return true;
  return config.staffAllowedAuthorIds.has(message.author?.id ?? "");
}

async function deliverMessageEvent(event) {
  if (config.useApi) await postMessageEventToApi(event, config, logger);
}

async function deliverAction(action, meta) {
  if (config.useApi) await postActionToApi(action, meta, config, logger);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processOrderOcr(event) {
  const imageUrls = event.sheetAction?.data?.imageUrls || [];
  const meta = { messageUrl: event.messageUrl, channel: event.channel };

  let first = true;
  for (const url of imageUrls) {
    // Пауза между OCR-запросами: не долбим API распознавания пачкой картинок разом.
    if (!first) await sleep(1000);
    first = false;
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
  if (shuttingDown) return;
  if (!config.channelIds.has(message.channelId)) return;
  // Игнорируем только САМИХ СЕБЯ. Сообщения RMRP Forms (дела/статусы) — нужны.
  if (message.author?.id === client.user?.id) return;

  const rule = getChannelRule(message.channelId);
  if (rule.trigger === "reaction") return;

  if (rule.key === "staff" && !staffAuthorAllowed(message)) {
    logger.warn("Сообщение состава от автора вне allowlist — пропуск", {
      messageId: message.id,
      authorId: message.author?.id,
    });
    return;
  }

  await processMessageTracked(message, "create");
});

// Реакции. Обрабатываем только каналы с trigger="reaction" и нужным эмодзи (✅).
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (shuttingDown) return;
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

    // Одобрение реакцией — только от носителя роли (fail-closed):
    // без approverRoleId реакции в таком канале игнорируются, чтобы любой
    // участник не мог «одобрить» рапорт своим ✅.
    if (!rule.approverRoleId) {
      logger.warn("Реакция проигнорирована: не задана роль одобряющего (VACATION_APPROVER_ROLE_ID)", {
        channelId: message.channelId,
        messageId: message.id,
        userId: user.id,
      });
      return;
    }
    const approver = await message.guild?.members.fetch(user.id).catch(() => null);
    if (!approver || !approver.roles.cache.has(rule.approverRoleId)) return;

    await processMessageTracked(message, `reaction:${emojiName}`);
  } catch (error) {
    logger.error("Failed to process reaction", { error: error.message });
  }
});

// Редактирования. Канал состава — это одно редактируемое сообщение, поэтому
// его правки тоже нужно ловить и переотправлять список (upsert).
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    if (shuttingDown) return;
    const message = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (!config.channelIds.has(message.channelId)) return;
    if (message.author?.id === client.user?.id) return;

    const rule = getChannelRule(message.channelId);
    if (rule.key !== "staff") return; // правки обрабатываем только для состава

    if (!staffAuthorAllowed(message)) {
      logger.warn("Правка состава от автора вне allowlist — пропуск", {
        messageId: message.id,
        authorId: message.author?.id,
      });
      return;
    }

    await processMessageTracked(message, "update");
  } catch (error) {
    logger.error("Failed to process update", { error: error.message });
  }
});

client.on(Events.Error, (error) => {
  logger.error("Discord client error", { error: error.message });
});

// Graceful shutdown: отключаемся от Discord (новые события не приходят), затем
// ждём завершения уже обрабатываемых сообщений (запись в файлы + доставка в API),
// чтобы ничего не потерять. Максимум 10 секунд — потом выходим как есть
// (недоставленное в API уже лежит в retry-очереди и доедет после рестарта).
const SHUTDOWN_DRAIN_MS = 10_000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down", { signal, pendingMessages: inFlight.size });
  try {
    client.destroy();
    await Promise.race([
      Promise.allSettled(Array.from(inFlight)),
      sleep(SHUTDOWN_DRAIN_MS),
    ]);
  } catch (error) {
    logger.error("Ошибка при остановке", { error: error?.message ?? String(error) });
  }
  process.exit(0);
}

process.on("SIGINT", (signal) => {
  shutdown(signal);
});
process.on("SIGTERM", (signal) => {
  shutdown(signal);
});

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
