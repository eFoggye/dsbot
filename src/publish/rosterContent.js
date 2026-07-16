/**
 * Сборка embed-сообщений состава для канала «состав-ск».
 *
 * Формат повторяет текущую публикацию состава: разделы, строки
 * «роль должности - сотрудник [погоны]», вакансии там, где они нужны.
 */

import {
  COAT_OF_ARMS_URL,
  ROSTER_COLOR,
  ROSTER_SECTIONS,
  embedFooterForUnit,
  positionRoleIdsForUnit,
  rankEmojiMapForUnit,
  positionEmoji,
} from "./publishConfig.js";

export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;

function escapeMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|])/g, "\\$1");
}

function resolveMention(guild, person) {
  const id = String(person?.discordId || "").trim();
  // Discord identity comes only from the verified portal account. Display names
  // are mutable and non-unique, so they must never be used as an identity key.
  if (/^\d{15,22}$/.test(id)) return `<@${id}>`;
  return escapeMarkdown(person?.fio || "");
}

function positionLabel(position, unit) {
  const roleId = positionRoleIdsForUnit(unit)[position];
  if (roleId) return `<@&${roleId}>`;
  return `${positionEmoji(position)} ${escapeMarkdown(position || "Неизвестная роль")}`.trim();
}

function rankBrackets(rank, unit) {
  const normalized = String(rank || "")
    .replace(/\s+юстиции\s*$/iu, "")
    .trim();
  const label = rankEmojiMapForUnit(unit)[normalized] || escapeMarkdown(rank || "—");
  return `[ ${label} ]`;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatDate(value) {
  if (!value) return "—";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "—";
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) return escapeMarkdown(trimmed);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  }
  return escapeMarkdown(value);
}

function personLine(guild, person, bullet = "", unit = "arbat") {
  const rank = rankBrackets(person.rank, unit);
  const warnings = toNumber(person.warnings);
  const reprimands = toNumber(person.reprimands);
  const joinedAt = person.joinedAt || person.joinDate;
  const details = [
    `Предупреждения: ${warnings}/3`,
    `Выговоры: ${reprimands}/3`,
    `Дата вступления: ${formatDate(joinedAt)}`,
  ];
  if (person.status === "Отпуск") {
    const from = person.vacationFrom ? formatDate(person.vacationFrom) : "";
    const until = person.vacationUntil ? formatDate(person.vacationUntil) : "";
    details.push(from && until ? `Отпуск: ${from}–${until}` : (until ? `В отпуске до ${until}` : "В отпуске"));
  }
  return [
    `${bullet}${positionLabel(person.position, unit)} - ${resolveMention(guild, person)}${rank ? ` ${rank}` : ""}`,
    details.join(" | "),
  ].join("\n");
}

function vacancyLine(position, bullet = "", unit = "arbat") {
  return `${bullet}${positionLabel(position, unit)} - *Вакантно*`;
}

function isManagement(person) {
  return person.position === "Руководитель управления";
}

function sectionPeople(active, section) {
  switch (section.key) {
    case "management":
      return active.filter(isManagement);
    case "apparatus":
      return active.filter((p) =>
        p.department === "Аппарат руководителя ГСУ СК России" && !isManagement(p));
    case "investigation":
      return active.filter((p) => p.department === "Следственный отдел (СО)");
    case "training":
      return active.filter((p) => p.department === "Отдел профессиональной подготовки (ОПП)");
    default:
      return [];
  }
}

function bySectionPosition(section) {
  return (a, b) => {
    const ai = section.positions.indexOf(a.position);
    const bi = section.positions.indexOf(b.position);
    const ao = ai >= 0 ? ai : 999;
    const bo = bi >= 0 ? bi : 999;
    if (ao !== bo) return ao - bo;
    return String(a.fio).localeCompare(String(b.fio), "ru");
  };
}

function descriptionForSection(section, people, guild, unit) {
  const sorted = [...people].sort(bySectionPosition(section));
  const lines = [];
  const used = new Set();

  for (const position of section.positions) {
    const byPosition = sorted.filter((person) => person.position === position);
    if (byPosition.length) {
      byPosition.forEach((person) => {
        lines.push(personLine(guild, person, section.bullet || "", unit));
        used.add(person);
      });
    } else if (section.showVacancies) {
      lines.push(vacancyLine(position, section.bullet || "", unit));
    }
  }

  for (const person of sorted) {
    if (!used.has(person)) lines.push(personLine(guild, person, section.bullet || "", unit));
  }

  return lines.length ? lines.join("\n") : "*Вакантно*";
}

export function splitRosterDescription(description, limit = DISCORD_EMBED_DESCRIPTION_LIMIT) {
  const chunks = [];
  let current = "";
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const rawLine of String(description || "").split("\n")) {
    let line = rawLine;
    while (line.length > limit) {
      if (current) push();
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();
  return chunks.length ? chunks : ["*Вакантно*"];
}

/**
 * @param roster — массив { fio, rank, position, department, group, status }
 * @param guild  — Discord Guild (для резолва ников); может быть null (тогда ФИО текстом)
 * @returns массив payload-объектов для channel.send / message.edit
 */
export function buildRosterMessages(roster, guild, { unit = "arbat" } = {}) {
  const active = (roster || []).filter((p) => p.fio && p.status !== "Уволен");
  const payloads = [];
  for (const section of ROSTER_SECTIONS) {
    const baseTitle = `${section.icon} | ${section.title}:`;
    const chunks = splitRosterDescription(descriptionForSection(section, sectionPeople(active, section), guild, unit));
    chunks.forEach((description, chunkIndex) => {
      payloads.push({
        embeds: [{
          color: section.color ?? ROSTER_COLOR,
          title: chunks.length > 1 ? `${baseTitle} (${chunkIndex + 1}/${chunks.length})` : baseTitle,
          description,
        }],
        allowedMentions: { parse: [] },
      });
    });
  }
  if (payloads[0]) payloads[0].embeds[0].thumbnail = { url: COAT_OF_ARMS_URL };
  const last = payloads[payloads.length - 1]?.embeds?.[0];
  if (last) {
    last.footer = { text: embedFooterForUnit(unit), icon_url: COAT_OF_ARMS_URL };
    last.timestamp = new Date().toISOString();
  }
  return payloads;
}
