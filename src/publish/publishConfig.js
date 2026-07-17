/**
 * Конфиг реверс-публикаций (таблица → Discord).
 *
 * ⚠️ ПЕРЕД БОЕМ заполнить реальные ID: запусти `npm run discover` (бот уже на сервере) —
 * он выведет ID кастомных эмодзи, ролей и проверит ники. Затем впиши значения сюда
 * (или в .env — см. ниже).
 */

import { channelRules } from "../channelRules.js";

// --- Каналы (ID берём из channelRules по ключу только для Арбата) ---
function channelIdByKey(key) {
  const entry = Object.entries(channelRules).find(([, rule]) => rule.key === key);
  return entry ? entry[0] : "";
}
const ARBAT_CHANNEL_DEFAULTS = {
  cases: channelIdByKey("sk_cases"),
  roster: channelIdByKey("staff"),
  // КСУ находится на отдельном Discord-сервере ЦА и не наследуется Арбатом.
  ksoTasks: "",
  report: "",
  pgskoReports: "",
  actReview: "1498065990888718376",
  discipline: channelIdByKey("discipline_audit"),
};

const CHANNEL_ENV = {
  cases: "CASES_CHANNEL_ID",
  roster: "ROSTER_CHANNEL_ID",
  ksoTasks: "KSO_TASKS_CHANNEL_ID",
  report: "REPORT_CHANNEL_ID",
  pgskoReports: "PGSKO_REPORT_CHANNEL_ID",
  actReview: "ACT_REVIEW_CHANNEL_ID",
  discipline: "DISCIPLINE_CHANNEL_ID",
};

function envValue(name) {
  return String(process.env[name] || "").trim();
}

export function publicationChannelsForUnit(unit) {
  const normalized = String(unit || "").trim().toLowerCase();
  const prefix = normalized ? `${normalized.toUpperCase()}_` : "";
  return Object.fromEntries(Object.entries(CHANNEL_ENV).map(([key, name]) => {
    const explicit = envValue(`${prefix}${name}`) || envValue(name);
    // Чужой экземпляр никогда молча не наследует боевые ID Арбата.
    const fallback = normalized === "arbat" ? ARBAT_CHANNEL_DEFAULTS[key] : "";
    return [key, explicit || fallback || ""];
  }));
}

export const CHANNELS = publicationChannelsForUnit("arbat");

export function casePublicationChannelIds(unit) {
  const normalized = String(unit || "").trim().toLowerCase();
  const primary = publicationChannelsForUnit(normalized).cases;
  const extra = envValue(`${normalized.toUpperCase()}_CASES_LEGACY_CHANNEL_IDS`)
    || envValue("CASES_LEGACY_CHANNEL_IDS");
  return [...new Set([primary, ...extra.split(",").map((id) => id.trim())].filter(Boolean))];
}

// Цвет полосы embed карточки акта на рассмотрении (винно-бордовый).
export const ACT_REVIEW_COLOR = 0x6e1018;

// Цвет полосы embed еженедельного отчёта (тёмно-винный).
export const REPORT_COLOR = 0x6e1423;

// Цвет полосы embed состава (красный, как в примерах).
export const ROSTER_COLOR = 0xbd2b16;

// Цвет embed отчёта ПГСкО.
export const PGSKO_COLOR = 0x2f855a;

// --- Роль прокуратуры (упоминается в шапке сообщений о делах) ---
// Бот найдёт роль по имени; если задан PROSECUTOR_ROLE_ID в .env — используется он.
export const PROSECUTOR_ROLE_NAME = "[🔒] Прокуратура г. Москвы и МО";
export const PROSECUTOR_ROLE_ID = process.env.PROSECUTOR_ROLE_ID?.trim() || "1246729373541859348";

export function prosecutorRoleIdForUnit(unit) {
  const normalized = String(unit || "arbat").trim().toLowerCase() || "arbat";
  const explicit = envValue(`${normalized.toUpperCase()}_PROSECUTOR_ROLE_ID`) || envValue("PROSECUTOR_ROLE_ID");
  return explicit || (normalized === "arbat" ? "1246729373541859348" : "");
}

