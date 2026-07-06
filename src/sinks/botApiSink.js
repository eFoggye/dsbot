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
const RETRY_LOOP_INTERVAL_MS = 60_000;
const MAX_QUEUE_ENTRIES = 500; // защита от бесконечного роста файла
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000; // старше суток — не досылаем

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      },
      body: bodyText,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `bot API HTTP ${response.status}`);
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
  if (flushing || !config.useApi) return;
  flushing = true;
  try {
    const file = retryQueuePath(config);
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const keep = [];
    let sent = 0;
    let dropped = 0;
    for (const line of lines.slice(-MAX_QUEUE_ENTRIES)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        dropped += 1;
        continue;
      }
      if (!entry?.body || Date.now() - (entry.queuedAt || 0) > MAX_QUEUE_AGE_MS) {
        dropped += 1;
        continue;
      }
      try {
        await callBotApiOnce(config, entry.body);
        sent += 1;
      } catch {
        keep.push(line);
      }
    }

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, keep.length ? `${keep.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    if (sent || dropped || keep.length) {
      logger.info("Retry-очередь API", { sent, left: keep.length, dropped });
    }
  } catch (error) {
    logger.warn("Ошибка обработки retry-очереди", { error: error.message });
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

// Фоновая досылка: сразу при старте (добираем хвост прошлого запуска) и далее раз в минуту.
export function startApiRetryLoop(config, logger) {
  if (!config.useApi) return null;
  flushApiRetryQueue(config, logger);
  const timer = setInterval(() => {
    flushApiRetryQueue(config, logger);
  }, RETRY_LOOP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// Сырое сообщение Discord + распознанное действие (если есть) — на сервер одним запросом.
// rawSnapshot (полный слепок: роли, участники, аватарки) на сервер НЕ шлём — он там
// не используется, а лишние персональные данные в БД ни к чему. Локально слепок
// пишется только при LOG_RAW_MESSAGES=true (см. fileSink).
export async function postMessageEventToApi(event, config, logger) {
  const { rawSnapshot, ...payload } = event || {};
  const body = { op: "message_event", event: payload };
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
  if (!action) return;
  const body = { op: "action", action, meta: meta || {} };
  try {
    await callBotApi(config, body, { attempts: RETRY_ATTEMPTS });
  } catch (error) {
    logger.warn("API delivery failed — действие в retry-очередь", {
      error: error.message,
      actionType: action.type,
    });
    await enqueueRetry(config, logger, body);
  }
}

// Очередь заданий на публикацию в Discord: { ok, jobs, rosterMessageIds } либо null.
// Без ретраев: это периодический опрос, publisher повторит его сам.
export async function fetchPublishQueueFromApi(config, logger) {
  try {
    return await callBotApi(config, { op: "queue" });
  } catch (error) {
    logger.warn("Не удалось получить очередь публикаций (API)", { error: error.message });
    return null;
  }
}
