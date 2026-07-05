/**
 * OCR кадровых приказов из канала «внутренний-оборот» через Claude Vision (Haiku 4.5).
 *
 * Вызов идёт через aitunnel (OpenAI-совместимый API, https://api.aitunnel.ru/v1) —
 * прямой HTTP-запрос (fetch), без SDK-зависимости, чтобы бот оставался минимальным.
 * Модель сама читает картинку, понимает приказ это или нет, и возвращает структуру
 * с ФИО в ИМЕНИТЕЛЬНОМ падеже.
 *
 * Нужны в окружении: OCR_API_KEY (+ OCR_BASE_URL, OCR_MODEL — есть значения по умолчанию).
 * Если OCR_API_KEY не задан — OCR выключен, картинки только логируются.
 */

const DEFAULT_BASE_URL = "https://api.aitunnel.ru/v1";
const DEFAULT_MODEL = "claude-haiku-4.5";

// Картинки качаем ТОЛЬКО с CDN Discord (URL приходит из attachment.url) — защита
// от SSRF, если в imageUrls когда-нибудь попадёт произвольная ссылка из текста.
const ALLOWED_IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 МБ — с запасом для скана приказа

function assertSafeImageUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error(`OCR: недопустимый протокол картинки: ${url.protocol}`);
  }
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
    throw new Error(`OCR: недопустимый хост картинки: ${url.hostname}`);
  }
  return url;
}

const SYSTEM_PROMPT = [
  "Ты обрабатываешь изображение документа Главного следственного управления СК России по АФО.",
  "Определи, является ли это КАДРОВЫМ ПРИКАЗОМ (заголовок «ПРИКАЗ» + «О кадровых пересмотрах»).",
  "Если это рапорт, протокол, заявление или иной документ — верни is_order=false и пустой actions.",
  "Если это кадровый приказ — извлеки все кадровые действия из пунктов приказа.",
  "ВАЖНО: ФИО возвращай строго в ИМЕНИТЕЛЬНОМ падеже (например «Белоусов Андрей Сергеевич», а не «Белоусова Андрея Сергеевича»).",
  "kind: «назначение» — назначить/перевести на должность; «присвоение_звания» — присвоить или восстановить звание; «увольнение» — освободить от должности и/или уволить.",
  "Звания (нормализуй к этим): Младший лейтенант, Лейтенант, Старший лейтенант, Капитан, Майор, Подполковник, Полковник, Генерал-майор, Генерал-лейтенант, Генерал-полковник.",
  "Отделы (нормализуй к этим): «Аппарат руководителя ГСУ СК России», «Следственный отдел (СО)», «Отдел профессиональной подготовки (ОПП)».",
  "Если какое-то поле в приказе не указано — оставь пустую строку. Игнорируй печати, гербы и подписи.",
  "",
  "Верни СТРОГО валидный JSON без markdown-обёрток и без пояснений, по схеме:",
  '{"is_order": boolean, "actions": [{"kind": string, "fio": string, "position": string, "department": string, "rank": string, "status": string}]}',
].join("\n");

async function fetchImageBase64(url, timeoutMs) {
  const safeUrl = assertSafeImageUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(safeUrl, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`OCR: вложение не картинка (content-type: ${contentType})`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(`OCR: картинка слишком большая (${declaredLength} байт)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`OCR: картинка слишком большая (${buffer.byteLength} байт)`);
    }
    return { base64: buffer.toString("base64"), mediaType: contentType };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Валидация ответа модели -------------------------------------------------
// Модель читает картинку, которую мог прислать кто угодно с доступом к каналу.
// Через текст на картинке её можно попытаться «уговорить» (prompt injection)
// вернуть мусорные или вредные действия. Поэтому её выход НЕ доверенный:
// прогоняем через жёсткие whitelist'ы и отбрасываем всё, что не по форме.

const ALLOWED_KINDS = new Set(["назначение", "присвоение_звания", "увольнение"]);
const ALLOWED_RANKS = new Set([
  "Младший лейтенант", "Лейтенант", "Старший лейтенант", "Капитан", "Майор",
  "Подполковник", "Полковник", "Генерал-майор", "Генерал-лейтенант", "Генерал-полковник",
]);
const ALLOWED_DEPARTMENTS = new Set([
  "Аппарат руководителя ГСУ СК России",
  "Следственный отдел (СО)",
  "Отдел профессиональной подготовки (ОПП)",
]);
// ФИО: 2–3 слова кириллицей с заглавной, допускаем дефисные фамилии.
const FIO_PATTERN = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁа-яё][а-яё]+)?(?:\s+[А-ЯЁ][а-яё]+(?:-[А-ЯЁа-яё][а-яё]+)?){1,2}$/u;
// Должность: только буквы, пробелы, дефисы и скобки — без ссылок/управляющих символов.
const POSITION_PATTERN = /^[А-ЯЁа-яёA-Za-z\s()-]*$/u;
const MAX_ACTIONS = 20;

export function sanitizeOrderActions(actions) {
  const out = [];
  for (const raw of Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : []) {
    const kind = String(raw?.kind || "").trim();
    if (!ALLOWED_KINDS.has(kind)) continue;

    const fio = String(raw?.fio || "").replace(/\s+/g, " ").trim();
    if (fio.length > 80 || !FIO_PATTERN.test(fio)) continue;

    const rank = String(raw?.rank || "").trim();
    const department = String(raw?.department || "").trim();
    const position = String(raw?.position || "").replace(/\s+/g, " ").trim().slice(0, 80);

    out.push({
      kind,
      fio,
      rank: ALLOWED_RANKS.has(rank) ? rank : "",
      department: ALLOWED_DEPARTMENTS.has(department) ? department : "",
      position: POSITION_PATTERN.test(position) ? position : "",
      status: "",
    });
  }
  return out;
}

// Снимает ```json ... ``` обёртку, если модель её добавила, и парсит JSON.
function parseJsonLoose(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // на случай мусора вокруг — вырезаем от первой { до последней }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first > 0 || last < s.length - 1) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

export async function recognizeOrder(imageUrl, { apiKey, model, baseUrl, httpTimeoutMs }) {
  const { base64, mediaType } = await fetchImageBase64(imageUrl, httpTimeoutMs);
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 2000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Разбери этот документ строго по схеме и верни только JSON." },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(httpTimeoutMs, 30000));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OCR API HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { isOrder: false, actions: [] };
    const parsed = parseJsonLoose(content);
    // Выход модели — недоверенный: фильтруем через whitelist'ы (см. sanitizeOrderActions).
    return { isOrder: Boolean(parsed.is_order), actions: sanitizeOrderActions(parsed.actions) };
  } finally {
    clearTimeout(timeout);
  }
}

// Превращает распознанные действия приказа в действия для таблицы (для Web App).
export function orderActionsToSheetActions(actions) {
  const out = [];
  for (const action of actions || []) {
    if (!action.fio) continue;
    if (action.kind === "увольнение") {
      out.push({
        type: "staff_status_event",
        targetSheet: "Состав",
        lookup: { name: action.fio },
        updates: { "Статус": "Уволен" },
      });
    } else {
      const row = { "ФИО": action.fio, "Статус": "Активен" };
      if (action.rank) row["Звание"] = action.rank;
      if (action.position) row["Должность"] = action.position;
      if (action.department) row["Отдел"] = action.department;
      out.push({ type: "upsert_staff_rows", targetSheet: "Состав", rows: [row] });
    }
  }
  return out;
}
