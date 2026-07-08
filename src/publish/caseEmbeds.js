/**
 * Шаблоны embed для канала «дела-ск».
 * Статусы в таблице совпадают с процессуальной логикой: назначение не публикуется.
 */

import {
  CASE_COLORS, COAT_OF_ARMS_URL, EMBED_FOOTER,
  PROSECUTOR_ROLE_ID, PROSECUTOR_ROLE_NAME,
} from "./publishConfig.js";

const BODIES = {
  "Возбуждено":
    "Следственный комитет Российской Федерации информирует органы прокуратуры о том, " +
    "что по результатам рассмотрения имеющихся в распоряжении материалов принято решение " +
    "о возбуждении уголовного дела.\n\n" +
    "Данное решение вынесено в установленном законом порядке, с соблюдением требований " +
    "действующего законодательства и в целях проведения дальнейших процессуальных действий, " +
    "направленных на установление обстоятельств произошедшего и лиц, подлежащих привлечению " +
    "к ответственности.\n\n" +
    "Сообщается для сведения и организации последующего надзора.",
  "Передано в прокуратуру":
    "Уважаемые коллеги,\n" +
    "Следственный комитет Российской Федерации сообщает, что материалы уголовного дела " +
    "направлены в органы прокуратуры для дальнейшего рассмотрения и последующего направления в суд.\n\n" +
    "Настоящее уведомление направляется для сведения и использования в установленном порядке.",
  "Отказано в возбуждении":
    "Уважаемые коллеги,\n" +
    "Следственный комитет Российской Федерации сообщает, что по результатам рассмотрения " +
    "поступивших материалов принято процессуальное решение об отказе в возбуждении уголовного дела.\n\n" +
    "Настоящее уведомление направляется в органы прокуратуры для сведения и обеспечения " +
    "установленного порядка прокурорского надзора.",
  "Прекращено":
    "Уважаемые коллеги,\n" +
    "Следственный комитет Российской Федерации сообщает, что вынесено постановление " +
    "о прекращении уголовного дела.\n\n" +
    "Настоящее уведомление направляется в органы прокуратуры для сведения и организации " +
    "надлежащего прокурорского надзора.",
};

const STATUS_ALIASES = {
  "Завершено": "Передано в прокуратуру",
  "Отказано": "Отказано в возбуждении",
  // Новый статус таблицы «В производстве» — это уведомление о возбуждении дела.
  "В производстве": "Возбуждено",
};

function canonicalStatus(status) {
  return STATUS_ALIASES[status] || status;
}

function title(status, caseNumber, fio) {
  switch (status) {
    case "Возбуждено":
      return `Сотрудник следственного комитета ${fio} возбудил уголовное дело № ${caseNumber}`;
    case "Передано в прокуратуру":
      return `Следственный комитет сообщает об окончании ведении следствия по делу №${caseNumber} и передаче его в прокуратуру.`;
    case "Отказано в возбуждении":
      return `Следственный комитет Российской Федерации отказывает в возбуждении уголовного дела №№ ${caseNumber}.`;
    case "Прекращено":
      return `Следствие по уголовному делу №${caseNumber} прекращено.`;
    default:
      return `Уведомление по делу №${caseNumber}`;
  }
}

export const PUBLISHABLE_STATUSES = Object.keys(BODIES);

// Только http(s)-ссылки: валидный embed.url делает заголовок кликабельным,
// а мусорную строку Discord отклонил бы (400) — поэтому фильтруем.
function safeHttpUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try { new URL(s); return s; } catch { return ""; }
}

/**
 * Собирает сообщение для дела.
 * @returns { content, embeds, allowedMentions } для channel.send / message.edit
 */
export function buildCaseMessage({ status, caseNumber, investigator, docUrl }) {
  const normalizedStatus = canonicalStatus(status);
  const body = BODIES[normalizedStatus];
  if (!body) return null;

  const roleMention = PROSECUTOR_ROLE_ID ? `<@&${PROSECUTOR_ROLE_ID}>` : PROSECUTOR_ROLE_NAME;
  const description = `${body}\n\n**С уважением,** ${investigator || ""}`.trim();

  const embed = {
    color: CASE_COLORS[normalizedStatus] ?? 0x2b2d31,
    title: title(normalizedStatus, caseNumber, investigator),
    description,
    thumbnail: { url: COAT_OF_ARMS_URL },
    footer: { text: EMBED_FOOTER, icon_url: COAT_OF_ARMS_URL },
    timestamp: new Date().toISOString(),
  };

  // Ссылка на материалы дела → заголовок embed становится кликабельным (как в уведомлениях RMRP Forms).
  const link = safeHttpUrl(docUrl);
  if (link) embed.url = link;

  return {
    content: `Уведомление для ${roleMention}`,
    embeds: [embed],
    allowedMentions: PROSECUTOR_ROLE_ID ? { roles: [PROSECUTOR_ROLE_ID] } : { parse: ["roles"] },
  };
}