// --- Цвета полос embed по статусу дела (выверить пипеткой по примерам при обкатке) ---
export const CASE_COLORS = {
  "Возбуждено": 0xF5C518, // 🟡 жёлтый
  "Передано в прокуратуру": 0x43B581, // 🟢 зелёный
  "Отказано в возбуждении": 0xE03B3B, // 🔴 красный
  "Прекращено": 0x5DADE2, // 🔵 голубой
  "Приостановлено": 0xE67E22, // 🟠 оранжевый
};

// --- Герб СК (thumbnail в embed) ---
export const COAT_OF_ARMS_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/59/Investigative_Committee_Russia_Emblem.svg/500px-Investigative_Committee_Russia_Emblem.svg.png";

export const EMBED_FOOTER = "© 2026 Следственный комитет | RMRP «Арбат»";

export function embedFooterForUnit(unit) {
  const normalized = String(unit || "arbat").trim().toLowerCase() || "arbat";
  const explicit = envValue(`${normalized.toUpperCase()}_EMBED_FOOTER`) || envValue("EMBED_FOOTER");
  if (explicit) return explicit;
  return normalized === "arbat"
    ? EMBED_FOOTER
    : `© 2026 Следственный комитет | ${normalized.toUpperCase()}`;
}

// --- Архивация по реакции ✅ ---
// Если PROSECUTOR_ROLE_ID задан — архивируем только когда ✅ поставил носитель роли.
// Иначе принимаем любой ✅ (упрощённо).
export const ARCHIVE_EMOJI = "✅";
export const ARCHIVE_REQUIRE_PROSECUTOR = Boolean(PROSECUTOR_ROLE_ID);

// Подтверждение ПГСкО по реакции ✅ в канале отчётов.
// Без PGSKO_APPROVER_ROLE_ID реакции игнорируются: зачёт должен быть fail-closed.
export const PGSKO_APPROVE_EMOJI = "✅";
export const PGSKO_APPROVER_ROLE_ID = process.env.PGSKO_APPROVER_ROLE_ID?.trim() || "";

export function pgskoApproverRoleIdForUnit(unit) {
  const normalized = String(unit || "arbat").trim().toLowerCase() || "arbat";
  return envValue(`${normalized.toUpperCase()}_PGSKO_APPROVER_ROLE_ID`) || envValue("PGSKO_APPROVER_ROLE_ID");
}

// === СОСТАВ ===
// Один объект = один embed в канале «состав-ск».
export const ROSTER_SECTIONS = [
  {
    key: "management",
    icon: "⚡",
    title: "Руководитель ГСУ СК России по АФО",
    positions: [
      "Руководитель управления",
    ],
  },
  {
    key: "apparatus",
    icon: "🇷🇺",
    title: "Аппарат руководителя ГСУ СК России",
    positions: [
      "Заместитель руководителя управления",
      "Заместитель руководителя управления - начальник аппарата",
      "Специальный советник руководителя",
      "Помощник руководителя",
      "Пресс-секретарь руководителя управления",
      "Помощник пресс-секретаря руководителя управления",
    ],
    showVacancies: true,
  },
  {
    key: "investigation",
    icon: "⭐",
    title: "Следственный отдел (СО)",
    positions: [
      "Руководитель следственного отдела",
      "Заместитель руководителя следственного отдела",
      "Старший следователь по ОВД",
      "Следователь по ОВД",
      "Старший следователь-криминалист",
      "Следователь-криминалист",
      "Старший следователь",
      "Следователь",
    ],
  },
  {
    key: "training",
    icon: "🎓",
    title: "Отдел профессиональной подготовки (ОПП)",
    positions: [
      "Руководитель отдела профессиональной подготовки",
      "Старший специалист по кадрам",
      "Специалист по кадрам",
      "Следователь отдела профессиональной подготовки",
    ],
    showVacancies: true,
  },
];

// ⚠️ ЗАГЛУШКИ — заполнить реальными кастомными эмодзи через `npm run discover`.
// Значок роли по ключевому слову должности (порядок проверки — сверху вниз).
// Формат кастомного эмодзи: "<:name:id>". Пока юникод-заглушки.
export const POSITION_EMOJI_RULES = [
  { match: /аппарат|руководител|советник|помощник|пресс-секретар/i, emoji: "⚡" },
  { match: /криминалист/i, emoji: "🔬" },
  { match: /кадр/i, emoji: "📂" },
  { match: /профессиональн|подготов/i, emoji: "🎓" },
  { match: /следователь по овд|руководител.*отдел|заместител.*отдел/i, emoji: "⭐" },
  { match: /.*/, emoji: "✨" }, // по умолчанию — следователь
];

