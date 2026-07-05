/**
 * HTTP-клиент к серверу портала «Следак». Бот НЕ ходит в БД напрямую — он шлёт
 * действия/события на эндпоинт /api/bot с токеном BOT_API_SECRET, а сервер сам
 * применяет их к Postgres. Так у бота (и у тех, кто его хостит) нет доступа к базе.
 */

import crypto from "node:crypto";

function signBody(secret, bodyText, timestamp, nonce) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${timestamp}.${nonce}.${bodyText}`)
    .digest("hex");
}

async function callBotApi(config, body) {
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
        authorization: `Bearer ${config.botApiSecret}`,
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

// Сырое сообщение Discord + распознанное действие (если есть) — на сервер одним запросом.
// rawSnapshot (полный слепок: роли, участники, аватарки) на сервер НЕ шлём — он там
// не используется, а лишние персональные данные в БД ни к чему. Локально слепок
// пишется только при LOG_RAW_MESSAGES=true (см. fileSink).
export async function postMessageEventToApi(event, config, logger) {
  try {
    const { rawSnapshot, ...payload } = event || {};
    await callBotApi(config, { op: "message_event", event: payload });
  } catch (error) {
    logger.warn("API message delivery failed", { error: error.message, messageId: event.messageId });
  }
}

// Произвольное действие (распознанный sheetAction или подтверждение публикации).
export async function postActionToApi(action, meta, config, logger) {
  if (!action) return;
  try {
    await callBotApi(config, { op: "action", action, meta: meta || {} });
  } catch (error) {
    logger.warn("API delivery failed", { error: error.message, actionType: action.type });
  }
}

// Очередь заданий на публикацию в Discord: { ok, jobs, rosterMessageIds } либо null.
export async function fetchPublishQueueFromApi(config, logger) {
  try {
    return await callBotApi(config, { op: "queue" });
  } catch (error) {
    logger.warn("Не удалось получить очередь публикаций (API)", { error: error.message });
    return null;
  }
}
