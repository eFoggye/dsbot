import fs from "node:fs/promises";
import path from "node:path";

const csvHeaders = [
  "receivedAt",
  "createdAt",
  "guildId",
  "channelId",
  "messageId",
  "authorId",
  "authorUsername",
  "authorGlobalName",
  "memberDisplayName",
  "channelKey",
  "channelName",
  "actionType",
  "targetSheet",
  "confidence",
  "caseNumber",
  "caseCode",
  "sequenceNumber",
  "investigatorName",
  "deadlineAt",
  "status",
  "result",
  "firstDate",
  "content",
  "messageUrl",
  "attachmentUrls",
];

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsvRow(event) {
  const row = [
    event.receivedAt,
    event.createdAt,
    event.guildId,
    event.channelId,
    event.messageId,
    event.author.id,
    event.author.username,
    event.author.globalName,
    event.member.displayName,
    event.channel.key,
    event.channel.name,
    event.sheetAction?.type ?? "",
    event.sheetAction?.targetSheet ?? "",
    event.sheetAction?.confidence ?? "",
    event.parsed.caseNumber,
    event.parsed.caseCode,
    event.parsed.sequenceNumber,
    event.sheetAction?.data?.investigatorName ?? "",
    event.sheetAction?.data?.deadlineAt ?? "",
    event.sheetAction?.updates?.["Статус"] ?? event.sheetAction?.row?.["Статус"] ?? "",
    event.sheetAction?.updates?.["Результат / основание"] ?? event.sheetAction?.row?.["Результат / основание"] ?? "",
    event.parsed.firstDate,
    event.cleanContent || event.content,
    event.messageUrl,
    event.attachments.map((attachment) => attachment.url).join(" "),
  ];

  return row.map(escapeCsvValue).join(",");
}

async function ensureCsvHeader(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await appendPrivate(filePath, `${csvHeaders.join(",")}\n`);
  }
}

// Ротация по размеру: лог-файлы растут бесконечно (append-only), поэтому при
// превышении лимита текущий файл переименовывается в <имя>-<дата>.<ext>,
// а запись продолжается в свежий. CSV после ротации снова получит заголовок
// (ensureCsvHeader вызывается после rotateIfNeeded).
const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 МБ

async function rotateIfNeeded(filePath) {
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return; // файла ещё нет — ротировать нечего
  }
  if (size < MAX_LOG_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { dir, name, ext } = path.parse(filePath);
  await fs.rename(filePath, path.join(dir, `${name}-${stamp}${ext}`)).catch(() => {});
}

async function appendPrivate(filePath, text) {
  const handle = await fs.open(filePath, "a", 0o600);
  try {
    await handle.appendFile(text, "utf8");
    await handle.chmod(0o600).catch(() => {});
  } finally {
    await handle.close();
  }
}

function safeEventForLog(event, logRawMessages) {
  if (logRawMessages) return event;
  const { rawSnapshot, ...rest } = event;
  return rest;
}

export async function saveMessageToFiles(event, { outputDir, logRawMessages = false }) {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await fs.chmod(outputDir, 0o700).catch(() => {});

  const jsonlPath = path.join(outputDir, "messages.ndjson");
  const csvPath = path.join(outputDir, "messages.csv");
  const actionJsonlPath = path.join(outputDir, "sheet-actions.ndjson");
  const rawJsonlPath = path.join(outputDir, "raw-messages.ndjson");

  await rotateIfNeeded(jsonlPath);
  await appendPrivate(jsonlPath, `${JSON.stringify(safeEventForLog(event, logRawMessages))}\n`);
  if (logRawMessages) {
    await rotateIfNeeded(rawJsonlPath);
    await appendPrivate(rawJsonlPath, `${JSON.stringify(event.rawSnapshot ?? {})}\n`);
  }
  await rotateIfNeeded(csvPath);
  await ensureCsvHeader(csvPath);
  await appendPrivate(csvPath, `${toCsvRow(event)}\n`);
  await rotateIfNeeded(actionJsonlPath);
  await appendPrivate(
    actionJsonlPath,
    `${JSON.stringify({
      receivedAt: event.receivedAt,
      createdAt: event.createdAt,
      channelId: event.channelId,
      channel: event.channel,
      messageId: event.messageId,
      messageUrl: event.messageUrl,
      action: event.sheetAction,
    })}\n`,
  );

  return { jsonlPath, csvPath, actionJsonlPath, rawJsonlPath };
}
