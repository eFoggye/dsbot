/**
 * HTTP-клиент к серверу портала «Следак». Бот НЕ ходит в БД напрямую — он шлёт
 * действия/события на эндпоинт /api/bot, а сервер сам применяет их к Postgres.
 * Так у бота (и у тех, кто его хостит) нет доступа к базе.
 *
 * Аутентификация — ТОЛЬКО HMAC-подпись (x-sledak-signature поверх timestamp.nonce.body,
 * общий секрет BOT_API_SECRET). Сам секрет по сети не передаётся: Bearer-заголовок
 * убран, чтобы секрет не засветился в логах прокси/сервера.
 *
 * Надёжность доставки: события (message_event/action) ретраятся с экспоненциальным
 * бэкоффом, при окончательном сбое пишутся в retry-queue.ndjson и досылаются фоновым
 * циклом (startApiRetryLoop). Опрос очереди публикаций (op:queue) не ретраится —
 * publisher и так опрашивает её периодически.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const RETRY_QUEUE_FILE = "retry-queue.ndjson";
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000; // 1с → 2с между попытками
const FLUSH_BATCH_LIMIT = 8;   // за один проход шлём не больше — чтобы не превысить rate-limit API
const FLUSH_GAP_MS = 800;      // пауза между отправками внутри пачки
const STAFF_RETRY_MAX_AGE_MS = 10 * 60 * 1000;
const TERMINAL_API_CODES = new Set(["STALE_CLAIM", "OUTBOX_NOT_FOUND", "UNIT_MISMATCH"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BotApiError extends Error {
  constructor(message, { status = 0, code = "", terminal = false } = {}) {
    super(message);
    this.name = "BotApiError";
    this.status = status;
    this.code = code;
    this.terminal = terminal;
  }
}

function signBody(secret, bodyText, timestamp, nonce) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${timestamp}.${nonce}.${bodyText}`)
    .digest("hex");
}

async function callBotApiOnce(config, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(config.httpTimeoutMs || 7000, 10000));
  const bodyText = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(24).toString("hex");
  const signature = signBody(config.botApiSecret, bodyText, timestamp, nonce);
  try {
    const response = await fetch(config.botApiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sledak-timestamp": timestamp,
        "x-sledak-nonce": nonce,
        "x-sledak-signature": `sha256=${signature}`,
        // Ключи портала разделены по управлениям. ID берём из BOT_UNIT,
        // поэтому отдельный контейнер ЦА никогда не сможет читать очередь Арбата.
        "x-sledak-key-id": config.botUnit,
      },
      body: bodyText,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const code = String(data.code || "");
      throw new BotApiError(data.error || `bot API HTTP ${response.status}`, {
        status: response.status,
        code,
        terminal: TERMINAL_API_CODES.has(code),
      });
    }
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function callBotApi(config, body, { attempts = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await callBotApiOnce(config, body);
    } catch (error) {
      lastError = error;
      if (error?.terminal) throw error;
      if (attempt < attempts - 1) await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

// --- Дисковая retry-очередь ---------------------------------------------------
// Недоставленные события не теряем: пишем в logs/retry-queue.ndjson и досылаем
// фоновым циклом. Пока идёт flush, новые записи копятся в памяти, чтобы
// перезапись файла (после досылки) не затёрла их.

let flushing = false;
const pendingDuringFlush = [];

function retryQueuePath(config) {
  return path.join(config.outputDir, RETRY_QUEUE_FILE);
}

function retryDeadLetterPath(config) {
  return path.join(config.outputDir, "retry-dead-letter.ndjson");
}

function staleStaffRetry(entry, config, now = Date.now()) {
  const body = entry?.body;
  if (body?.op !== "message_event" || body?.event?.sheetAction?.type !== "upsert_staff_rows") return "";
  if (!config.staffImportEnabled) return "staff_import_disabled";
  const receivedAt = Date.parse(String(body.event.receivedAt || ""));
  const queuedAt = Number(entry.queuedAt || 0);
  const eventAt = Number.isFinite(receivedAt) ? receivedAt : queuedAt;
  if (!eventAt || now - eventAt > STAFF_RETRY_MAX_AGE_MS) return "stale_staff_import";
  return "";
}

async function appendQueueLines(config, lines) {
  if (!lines.length) return;
  await fs.mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(retryQueuePath(config), `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function enqueueRetry(config, logger, body) {
  const line = JSON.stringify({ queuedAt: Date.now(), body });
  try {
    if (flushing) {
      pendingDuringFlush.push(line);
      return;
    }
    await appendQueueLines(config, [line]);
  } catch (error) {
    logger.error("Не удалось записать событие в retry-очередь", { error: error.message });
  }
}

// Пробует дослать всё из очереди; недоставленное остаётся в файле.
export async function flushApiRetryQueue(config, logger) {
  if (flushing || !config.useApi) return { sent: 0, left: 0, dropped: 0, terminal: 0, failed: false };
  flushing = true;
  try {
    const file = retryQueuePath(config);
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return { sent: 0, left: 0, dropped: 0, terminal: 0, failed: false };

    const keep = [];
    const malformed = [];
    let sent = 0;
    let dropped = 0;
    let terminal = 0;
    let budget = FLUSH_BATCH_LIMIT;
    let stop = false; // API отвалился (напр. rate-limit) — прекращаем долбить в этом проходе
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        dropped += 1;
        malformed.push(JSON.stringify({ movedAt: Date.now(), reason: "invalid_json", raw: line }));
        continue;
      }
      if (!entry?.body) {
        dropped += 1;
        malformed.push(JSON.stringify({ movedAt: Date.now(), reason: "missing_body", entry }));
        continue;
      }
      const staleReason = staleStaffRetry(entry, config);
      if (staleReason) {
        dropped += 1;
        malformed.push(JSON.stringify({ movedAt: Date.now(), reason: staleReason, entry }));
        continue;
      }
      if (stop || budget <= 0) { // лимит пачки исчерпан или API упал — остальное на следующий цикл
        keep.push(line);
        continue;
      }
      try {
        await callBotApiOnce(config, entry.body);
        sent += 1;
        budget -= 1;
        if (budget > 0) await sleep(FLUSH_GAP_MS);
      } catch (error) {
        if (error?.terminal) {
          terminal += 1;
          budget -= 1;
          continue;
        }
        keep.push(line);
        stop = true; // первая же ошибка (обычно rate-limit) останавливает досылку — не усугубляем бан
      }
    }

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, keep.length ? `${keep.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    if (malformed.length) await fs.appendFile(retryDeadLetterPath(config), `${malformed.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    if (sent || dropped || terminal || keep.length) {
      logger.info("Retry-очередь API", { sent, left: keep.length, dropped, terminal });
    }
    return { sent, left: keep.length, dropped, terminal, failed: stop };
  } catch (error) {
    logger.warn("Ошибка обработки retry-очереди", { error: error.message });
    return { sent: 0, left: null, dropped: 0, terminal: 0, failed: true };
  } finally {
    flushing = false;
    const buffered = pendingDuringFlush.splice(0, pendingDuringFlush.length);
    if (buffered.length) {
      await appendQueueLines(config, buffered).catch((error) => {
        logger.error("Не удалось дописать retry-очередь после flush", { error: error.message });
      });
    }
  }
}

// Фоновая досылка: локально проверяется часто, но после недоступности API уходит
// в длинный backoff и не удерживает serverless-базу постоянно включённой.
export function startApiRetryLoop(config, logger, { flushImmediately = true } = {}) {
  if (!config.useApi) return null;
  let stopped = false;
  let timer = null;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const run = async () => {
    const result = await flushApiRetryQueue(config, logger);
    schedule(result?.failed ? config.apiRetryBackoffMs : config.apiRetryIntervalMs);
    return result;
  };
  schedule(flushImmediately ? 0 : config.apiRetryIntervalMs);
  return {
    stop() { stopped = true; clearTimeout(timer); },
    flush() { return flushApiRetryQueue(config, logger); },
  };
}

// Сырое сообщение Discord + распознанное действие (если есть) — на сервер одним запросом.
// rawSnapshot (полный слепок: роли, участники, аватарки) на сервер НЕ шлём — он там
// не используется, а лишние персональные данные в БД ни к чему. Локально слепок
// пишется только при LOG_RAW_MESSAGES=true (см. fileSink).
export async function postMessageEventToApi(event, config, logger) {
  const { rawSnapshot, ...payload } = event || {};
  const body = { op: "message_event", event: { ...payload, botUnit: config.botUnit || "" } };
  try {
    await callBotApi(config, body, { attempts: RETRY_ATTEMPTS });
  } catch (error) {
    logger.warn("API message delivery failed — событие в retry-очередь", {
      error: error.message,
      messageId: event.messageId,
    });
    await enqueueRetry(config, logger, body);
  }
}

// Произвольное действие (распознанный sheetAction или подтверждение публикации).
export async function postActionToApi(action, meta, config, logger) {
  if (!action) return { delivered: true, queued: false };
  const body = { op: "action", action, meta: meta || {} };
  try {
    await callBotApi(config, body, { attempts: RETRY_ATTEMPTS });
    return { delivered: true, queued: false };
  } catch (error) {
    if (error?.terminal) {
      logger.info("API отклонил устаревшее действие — повтор не нужен", {
        actionType: action.type,
        code: error.code,
      });
      return { delivered: false, queued: false, terminal: true };
    }
    logger.warn("API delivery failed — действие в retry-очередь", {
      error: error.message,
      actionType: action.type,
    });
    await enqueueRetry(config, logger, body);
    return { delivered: false, queued: true };
  }
}

export async function postPublicationFailureToApi(job, error, config, logger) {
  return postActionToApi({
    type: "publication_failed",
    queueId: String(job?.id || ""),
    claimToken: String(job?.claimToken || ""),
    unit: String(job?.unit || config.botUnit || ""),
    error: String(error?.message || error || "Discord publication failed").slice(0, 1000),
    errorCode: String(error?.code || error?.name || "DISCORD_ERROR").slice(0, 80),
  }, {}, config, logger);
}

// Очередь заданий на публикацию в Discord: { ok, jobs, rosterMessageIds } либо null.
// unit — управление этого бота (env BOT_UNIT); сервер по нему отдаёт задания строго
// своего управления. Без ретраев: это периодический опрос, publisher повторит сам.
export async function fetchPublishQueueFromApi(config, logger, unit) {
  try {
    return await callBotApi(config, {
      op: "queue",
      unit: String(unit || ""),
      protocolVersion: 2,
      appRelease: String(config.appRelease || ""),
    });
  } catch (error) {
    logger.warn("Не удалось получить очередь публикаций (API)", { error: error.message });
    return null;
  }
}
