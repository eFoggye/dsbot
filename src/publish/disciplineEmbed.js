/**
 * Embed для канала дисциплинарных взысканий.
 * Решение принимается в портале «Следак» (раздел «Состав» → карточка сотрудника).
 * Сюда прилетает уведомление о выданном/снятом взыскании в формате руководства.
 */

import { COAT_OF_ARMS_URL, EMBED_FOOTER } from "./publishConfig.js";

function escapeMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|])/g, "\\$1");
}

function valueOrDash(value) {
  const text = String(value ?? "").trim();
  return text ? escapeMarkdown(text) : "—";
}

// @упоминание, если есть Discord ID; иначе — ФИО.
function mention(discordId, fio) {
  const id = String(discordId || "").trim();
  if (id) return `<@${id}>`;
  return valueOrDash(fio);
}

const WARN_COLOR = 0xe67e22;   // предупреждение — оранжевый
const REP_COLOR = 0xd4111e;    // выговор — красный
const AMNESTY_COLOR = 0x2e8c58; // амнистия — зелёный

export function buildDisciplineMessage(job) {
  const amnesty = job.action === "amnesty";
  const disciplineType = job.disciplineType || job.type || "";
  const isWarn = String(disciplineType).trim() === "Предупреждение";
  const count = Number.isFinite(Number(job.count)) ? Number(job.count) : 0;

  const color = amnesty ? AMNESTY_COLOR : (isWarn ? WARN_COLOR : REP_COLOR);
  const title = amnesty
    ? "♻️ Снятие взыскания (амнистия)"
    : (isWarn ? "🟡 Дисциплинарное взыскание — Предупреждение" : "🔴 Дисциплинарное взыскание — Выговор");

  const fields = [
    { name: "Выдал", value: mention(job.issuerDiscord, job.issuerFio), inline: true },
    { name: "Сотрудник", value: mention(job.targetDiscord, job.fio), inline: true },
    { name: amnesty ? "Снято взыскание" : "Взыскание", value: `${valueOrDash(disciplineType)} ${count}/3`, inline: false },
    { name: "Причина", value: valueOrDash(job.reason).slice(0, 1024), inline: false },
  ];
  if (!amnesty) {
    fields.push({ name: "Отработка", value: valueOrDash(job.workoff || "На усмотрение руководства управления").slice(0, 1024), inline: false });
  }

  const embed = {
    color,
    title,
    description: amnesty
      ? "Взыскание снято руководством управления."
      : "Решение вынесено руководством управления через ГАС «Следак».",
    thumbnail: { url: COAT_OF_ARMS_URL },
    fields,
    footer: { text: EMBED_FOOTER, icon_url: COAT_OF_ARMS_URL },
    timestamp: new Date().toISOString(),
  };
  return { embeds: [embed], allowedMentions: { parse: ["users"] } };
}
