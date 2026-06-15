import { CASE_NUMBER_PATTERN, DATE_PATTERN, normalizeDate } from "../messageParser.js";

export const caseSourceLabels = {
  "СК": "Следственный Комитет",
  "ОП": "Обращение в Прокуратуру",
  "ПП": "Постановление Прокуратуры",
  "ОПУ": "Обращение в Прокуратуру Устное",
  "СУД": "Суд",
  "ФСБ": "ФСБ",
  "ГП": "Генеральная прокуратура",
};

export const rankAliases = {
  mlt: "Младший лейтенант",
  lt: "Лейтенант",
  slt: "Старший лейтенант",
  kpt: "Капитан",
  maj: "Майор",
  pplk: "Подполковник",
  plk: "Полковник",
  gen_maj: "Генерал-майор",
  gen_lt: "Генерал-лейтенант",
  gen_plk: "Генерал-полковник",
};

export function getMessageText(event) {
  const parts = [event.cleanContent, event.content];
  // Бот-сообщения (например RMRP Forms) держат текст в embed — добавляем его.
  for (const embed of event.embeds || []) {
    parts.push(embed.title, embed.description);
    for (const field of embed.fields || []) {
      parts.push(field.name, field.value);
    }
  }
  return parts.filter(Boolean).join("\n");
}

export function getCreatedDate(event) {
  return event.createdAt ? event.createdAt.slice(0, 10) : "";
}

export function normalizePersonName(value = "") {
  return value
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/u, "")
    .trim();
}

export function extractCaseInfo(text) {
  const match = text.match(CASE_NUMBER_PATTERN);

  if (!match) {
    return {
      caseNumber: "",
      caseCode: "",
      sequenceNumber: "",
      source: "",
    };
  }

  return {
    caseNumber: match[0],
    caseCode: match[1],
    sequenceNumber: match[2],
    source: caseSourceLabels[match[1]] ?? "",
  };
}

export function extractAllDates(text) {
  return Array.from(text.matchAll(DATE_PATTERN), (match) => normalizeDate(match[1], match[2], match[3])).filter(Boolean);
}

export function extractDateTimeAfter(text, markerPattern) {
  const markerMatch = text.match(markerPattern);
  if (!markerMatch) {
    return null;
  }

  const afterMarker = text.slice(markerMatch.index + markerMatch[0].length);
  const dateTimeMatch = afterMarker.match(/\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\s+([0-2]?\d):([0-5]\d)\b/u);
  if (!dateTimeMatch) {
    return null;
  }

  const date = normalizeDate(dateTimeMatch[1], dateTimeMatch[2], dateTimeMatch[3]);
  if (!date) {
    return null;
  }

  return {
    date,
    time: `${dateTimeMatch[4].padStart(2, "0")}:${dateTimeMatch[5]}`,
    isoLike: `${date}T${dateTimeMatch[4].padStart(2, "0")}:${dateTimeMatch[5]}:00+03:00`,
  };
}

export function extractNameAfter(text, markerPattern) {
  const match = text.match(markerPattern);
  if (!match) {
    return "";
  }

  const rawName = match.groups?.name ?? match[1] ?? "";
  return normalizePersonName(rawName);
}

export function extractRespectfullyName(text) {
  return extractNameAfter(text, /С уважением,\s*(?<name>[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\s-]+)(?:\n|$)/u);
}

export function buildUnparsedAction(event, reason) {
  return {
    type: "raw_message",
    targetSheet: "Discord импорт",
    confidence: "low",
    reason,
    lookup: {},
    row: {
      "Дата": getCreatedDate(event),
      "Канал": event.channel.name,
      "Автор": event.member.displayName || event.author.globalName || event.author.username,
      "Текст": event.cleanContent || event.content,
      "Ссылка": event.messageUrl,
    },
    data: {},
  };
}