// Погоны по званию (кастомные эмодзи сервера). Discord рендерит по ID,
// имя в теге <:имя:id> не влияет на отображение.
// Если погоны АНИМИРОВАННЫЕ и не отрисуются — заменить "<:" на "<a:".
export const RANK_EMOJI = {
  "Младший лейтенант": "<:ml_lt:1499539431080722572>",
  "Лейтенант": "<:lt:1499539453734027475>",
  "Старший лейтенант": "<:st_lt:1499539478602322171>",
  "Капитан": "<:kpt:1499539503503769801>",
  "Майор": "<:mjr:1499539540237484253>",
  "Подполковник": "<:ppolk:1499539565629935706>",
  "Полковник": "<:polk:1499539590539907215>",
  "Генерал-майор": "<:gen_mjr:1499539616179552477>",
  "Генерал-лейтенант": "<:gen_lt:1499539638241726616>",
  "Генерал-полковник": "<:gen_polk:1499539665315823778>",
};

function jsonMap(name) {
  const raw = envValue(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
}

export function rankEmojiMapForUnit(unit) {
  const normalized = String(unit || "arbat").trim().toLowerCase() || "arbat";
  const explicit = {
    ...jsonMap("RANK_EMOJI_JSON"),
    ...jsonMap(`${normalized.toUpperCase()}_RANK_EMOJI_JSON`),
  };
  return normalized === "arbat" ? { ...RANK_EMOJI, ...explicit } : explicit;
}

// Role ID должностей для @упоминания роли в составе ("@[⚡] Должность").
// Ключ — должность из таблицы (новые названия), значение — Discord role ID.
// (Роли на сервере названы по-старому — сопоставлено по смыслу.)
export const POSITION_ROLE_IDS = {
  "Руководитель управления": "1297985183575965757",
  "Заместитель руководителя управления": "1297985926563102801",
  "Заместитель руководителя управления - начальник аппарата": "1460241518957826101",
  "Специальный советник руководителя": "1246730960620224542",
  "Помощник руководителя": "1411535440007401653",
  "Пресс-секретарь руководителя управления": "1376540358791397378",
  "Помощник пресс-секретаря руководителя управления": "1376540732852273243",
  "Руководитель следственного отдела": "1376540349920575651",
  "Заместитель руководителя следственного отдела": "1479578661739954176",
  "Старший следователь по ОВД": "1297957453404835911",
  "Следователь по ОВД": "1297985413935530015",
  "Старший следователь-криминалист": "1393931914905124956",
  "Следователь-криминалист": "1366775750803329144",
  "Старший следователь": "1297985416309506144",
  "Следователь": "1297986245384998922",
  "Руководитель отдела профессиональной подготовки": "1497303923382288527",
  "Специалист по кадрам": "1421351411970478080",
  "Следователь отдела профессиональной подготовки": "1479578430876946496",
};

export function positionRoleIdsForUnit(unit) {
  const normalized = String(unit || "arbat").trim().toLowerCase() || "arbat";
  const explicit = {
    ...jsonMap("POSITION_ROLE_IDS_JSON"),
    ...jsonMap(`${normalized.toUpperCase()}_POSITION_ROLE_IDS_JSON`),
  };
  return normalized === "arbat" ? { ...POSITION_ROLE_IDS, ...explicit } : explicit;
}

export function positionEmoji(position) {
  const rule = POSITION_EMOJI_RULES.find((r) => r.match.test(String(position)));
  return rule ? rule.emoji : "";
}

// Полный список должностей Аппарата — для вывода вакансий «Набор не ведётся»
// (должность из списка, которой нет ни у кого в составе).
export const APPARAT_POSITIONS = [
  "Руководитель управления",
  "Заместитель руководителя управления",
  "Заместитель руководителя управления - начальник аппарата",
  "Специальный советник руководителя",
  "Помощник руководителя",
  "Пресс-секретарь руководителя управления",
  "Помощник пресс-секретаря руководителя управления",
];
