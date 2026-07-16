/**
 * Еженедельный отчёт о работе управления — embed для канала отчётов.
 * Данные собирает Apps Script (collectWeeklyReport_) и присылает в задании type="report".
 */

import { REPORT_COLOR, COAT_OF_ARMS_URL, embedFooterForUnit } from "./publishConfig.js";

// «Фамилия Имя Отчество» -> «Фамилия И.О.»
function shortName(fio) {
  const parts = String(fio || "").trim().split(/\s+/);
  if (parts.length >= 3) return `${parts[0]} ${parts[1][0]}.${parts[2][0]}.`;
  if (parts.length === 2) return `${parts[0]} ${parts[1][0]}.`;
  return fio || "";
}

function listOrDash(arr, mapFn) {
  if (!arr || arr.length === 0) return "—";
  return arr.map(mapFn).join("\n");
}

export function buildReportMessage(job) {
  const c = job.cases || {};
  const s = job.staff || {};
  const d = job.discipline || {};
  const p = job.pgsko || {};

  const fields = [
    {
      name: "📁 Дела за неделю",
      value:
        `Возбуждено: **${c.opened || 0}**\n` +
        `Передано в прокуратуру: **${c.transferred || 0}**\n` +
        `Отказов: **${c.refused || 0}**\n` +
        `Прекращено: **${c.terminated || 0}**\n` +
        `В работе сейчас: **${c.inWork || 0}** (просрочено: ${c.overdue || 0})`,
      inline: false,
    },
    {
      name: "🏆 Топ следователей за неделю",
      value: listOrDash((job.top || []).slice(0, 5), (t, i) => `${i + 1}. ${shortName(t[0])} — ${t[1]}`),
      inline: false,
    },
    {
      name: "👥 Состав",
      value:
        `Всего: **${s.total || 0}**\n` +
        `Аппарат: ${s.apparat || 0} · СО: ${s.so || 0} · ОПП: ${s.opp || 0}\n` +
        `В отпуске: ${s.vacation || 0} · Доступны: ${s.available || 0}`,
      inline: true,
    },
    {
      name: "📊 Сводка (на момент)",
      value:
        `В архиве дел: **${job.archiveTotal || 0}**\n` +
        `В работе: ${c.inWork || 0} · Просрочено: ${c.overdue || 0}\n` +
        `Горящие сроки: ${c.burning || 0}`,
      inline: true,
    },
    {
      name: "⬆️ Кадры за неделю",
      value:
        `Повышения: ${listOrDash(job.promotions || [], (p) => `${shortName(p[0])} → ${p[1]}`)}\n` +
        `Назначено: ${job.appointments || 0} · Уволено: ${job.dismissals || 0}`,
      inline: false,
    },
    {
      name: "⚠️ Дисциплина за неделю",
      value:
        `Выдано: +${d.weekW || 0} предупр., +${d.weekR || 0} выговоров\n` +
        `Всего сейчас: ${d.totalW || 0} предупр. / ${d.totalR || 0} выговоров`,
      inline: false,
    },
    {
      name: "🧾 ПГСкО",
      value:
        `Отправлено за неделю: **${p.submittedWeek || 0}**\n` +
        `Зачтено за неделю: **${p.approvedWeek || 0}**\n` +
        `Ожидают проверки: **${p.pending || 0}**\n` +
        `Топ: ${listOrDash((p.top || []).slice(0, 5), (t, i) => `${i + 1}. ${shortName(t[0])} — ${t[1]}`)}`,
      inline: false,
    },
    {
      name: "✅ Готовы к повышению",
      value: listOrDash(job.ready || [], (f) => `• ${shortName(f)}`),
      inline: false,
    },
  ];

  const embed = {
    color: REPORT_COLOR,
    title: "📊 Еженедельный отчёт — ГСУ СК России по АФО",
    description: `Период: **${job.period || ""}**`,
    thumbnail: { url: COAT_OF_ARMS_URL },
    fields,
    footer: { text: embedFooterForUnit(job.unit), icon_url: COAT_OF_ARMS_URL },
    timestamp: new Date().toISOString(),
  };

  return { embeds: [embed], allowedMentions: { parse: [] } };
}
