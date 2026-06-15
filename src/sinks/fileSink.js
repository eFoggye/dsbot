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
    await fs.appendFile(filePath, `${csvHeaders.join(",")}\n`, "utf8");
  }
}

export async function saveMessageToFiles(event, { outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });

  const jsonlPath = path.join(outputDir, "messages.ndjson");
  const csvPath = path.join(outputDir, "messages.csv");
  const actionJsonlPath = path.join(outputDir, "sheet-actions.ndjson");
  const rawJsonlPath = path.join(outputDir, "raw-messages.ndjson");

  await fs.appendFile(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
  await fs.appendFile(rawJsonlPath, `${JSON.stringify(event.rawSnapshot ?? {})}\n`, "utf8");
  await ensureCsvHeader(csvPath);
  await fs.appendFile(csvPath, `${toCsvRow(event)}\n`, "utf8");
  await fs.appendFile(
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
    "utf8",
  );

  return { jsonlPath, csvPath, actionJsonlPath, rawJsonlPath };
}
