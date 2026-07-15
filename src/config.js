import "dotenv/config";
import path from "node:path";

import { defaultChannelIds } from "./channelRules.js";

const VALID_BOT_UNITS = new Set(["arbat", "rublevka", "patriki", "tverskoy", "kutuzovsky", "ca"]);

function readBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validateHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("URL must use http or https");
    }
    return url.toString();
  } catch (error) {
    throw new Error(`Invalid BOT_API_URL: ${error.message}`);
  }
}

function parseIdSet(rawValue, label) {
  if (!rawValue) {
    return new Set();
  }

  const ids = rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const invalidIds = ids.filter((id) => !/^\d+$/.test(id));
  if (invalidIds.length > 0) {
    throw new Error(`Invalid Discord id(s) in ${label}: ${invalidIds.join(", ")}`);
  }

  return new Set(ids);
}

export function parseChannelIds(rawValue) {
  return parseIdSet(rawValue, "DISCORD_CHANNEL_IDS");
}

export function loadConfig({ requireRuntime = true } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN?.trim() ?? "";
  const channelIds = parseChannelIds(process.env.DISCORD_CHANNEL_IDS);
  const effectiveChannelIds = channelIds.size > 0 ? channelIds : new Set(defaultChannelIds);
  const outputDir = path.resolve(process.cwd(), process.env.OUTPUT_DIR?.trim() || "logs");
  // Связь с сайтом — только по HTTP через /api/bot с токеном. Прямого доступа к БД у бота нет.
  const botApiUrl = validateHttpUrl(process.env.BOT_API_URL?.trim() ?? "");
  const botApiSecret = process.env.BOT_API_SECRET?.trim() ?? "";
  const botUnit = process.env.BOT_UNIT?.trim().toLowerCase() || "";
  const ocrEnabled = readBoolean(process.env.OCR_ENABLED, false);
  const ocrApiKey = (process.env.OCR_API_KEY || process.env.ANTHROPIC_API_KEY)?.trim() ?? "";

  const errors = [];
  if (requireRuntime && !token) {
    errors.push("DISCORD_BOT_TOKEN is required");
  }
  if (requireRuntime && !botApiUrl) {
    errors.push("BOT_API_URL is required (эндпоинт сайта, напр. https://sledak-rmrp.ru/api/bot)");
  }
  if (requireRuntime && !botApiSecret) {
    errors.push("BOT_API_SECRET is required (общий секрет с сайтом)");
  }
  if (requireRuntime && !botUnit) {
    errors.push("BOT_UNIT is required (arbat/rublevka/patriki/tverskoy/kutuzovsky/ca)");
  }
  if (botUnit && !VALID_BOT_UNITS.has(botUnit)) {
    errors.push(`Invalid BOT_UNIT: ${botUnit}`);
  }
  if (requireRuntime && ocrEnabled && !ocrApiKey) {
    errors.push("OCR_ENABLED=true requires OCR_API_KEY");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return {
    token,
    channelIds: effectiveChannelIds,
    outputDir,
    botApiUrl,
    botApiSecret,
    storage: "api",
    useApi: Boolean(botApiUrl && botApiSecret),
    // Управление этого бота. Обязательно на бою: без него события без номера дела
    // нельзя безопасно привязать к нужному управлению.
    botUnit,
    // OCR fail-closed: наличие ключа само по себе не включает распознавание.
    ocrEnabled,
    ocrApiKey,
    ocrBaseUrl: process.env.OCR_BASE_URL?.trim() || "https://api.aitunnel.ru/v1",
    ocrModel: process.env.OCR_MODEL?.trim() || "claude-haiku-4.5",
    // Allowlist авторов для канала состава: если задан, сообщения/правки состава
    // принимаются только от этих Discord ID. Пусто = полагаемся на права канала.
    staffAllowedAuthorIds: parseIdSet(process.env.STAFF_ALLOWED_AUTHOR_IDS, "STAFF_ALLOWED_AUTHOR_IDS"),
    enableGuildMembersIntent: readBoolean(process.env.DISCORD_ENABLE_GUILD_MEMBERS, false),
    ignoreBots: readBoolean(process.env.IGNORE_BOTS, true),
    logRawMessages: readBoolean(process.env.LOG_RAW_MESSAGES, false),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    httpTimeoutMs: readInteger(process.env.HTTP_TIMEOUT_MS, 7000),
  };
}
