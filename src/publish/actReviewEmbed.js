/**
 * Embed для канала «акты-и-делоодобрение».
 * Следователь подал акт по делу (возбуждение/приостановление/отказ/передача/прекращение)
 * со ссылкой на Google-документ. Это УВЕДОМЛЕНИЕ — само одобрение/отклонение
 * происходит в личном кабинете портала «Следак», после чего карточка обновляется.
 */

import { COAT_OF_ARMS_URL, EMBED_FOOTER, ACT_REVIEW_COLOR } from "./publishConfig.js";

function escapeMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|])/g, "\\$1");
}

function valueOrDash(value) {
  const text = String(value ?? "").trim();
  return text ? escapeMarkdown(text) : "—";
}

function docText(url) {
  const text = String(url ?? "").trim();
  if (!text) return "—";
  if (!/^https?:\/\//i.test(text)) return escapeMarkdown(text);
  return `[Открыть документ](${text})`;
}

const ACTION_LABELS = {
  "Возбуждение": "🟡 Возбуждение дела",
  "Возобновление": "🟢 Возобновление производства",
  "Приостановление": "🟠 Приостановление",
  "Отказ в ВУД": "🔴 Отказ в возбуждении",
  "Передача в прокуратуру": "🟢 Передача в прокуратуру",
  "Прекращение": "🔵 Прекращение",
};

function actionLabel(action) {
  return ACTION_LABELS[String(action || "").trim()] || valueOrDash(action);
}

export function buildActReviewMessage(job) {
  const actId = String(job.actId || "").trim();
  const embed = {
    color: ACT_REVIEW_COLOR,
    title: "📄 Акт по делу — на рассмотрение",
    description: "Решение принимается в личном кабинете портала «Следак» (раздел «Акты на одобрение»).",
    thumbnail: { url: COAT_OF_ARMS_URL },
    fields: [
      { name: "Следователь", value: valueOrDash(job.investigator), inline: true },
      { name: "Номер дела", value: valueOrDash(job.caseNumber), inline: true },
      { name: "Действие", value: actionLabel(job.action), inline: false },
      { name: "Документ", value: docText(job.docUrl), inline: false },
    ],
    footer: { text: `${EMBED_FOOTER}${actId ? ` | ${actId}` : ""}`, icon_url: COAT_OF_ARMS_URL },
    timestamp: job.submittedAt ? new Date(job.submittedAt).toISOString() : new Date().toISOString(),
  };
  if (job.comment) {
    embed.fields.push({ name: "Комментарий", value: valueOrDash(job.comment).slice(0, 1024), inline: false });
  }
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

/**
 * Перестроенный embed после решения по акту (одобрен/отклонён) — для редактирования
 * уже отправленного сообщения в «акты-и-делоодобрение».
 */
export function buildActDecisionEdit(job) {
  const approved = String(job.decision || "").toLowerCase().indexOf("одобр") === 0
    || String(job.decision || "").toLowerCase() === "approve"
    || String(job.status || "").toLowerCase().indexOf("одобр") === 0;
  const actId = String(job.actId || "").trim();
  const embed = {
    color: approved ? 0x43B581 : 0xE03B3B,
    title: approved ? "✅ Акт одобрен" : "❌ Акт отклонён",
    thumbnail: { url: COAT_OF_ARMS_URL },
    fields: [
      { name: "Следователь", value: valueOrDash(job.investigator), inline: true },
      { name: "Номер дела", value: valueOrDash(job.caseNumber), inline: true },
      { name: "Действие", value: actionLabel(job.action), inline: false },
      { name: "Документ", value: docText(job.docUrl), inline: false },
      { name: "Решение", value: `${approved ? "Одобрено" : "Отклонено"} — ${valueOrDash(job.decidedBy)}`, inline: false },
    ],
    footer: { text: `${EMBED_FOOTER}${actId ? ` | ${actId}` : ""}`, icon_url: COAT_OF_ARMS_URL },
    timestamp: new Date().toISOString(),
  };
  if (!approved && job.reason) {
    embed.fields.push({ name: "Причина", value: valueOrDash(job.reason).slice(0, 1024), inline: false });
  }
  return { embeds: [embed], allowedMentions: { parse: [] } };
}
