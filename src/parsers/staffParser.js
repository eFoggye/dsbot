import { buildUnparsedAction, rankAliases } from "./helpers.js";

// Реальный формат канала «состав-ск» (одно РЕДАКТИРУЕМОЕ сообщение):
//   ## <:эмодзи:> | Руководящий состав ГСУ СК России по АФО:
//   - <@&роль> - <@юзер> [<:звание:>]
//   ## ⭐ | Следственный отдел (СО):
//   > <@&роль> - <@юзер> [<:звание:>]
// Должность = имя упомянутой роли, сотрудник = имя упомянутого юзера, звание = эмодзи.

const DEPARTMENTS = [
  { re: /Руководящий состав/iu, dept: "Руководящий состав ГСУ СК России по АФО" },
  { re: /Следственный отдел|\(СО\)/iu, dept: "Следственный отдел (СО)" },
  { re: /ОСМИ|общественност|СМИ/iu, dept: "Отдел взаимодействия с общественностью и СМИ (ОСМИ)" },
  { re: /ОПП|профессиональн/iu, dept: "Отдел профессиональной подготовки (ОПП)" },
];

function detectDepartment(line, current) {
  for (const { re, dept } of DEPARTMENTS) {
    if (re.test(line)) return dept;
  }
  return current;
}

function detectSubDepartment(position) {
  if (/ОВД/iu.test(position)) return "Следователи по ОВД";
  if (/криминалист/iu.test(position)) return "Следователи-криминалисты";
  if (/следовател/iu.test(position)) return "Следователи";
  return "";
}

function rolesById(event) {
  const map = {};
  for (const r of event.roleMentions || []) map[r.id] = r.name || "";
  return map;
}

function usersById(event) {
  const map = {};
  for (const u of event.mentions || []) map[u.id] = u.displayName || u.globalName || u.username || "";
  return map;
}

export function parseStaff(event) {
  const text = event.content || event.cleanContent || "";
  const roleName = rolesById(event);
  const userName = usersById(event);

  let department = "";
  const rows = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^>+\s?/u, "").trim(); // убираем blockquote ">"
    if (!line) continue;

    // Заголовок секции отдела
    const isHeader = /^#{1,6}\s/u.test(rawLine.trim());
    if (isHeader || /:\s*$/u.test(line)) {
      department = detectDepartment(line, department);
      continue;
    }
    if (/Набор не ведется/iu.test(line)) continue;

    // <@&роль> - <@юзер> [<:звание:emojiId>]
    const m = line.match(/<@&(\d+)>\s*[-–—]\s*<@!?(\d+)>\s*\[\s*<:([A-Za-z_]+):/u);
    if (!m) continue;

    const position = roleName[m[1]] || "";
    const name = userName[m[2]] || "";
    const rank = rankAliases[m[3].toLowerCase()] || m[3];
    if (!name) continue;

    rows.push({
      "ФИО": name,
      "Звание": rank,
      "Должность": position,
      "Отдел": department,
      "Подотдел": department === "Следственный отдел (СО)" ? detectSubDepartment(position) : "",
      "Статус": "Активен",
    });
  }

  if (rows.length === 0) {
    return buildUnparsedAction(event, "Не найдено строк состава с упоминаниями ролей/сотрудников.");
  }

  return {
    type: "upsert_staff_rows",
    targetSheet: "Состав",
    confidence: "medium",
    lookup: {},
    rows,
    data: { rowsCount: rows.length },
  };
}
