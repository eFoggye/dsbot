/**
 * Сборка сообщения состава для канала «состав-ск» (формат Вариант А — content).
 * Строка: «<значок роли> Должность — @ФИО <погоны>», группировка по отделам,
 * вакансии должностей Аппарата без людей = «Набор не ведётся».
 *
 * @плашки следователей бот резолвит по нику (displayName == ФИО). Кастомные эмодзи
 * и role ID должностей — из publishConfig (заполнить через `npm run discover`).
 */

import {
  ROSTER_SECTIONS, APPARAT_POSITIONS, RANK_EMOJI,
  POSITION_ROLE_IDS, positionEmoji,
} from "./publishConfig.js";

const DISCORD_LIMIT = 1900; // запас от лимита 2000

// Ищет участника по точному совпадению ника с ФИО. Требует загруженный members cache.
function resolveMention(guild, fio) {
  if (!guild) return fio;
  const member = guild.members.cache.find(
    (m) => (m.displayName || m.user.globalName || m.user.username) === fio,
  );
  return member ? `<@${member.id}>` : fio;
}

// «<значок> Должность» — упоминание роли должности, если известен её ID, иначе текст.
function positionLabel(position) {
  const emoji = positionEmoji(position);
  const roleId = POSITION_ROLE_IDS[position];
  if (roleId) return `<@&${roleId}>`; // у роли в названии обычно уже есть значок
  return `${emoji} ${position}`.trim();
}

function personLine(guild, person) {
  const rankEmoji = RANK_EMOJI[person.rank] || "";
  const mention = resolveMention(guild, person.fio);
  return `${positionLabel(person.position)} — ${mention}${rankEmoji ? " " + rankEmoji : ""}`;
}

/**
 * @param roster — массив { fio, rank, position, department, status }
 * @param guild  — Discord Guild (для резолва ников); может быть null (тогда ФИО текстом)
 * @returns массив строк-сообщений (по 1 на каждое; разбито под лимит Discord)
 */
export function buildRosterMessages(roster, guild) {
  const active = (roster || []).filter((p) => p.fio && p.status === "Активен");
  const blocks = [];

  for (const section of ROSTER_SECTIONS) {
    const people = active.filter((p) => p.department === section.department);
    const lines = [section.header];

    for (const p of people) lines.push(personLine(guild, p));

    // Вакансии Аппарата: должности из списка, которых нет ни у кого.
    if (section.department === ROSTER_SECTIONS[0].department) {
      const taken = new Set(people.map((p) => p.position));
      for (const pos of APPARAT_POSITIONS) {
        if (!taken.has(pos)) lines.push(`${positionEmoji(pos)} ${pos} — Набор не ведётся`);
      }
    }
    blocks.push(lines.join("\n"));
  }

  // Склеиваем блоки в сообщения, не превышая лимит Discord.
  const messages = [];
  let buf = "";
  for (const block of blocks) {
    if (buf && (buf.length + block.length + 2) > DISCORD_LIMIT) {
      messages.push(buf);
      buf = block;
    } else {
      buf = buf ? `${buf}\n\n${block}` : block;
    }
  }
  if (buf) messages.push(buf);
  return messages;
}
