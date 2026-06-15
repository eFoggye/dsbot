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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`image HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "image/png").split(";")[0];
    const buffer = Buffer.from(await response.arrayBuffer());
    return { base64: buffer.toString("base64"), mediaType: contentType };
  } finally {
    clearTimeout(timeout);
  }
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
    return { isOrder: Boolean(parsed.is_order), actions: parsed.actions || [] };
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
