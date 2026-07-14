/**
 * Уведомления о назначениях КСУ.
 *
 * Сообщение намеренно обычное (не embed): так его структура совпадает с
 * существующими задачами в канале, а Discord гарантированно подсвечивает
 * адресное упоминание ответственного сотрудника.
 */

function clean(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function discordId(value) {
  const id = clean(value);
  return /^\d{15,22}$/.test(id) ? id : "";
}

function mention(person) {
  const id = discordId(person?.discordId);
  return id ? `<@${id}>` : (clean(person?.fio) || "не указан");
}

function safeLink(label, url) {
  const value = clean(url);
  if (!/^https?:\/\//i.test(value)) return "";
  try {
    new URL(value);
    return `[${label}](${value})`;
  } catch {
    return "";
  }
}

function taskDetails(job) {
  const details = [
    job.caseNumber ? `Дело: **${clean(job.caseNumber)}**.` : "Номер дела уточняется.",
    job.server ? `Сервер: **${clean(job.server)}**.` : "",
    job.status ? `Статус: **${clean(job.status)}**.` : "",
    job.investigatorFio ? `Поднадзорный следователь: ${clean(job.investigatorFio)}.` : "",
  ].filter(Boolean).join(" ");
  const links = [safeLink("Материалы дела", job.caseDocUrl), safeLink("Рапорт", job.reportUrl)].filter(Boolean);
  return [details, links.length ? `Материалы: ${links.join(" · ")}.` : ""].filter(Boolean).join("\n");
}

/** @returns {{ content: string, allowedMentions: { parse: string[], users: string[] } }} */
export function buildKsoAssignmentMessage(job) {
  const assignee = mention(job.assignee);
  const assigneeId = discordId(job.assignee?.discordId);
  const previous = job.previous ? mention(job.previous) : "";
  const previousId = discordId(job.previous?.discordId);
  const isReassigned = job.kind === "reassigned";
  const pings = [previousId, assigneeId].filter(Boolean);

  const lines = isReassigned
    ? [
      pings.join(" "),
      "**👁️ КСУ · Переназначение контрольного производства**",
      "> Контрольное производство передано другому инспектору.",
      `> ${taskDetails(job).replace(/\n/g, "\n> ")}`,
      `**Прежний ответственный — ${previous}**`,
      `**Новый ответственный — ${assignee}**`,
    ]
    : [
      assigneeId ? `<@${assigneeId}>` : "",
      "**👁️ КСУ · Новое контрольное производство**",
      "> 1. Взять дело на контроль в реальном времени и следить за ходом следствия.",
      "> 2. Добавить КП в рабочую таблицу и фиксировать существенную информацию по делу.",
      `> ${taskDetails(job).replace(/\n/g, "\n> ")}`,
      `**Ответственный — ${assignee}**`,
    ];

  return {
    content: lines.filter(Boolean).join("\n"),
    // Не разрешаем @everyone/@here или роли: уведомляются только участники,
    // чьи ID портал явно передал в задании.
    allowedMentions: { parse: [], users: pings },
  };
}
