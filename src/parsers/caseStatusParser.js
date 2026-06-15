import { buildUnparsedAction, extractCaseInfo, extractNameAfter, extractRespectfullyName, getCreatedDate, getMessageText } from "./helpers.js";

function detectCaseStatus(text) {
  if (/передач[еи]\s+его\s+в\s+прокуратуру|передаче\s+его\s+в\s+прокуратуру|направлены\s+в\s+органы\s+прокуратуры/iu.test(text)) {
    return {
      event: "transferred_to_prosecutor",
      status: "Передано в прокуратуру",
      result: "Передано в прокуратуру",
      archiveAfterUpdate: true,
    };
  }

  if (/отказывает\s+в\s+возбуждении|отказе\s+в\s+возбуждении/iu.test(text)) {
    return {
      event: "case_refused",
      status: "Отказано в возбуждении",
      result: "Отказ в ВУД",
      archiveAfterUpdate: true,
    };
  }

  if (/возбудил(?:а)?\s+уголовное\s+дело|возбуждении\s+уголовного\s+дела/iu.test(text)) {
    return {
      event: "case_opened",
      status: "Возбуждено",
      result: "",
      archiveAfterUpdate: false,
    };
  }

  if (/прекращено|прекращении\s+уголовного\s+дела/iu.test(text)) {
    return {
      event: "case_terminated",
      status: "Прекращено",
      result: "Прекращено",
      archiveAfterUpdate: true,
    };
  }

  if (/приостанов(?:ил|ила|лено|лении|ление)|приостанавливает/iu.test(text)) {
    return {
      event: "case_suspended",
      status: "Приостановлено",
      result: "Приостановлено",
      archiveAfterUpdate: false,
    };
  }

  return null;
}

function extractInvestigator(text) {
  return (
    extractRespectfullyName(text) ||
    extractNameAfter(text, /Сотрудник\s+следственного\s+комитета\s+(?<name>[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z\s-]+?)\s+возбудил/u)
  );
}

export function parseCaseStatus(event) {
  const text = getMessageText(event).replace(/№№/gu, "№");
  const caseInfo = extractCaseInfo(text);
  const statusInfo = detectCaseStatus(text);
  const investigatorName = extractInvestigator(text);

  if (!caseInfo.caseNumber || !statusInfo) {
    return buildUnparsedAction(event, "Не найден номер дела или статус публикации по делу.");
  }

  return {
    type: "case_status_event",
    targetSheet: "Дела в производстве",
    confidence: investigatorName ? "high" : "medium",
    lookup: {
      caseNumber: caseInfo.caseNumber,
    },
    updates: {
      "Статус": statusInfo.status,
      "Результат / основание": statusInfo.result,
      "Дата события": getCreatedDate(event),
      "Закрыл / изменил": investigatorName,
      "Ссылка на публикацию": event.messageUrl,
    },
    data: {
      event: statusInfo.event,
      caseNumber: caseInfo.caseNumber,
      caseCode: caseInfo.caseCode,
      sequenceNumber: caseInfo.sequenceNumber,
      investigatorName,
      eventDate: getCreatedDate(event),
      archiveAfterUpdate: statusInfo.archiveAfterUpdate,
    },
  };
}
