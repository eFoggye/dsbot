import { buildUnparsedAction, extractAllDates, extractNameAfter, getCreatedDate, getMessageText, normalizePersonName } from "./helpers.js";

function extractEmployeeName(text) {
  return (
    // Основной формат рапорта: "...в звании ..., Фамилия Имя Отчество, прошу предоставить..."
    extractNameAfter(text, /,\s*(?<name>[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}),?\s*прош[уе]/u) ||
    extractNameAfter(text, /(?:Отпуск|Рапорт|Заявитель|Сотрудник|ФИО)\s*:?\s*@?(?<name>[А-ЯЁA-Z][^\n,.;]+)/iu) ||
    normalizePersonName(text.match(/@([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\s-]{5,})/u)?.[1] ?? "")
  );
}

function detectVacationStatus(text) {
  if (/вернул[а-я]*\s+из\s+отпуска|вышел\s+из\s+отпуска|окончан/iu.test(text)) {
    return "Активен";
  }
  if (/отпуск/iu.test(text)) {
    return "Отпуск";
  }
  return "";
}

export function parseVacation(event) {
  const text = getMessageText(event);
  const employeeName = extractEmployeeName(text);
  const status = detectVacationStatus(text);
  const dates = extractAllDates(text);

  if (!employeeName || !status) {
    return buildUnparsedAction(event, "Не распознан сотрудник или статус отпуска. Нужны примеры формата из канала.");
  }

  return {
    type: "staff_status_event",
    targetSheet: "Состав",
    confidence: "medium",
    lookup: {
      employeeName,
    },
    updates: {
      "Статус": status,
      "Примечание": dates.length > 0 ? `Отпуск: ${dates.join(" - ")}` : `Обновлено по рапорту ${getCreatedDate(event)}`,
      "Ссылка": event.messageUrl,
    },
    data: {
      employeeName,
      status,
      dates,
      eventDate: getCreatedDate(event),
    },
  };
}
