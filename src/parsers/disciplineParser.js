import { buildUnparsedAction, getCreatedDate } from "./helpers.js";

// Реальный формат канала «аудит-взысканий»:
//   1. <@кто_выдал>
//   2. <@на_кого>
//   3. Предупреждение 1/3
//   4. Выговор 1/3
//   5. Причина...
//   6. Отработка...
// Снятие взыскания — ответ «отработано»/«амнистировано»/«снято» на сообщение.

function userIdsInOrder(text) {
  return Array.from(text.matchAll(/<@!?(\d+)>/gu), (m) => m[1]);
}

function namesById(event) {
  const map = {};
  for (const u of event.mentions || []) {
    map[u.id] = u.displayName || u.globalName || u.username || "";
  }
  return map;
}

export function parseDiscipline(event) {
  const text = event.content || event.cleanContent || "";
  const byId = namesById(event);
  const ids = userIdsInOrder(text);

  // Первый упомянутый — кто выдал, второй — на кого. Если один — он и есть сотрудник.
  const issuerId = ids.length > 1 ? ids[0] : "";
  const targetId = ids.length > 1 ? ids[1] : ids[0];
  const employeeName = targetId ? byId[targetId] || "" : "";
  const issuerName = issuerId ? byId[issuerId] || "" : "";

  const warnMatch = text.match(/Предупреждение\s+(\d+)\s*\/\s*\d+/iu);
  const repMatch = text.match(/Выговор\s+(\d+)\s*\/\s*\d+/iu);
  const reason = (text.match(/^\s*5[.)]\s*(.+)$/mu)?.[1] || "").trim();
  const workoff = (text.match(/^\s*6[.)]\s*(.+)$/mu)?.[1] || "").trim();
  const removal = /отработан|амнистир|снят/iu.test(text);
  const lastType = repMatch ? "Выговор" : warnMatch ? "Предупреждение" : "";

  if (!employeeName) {
    return buildUnparsedAction(event, "Во взыскании не найден сотрудник (упоминание).");
  }

  const updates = { "Сотрудник": employeeName, "Дата выдачи": getCreatedDate(event) };
  if (warnMatch) updates["Предупреждения"] = Number(warnMatch[1]);
  if (repMatch) updates["Выговоры"] = Number(repMatch[1]);
  if (lastType) updates["Тип последнего взыскания"] = lastType;
  if (reason) updates["Причина"] = reason;
  if (issuerName) updates["Кто выдал"] = issuerName;
  if (workoff) {
    updates["Отработка"] = workoff;
    updates["Статус отработки"] = "Назначена";
  }
  if (removal) updates["Статус отработки"] = "Снято";

  return {
    type: "discipline_event",
    targetSheet: "Состав",
    confidence: warnMatch || repMatch ? "high" : "medium",
    lookup: { name: employeeName },
    updates,
    data: { employeeName, issuerName, removal },
  };
}
