// Ловит «02-ОП-4229» в т.ч. с приставкой «No»/«№»/«NoNo» (No02-ОП-4229).
// Без ведущего \b (он мешает после «No»); защита (?<!\d) от попадания в большое число.
const CASE_NUMBER_PATTERN = /(?<!\d)02-(СК|ОПУ|ОП|ПП|СУД|ФСБ|ГП)-(\d+)/u;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;
const USER_MENTION_PATTERN = /<@!?(\d+)>/gu;
const DATE_PATTERN = /\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\b/gu;

function normalizeDate(dayValue, monthValue, yearValue) {
  const day = Number.parseInt(dayValue, 10);
  const month = Number.parseInt(monthValue, 10);
  const year = yearValue.length === 2 ? Number.parseInt(`20${yearValue}`, 10) : Number.parseInt(yearValue, 10);

  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function getAllMatches(pattern, text, mapper) {
  return Array.from(text.matchAll(pattern), mapper);
}

export function parseMessageText(content = "") {
  const caseMatch = content.match(CASE_NUMBER_PATTERN);
  const dates = getAllMatches(DATE_PATTERN, content, (match) => normalizeDate(match[1], match[2], match[3])).filter(Boolean);

  return {
    caseNumber: caseMatch?.[0] ?? "",
    caseCode: caseMatch?.[1] ?? "",
    sequenceNumber: caseMatch?.[2] ?? "",
    urls: getAllMatches(URL_PATTERN, content, (match) => match[0]),
    mentionedUserIds: getAllMatches(USER_MENTION_PATTERN, content, (match) => match[1]),
    dates,
    firstDate: dates[0] ?? "",
  };
}

export { CASE_NUMBER_PATTERN, DATE_PATTERN, normalizeDate };
