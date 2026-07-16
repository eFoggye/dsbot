/**
 * Embed для отчёта ПГСкО: сотрудник СК отправил форму,
 * руководство проверяет доказательство и ставит ✅ для зачёта.
 */

import { COAT_OF_ARMS_URL, PGSKO_COLOR, embedFooterForUnit } from "./publishConfig.js";

function escapeMarkdown(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|])/g, "\\$1");
}

function valueOrDash(value) {
  const text = String(value ?? "").trim();
  return text ? escapeMarkdown(text) : "—";
}

function proofText(url) {
  const text = String(url ?? "").trim();
  if (!text) return "—";
  if (!/^https?:\/\//i.test(text)) return escapeMarkdown(text);
  return `[Открыть доказательство](${text})`;
}

function imageUrl(url) {
  const text = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  if (/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(text)) return text;
  return "";
}

export function buildPgSkOMessage(job) {
  const proofUrl = String(job.proofUrl || job.proof || "").trim();
  const reportId = String(job.reportId || "").trim();

  const embed = {
    color: PGSKO_COLOR,
    title: "🧾 Отчёт ПГСкО на проверку",
    description: "Поставьте ✅ под этим сообщением, если привлечение засчитано.",
    thumbnail: { url: COAT_OF_ARMS_URL },
    fields: [
      {
        name: "Сотрудник СК",
        value: `${valueOrDash(job.investigatorName)}\nСтатик: **${valueOrDash(job.investigatorStatic)}**`,
        inline: true,
      },
      {
        name: "Привлечённый сотрудник",
        value: `${valueOrDash(job.targetName)}\nСтатик: **${valueOrDash(job.targetStatic)}**`,
        inline: true,
      },
      {
        name: "Доказательство",
        value: proofText(proofUrl),
        inline: false,
      },
    ],
    footer: { text: `${embedFooterForUnit(job.unit)}${reportId ? ` | ${reportId}` : ""}`, icon_url: COAT_OF_ARMS_URL },
    timestamp: job.submittedAt ? new Date(job.submittedAt).toISOString() : new Date().toISOString(),
  };

  // Скриншот-доказательство показываем маленькой миниатюрой справа (thumbnail),
  // а не большой картинкой внизу. Если доказательство — не картинка (внешняя
  // ссылка или пусто), в thumbnail остаётся герб, заданный выше.
  const image = imageUrl(proofUrl);
  if (image) embed.thumbnail = { url: image };
  if (job.comment) {
    embed.fields.push({ name: "Комментарий", value: valueOrDash(job.comment).slice(0, 1024), inline: false });
  }

  return { embeds: [embed], allowedMentions: { parse: [] } };
}
