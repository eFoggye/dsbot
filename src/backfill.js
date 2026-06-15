/**
 * Первичная загрузка (backfill): один раз прочитать уже опубликованные сообщения
 * из канала и залить их в таблицу. Дальше бот сам ловит новые и изменения.
 *
 * Использование:
 *   npm run backfill              — только канал «состав-ск» (key=staff), безопасно (upsert по ФИО)
 *   npm run backfill -- <ID>      — конкретный канал по ID
 *
 * ВНИМАНИЕ: для «дел» и «взысканий» backfill всей истории создаст дубли/устаревшие
 * записи — поэтому по умолчанию обрабатывается ТОЛЬКО состав. Другие каналы —
 * только осознанно, по явному ID.
 */
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { channelRules } from "./channelRules.js";
import { normalizeMessage } from "./messageNormalizer.js";
import { saveMessageToFiles } from "./sinks/fileSink.js";
import { postMessageEvent } from "./sinks/httpSink.js";

const config = loadConfig({ requireRuntime: true });
const logger = createLogger(config.logLevel);

const FETCH_LIMIT = 100; // последние N сообщений канала

// Целевые каналы: явный ID из аргумента, иначе все каналы состава (key=staff).
const argChannelId = process.argv[2];
const targetChannelIds = argChannelId
  ? [argChannelId]
  : Object.keys(channelRules).filter((id) => channelRules[id].key === "staff");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, async (readyClient) => {
  logger.info("Backfill started", { botUser: readyClient.user.tag, channels: targetChannelIds });

  if (targetChannelIds.length === 0) {
    logger.warn("Нет целевых каналов. Укажи ID: npm run backfill -- <channelId>");
    client.destroy();
    process.exit(0);
  }

  let total = 0;
  for (const channelId of targetChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.messages?.fetch !== "function") {
        logger.warn("Канал недоступен или не текстовый", { channelId });
        continue;
      }
      const collected = await channel.messages.fetch({ limit: FETCH_LIMIT });
      // от старых к новым, чтобы порядок применения был хронологическим
      const messages = Array.from(collected.values()).reverse();

      for (const message of messages) {
        if (message.author?.id === readyClient.user.id) continue;
        const event = normalizeMessage(message);
        await saveMessageToFiles(event, config);
        await postMessageEvent(event, config, logger);
        total += 1;
        logger.info("Backfilled", {
          channel: event.channel.name,
          actionType: event.sheetAction?.type || undefined,
        });
      }
    } catch (error) {
      logger.error("Backfill channel failed", { error: error.message, channelId });
    }
  }

  logger.info("Backfill finished", { processed: total });
  client.destroy();
  process.exit(0);
});

client.on(Events.Error, (error) => logger.error("Discord client error", { error: error.message }));

await client.login(config.token);
