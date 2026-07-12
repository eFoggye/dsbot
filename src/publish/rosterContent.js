/**
 * Сборка embed-сообщений состава для канала «состав-ск».
 *
 * Формат повторяет текущую публикацию состава: разделы, строки
 * «роль должности - сотрудник [погоны]», вакансии там, где они нужны.
 */

import {
  COAT_OF_ARMS_URL,
  EMBED_FOOTER,
  RANK_EMOJI,
  ROSTER_COLOR,
  ROSTER_SECTIONS,
  POSITION_ROLE_IDS,
  positionEmoji,
} from "./publishConfig.js";

function escapeMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|])/g, "\\$1");
}

function resolveMention(guild, fio) {
  if (!guild) return escapeMarkdown(fio);
  const member = guild.members.cache.find(
    (m) => (m.displayName || m.user.globalName || m.user.username) === fio,
  );
  return member ? `<@${member.id}>` : escapeMarkdown(fio);
}

function positionLabel(position) {
  const roleId = POSITION_ROLE_IDS[position];
  if (roleId) return `<@&${roleId}>`;
  return `${positionEmoji(position)} ${escapeMarkdown(position || "Неизвестная роль")}`.trim();
}

function rankBrackets(rank) {
  const normalized = String(rank || "")
    .replace(/\s+юстиции\s*$/iu, "")
    .trim();
  const label = RANK_EMOJI[normalized] || escapeMarkdown(rank || "—");
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

function personLine(guild, person, bullet = "") {
  const rank = rankBrackets(person.rank);
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
    `${bullet}${positionLabel(person.position)} - ${resolveMention(guild, person.fio)}${rank ? ` ${rank}` : ""}`,
    details.join(" | "),
  ].join("\n");
}

function vacancyLine(position, bullet = "") {
  return `${bullet}${positionLabel(position)} - *Вакантно*`;
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

function descriptionForSection(section, people, guild) {
  const sorted = [...people].sort(bySectionPosition(section));
  const lines = [];
  const used = new Set();

  for (const position of section.positions) {
    const byPosition = sorted.filter((person) => person.position === position);
    if (byPosition.length) {
      byPosition.forEach((person) => {
        lines.push(personLine(guild, person, section.bullet || ""));
        used.add(person);
      });
    } else if (section.showVacancies) {
      lines.push(vacancyLine(position, section.bullet || ""));
    }
  }

  for (const person of sorted) {
    if (!used.has(person)) lines.push(personLine(guild, person, section.bullet || ""));
  }

  return lines.length ? lines.join("\n") : "*Вакантно*";
}

function buildEmbed(section, people, guild, index, total) {
  const embed = {
    color: section.color ?? ROSTER_COLOR,
    title: `${section.icon} | ${section.title}:`,
    description: descriptionForSection(section, people, guild),
  };

  if (index === 0) embed.thumbnail = { url: COAT_OF_ARMS_URL };
  if (index === total - 1) {
    embed.footer = { text: EMBED_FOOTER, icon_url: COAT_OF_ARMS_URL };
    embed.timestamp = new Date().toISOString();
  }

  return embed;
}

/**
 * @param roster — массив { fio, rank, position, department, group, status }
 * @param guild  — Discord Guild (для резолва ников); может быть null (тогда ФИО текстом)
 * @returns массив payload-объектов для channel.send / message.edit
 */
export function buildRosterMessages(roster, guild) {
  const active = (roster || []).filter((p) => p.fio && p.status !== "Уволен");
  return ROSTER_SECTIONS.map((section, index) => ({
    embeds: [buildEmbed(section, sectionPeople(active, section), guild, index, ROSTER_SECTIONS.length)],
    allowedMentions: { parse: [] },
  }));
}
