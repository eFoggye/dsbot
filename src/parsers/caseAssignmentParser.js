import {
  buildUnparsedAction,
  extractCaseInfo,
  extractDateTimeAfter,
  extractNameAfter,
  getCreatedDate,
  getMessageText,
} from "./helpers.js";

function extractInvestigator(text) {
  return (
    extractNameAfter(text, /На Вас назначено новое дело:\s*@?(?<name>[^\n]+)/u) ||
    extractNameAfter(text, /Следователю[^:]*:\s*@?(?<name>[^\n]+)/u)
  );
}

function extractProsecutor(text) {
  return extractNameAfter(text, /процессуальном руководстве прокурора\s*@?(?<name>[^\n.]+)/u);
}

export function parseCaseAssignment(event) {
  const text = getMessageText(event);
  const caseInfo = extractCaseInfo(text);
  const deadline = extractDateTimeAfter(text, /Срок проведения расследования[\s\S]*?до\s*/u);
  const investigatorName = extractInvestigator(text);
  const prosecutorName = extractProsecutor(text);

  if (!caseInfo.caseNumber || !investigatorName) {
    return buildUnparsedAction(event, "Не найден номер дела или следователь в распределении.");
  }

  return {
    type: "append_active_case",
    targetSheet: "Дела в производстве",
    confidence: deadline ? "high" : "medium",
    lookup: {
      caseNumber: caseInfo.caseNumber,
    },
    row: {
      "Дата поступления": getCreatedDate(event),
      "Код дела": caseInfo.caseCode,
      "Номер дела": caseInfo.caseNumber,
      "Источник": caseInfo.source,
      "Следователь": investigatorName,
      "Статус": "Назначено",
      "Срок (истечения)": deadline?.date ?? "",
      "Ссылка на материалы": event.messageUrl,
      "Результат / основание": "",
    },
    data: {
      investigatorName,
      prosecutorName,
      deadlineAt: deadline?.isoLike ?? "",
      deadlineDate: deadline?.date ?? "",
      deadlineTime: deadline?.time ?? "",
      sourceText: caseInfo.source,
    },
  };
}
