/**
 * Отправка действий для таблицы в Apps Script Web App.
 *
 * Шлёт { action, meta } POST-запросом на OUTPUT_WEBHOOK_URL.
 * Секрет WEBHOOK_SECRET добавляется как query-параметр ?token=...,
 * Web App сверяет его со Script Property WEBHOOK_SECRET.
 */

function buildTargetUrl(webhookUrl, webhookSecret) {
  if (!webhookSecret) return webhookUrl;
  const url = new URL(webhookUrl);
  url.searchParams.set("token", webhookSecret);
  return url.toString();
}

// Отправляет одно произвольное действие (используется и для sheetAction, и для OCR-результатов).
export async function postAction(action, meta, { webhookUrl, webhookSecret, httpTimeoutMs }, logger) {
  if (!webhookUrl || !action) return;

  const targetUrl = buildTargetUrl(webhookUrl, webhookSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, meta: meta || {} }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  } catch (error) {
    logger.warn("Webhook delivery failed", {
      error: error.message,
      actionType: action.type,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Забирает очередь заданий на публикацию у Web App (GET ?token=...&mode=queue).
// Возвращает { jobs: [...], rosterMessageId } либо null при ошибке.
export async function fetchPublishQueue({ webhookUrl, webhookSecret, httpTimeoutMs }, logger) {
  if (!webhookUrl) return null;
  const url = new URL(buildTargetUrl(webhookUrl, webhookSecret));
  url.searchParams.set("mode", "queue");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
  try {
    const response = await fetch(url.toString(), { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data && data.ok !== false ? data : null;
  } catch (error) {
    logger.warn("Не удалось получить очередь публикаций", { error: error.message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Отправляет действие, распознанное из сообщения Discord.
export async function postMessageEvent(event, config, logger) {
  if (!event.sheetAction) return;
  const meta = {
    messageId: event.messageId,
    messageUrl: event.messageUrl,
    channelId: event.channelId,
    channel: event.channel,
    receivedAt: event.receivedAt,
    author: event.author,
  };
  return postAction(event.sheetAction, meta, config, logger);
}
