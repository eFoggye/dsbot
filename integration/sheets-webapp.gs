/**
 * Google Apps Script Web App — приёмник действий от Discord-бота.
 *
 * Развёртывание: см. integration/DEPLOY.md.
 * Скрипт ПРИВЯЗАН к таблице «ГСУ СК России по АФО» (Расширения → Apps Script),
 * поэтому работает от имени владельца таблицы — Google-ключи боту не нужны.
 *
 * Бот шлёт POST { action, meta } на URL вида:
 *   https://script.google.com/.../exec?token=СЕКРЕТ
 * Секрет хранится в Script Properties (ключ WEBHOOK_SECRET), НЕ в коде.
 *
 * Поддерживаемые action.type:
 *   - append_active_case      -> добавить дело в «Дела в производстве»
 *   - case_status_event       -> найти дело по номеру и обновить статус/результат
 *   - upsert_staff_rows       -> добавить/обновить строки в «Состав»
 *   - discipline_event        -> обновить взыскания в «Состав» (Предупреждения/Выговоры)
 *   - staff_status_event      -> сменить статус сотрудника в «Состав»
 *   - internal_order_needs_ocr-> зафиксировать в «Discord импорт» (нужен OCR)
 *   - raw_message             -> положить сырое сообщение в «Discord импорт»
 *   - pgsko_published         -> сохранить Discord-сообщение отчёта ПГСкО
 *   - approve_pgsko_by_message-> зачесть ПГСкО по ✅ под Discord-сообщением
 */

// На какой строке у каждого листа находятся заголовки колонок.
// Взыскания теперь ведутся прямо в «Состав» (колонки «Предупреждения»/«Выговоры»);
// отдельного листа «Аудит взысканий» больше нет.
const HEADER_ROWS = {
  "Дела в производстве": 3,
  "Архив дел": 3,
  "Состав": 3,
  "Повышения": 3,
  "ПГСкО": 1,
  "Discord импорт": 1,
  "Бот-лог": 1,
};

function doGet(e) {
  // Бот опрашивает очередь публикаций: GET ?token=...&mode=queue
  if (e && e.parameter && e.parameter.mode === "queue") {
    if (!checkSecret_(e)) return jsonOut({ ok: false, error: "forbidden" });
    return jsonOut(getQueue_());
  }
  return jsonOut({ ok: true, service: "gsu-sk discord sink", time: new Date().toISOString() });
}

function doPost(e) {
  try {
    if (!checkSecret_(e)) {
      return jsonOut({ ok: false, error: "forbidden" });
    }
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = payload.action || payload.sheetAction || payload;
    const meta = payload.meta || {};
    if (!action || !action.type) {
      return jsonOut({ ok: false, error: "no action" });
    }

    let result;
    switch (action.type) {
      case "append_active_case":       result = appendByHeaders_("Дела в производстве", action.row); break;
      case "case_status_event":        result = updateCaseStatus_(action); break;
      case "upsert_staff_rows":        result = upsertStaffRows_(action); break;
      case "discipline_event":         result = updateDiscipline_(action); break;
      case "staff_status_event":       result = updateStaffStatus_(action); break;
      case "internal_order_needs_ocr": result = appendImport_(action, meta, "нужен OCR"); break;
      case "raw_message":              result = appendImport_(action, meta, "raw"); break;
      case "case_published":           result = onCasePublished_(action); break;
      case "roster_published":         result = onRosterPublished_(action); break;
      case "report_published":         result = onReportPublished_(action); break;
      case "pgsko_published":          result = onPgSkOPublished_(action); break;
      case "approve_pgsko_by_message": result = approvePgSkOByMessage_(action); break;
      case "archive_case_by_message":  result = archiveCaseByMessage_(action); break;
      default:                         result = appendImport_(action, meta, "неизвестный тип: " + action.type);
    }

    logAction_(action, meta, "ok", JSON.stringify(result));
    return jsonOut({ ok: true, result: result });
  } catch (err) {
    try { logAction_({ type: "error" }, {}, "error", String(err)); } catch (ignore) {}
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ===================== Обработчики действий ===================== */

function appendByHeaders_(sheetName, rowObj) {
  if (!rowObj) return { skipped: "empty row" };
  const sheet = sheetByName_(sheetName);
  const map = headerMap_(sheet);
  const targetRow = firstEmptyRow_(sheet);
  writeRow_(sheet, targetRow, map, rowObj);
  if (sheetName === "Дела в производстве") setupCaseRow_(sheet, targetRow);
  return { sheet: sheetName, row: targetRow };
}

function updateCaseStatus_(action) {
  const sheetName = action.targetSheet || "Дела в производстве";
  const sheet = sheetByName_(sheetName);
  const caseNumber = action.lookup && action.lookup.caseNumber;
  if (!caseNumber) return { skipped: "no caseNumber" };
  const map = headerMap_(sheet);
  const rowIdx = findRow_(sheet, "Номер дела", caseNumber);

  if (rowIdx >= 0) {
    writeRow_(sheet, rowIdx, map, action.updates || action.row || {});
    return { sheet: sheetName, row: rowIdx, caseNumber: caseNumber, mode: "updated" };
  }

  // Дело не найдено. Само-возбуждённые дела (обычно код СК — по устному заявлению
  // или признакам преступления) приходят только в «дела-ск» событием «возбуждено»
  // и в распределении не участвуют — поэтому их здесь СОЗДАЁМ, а не пропускаем.
  const data = action.data || {};
  const updates = action.updates || {};
  const status = updates["Статус"] || "";
  const isOpening = status === "Возбуждено" || data.event === "case_opened";

  if (isOpening) {
    const targetRow = firstEmptyRow_(sheet);
    const newRow = {
      "Дата поступления": updates["Дата события"] || "",
      "Код дела": data.caseCode || "",
      "Номер дела": caseNumber,
      "Следователь": data.investigatorName || updates["Закрыл / изменил"] || "",
      "Статус": "Возбуждено",
      "Ссылка на документ": updates["Ссылка на публикацию"] || "",
    };
    // Это событие из «дела-ск», а не из распределения: пишем полный номер дела.
    // Отдельный «Порядковый номер» — служебная нумерация строк, он не связан с номером материала.
    writeRow_(sheet, targetRow, map, newRow);
    setupCaseRow_(sheet, targetRow);
    return { sheet: sheetName, row: targetRow, caseNumber: caseNumber, mode: "created (само-возбуждённое)" };
  }

  return { skipped: "case not found: " + caseNumber };
}

function upsertStaffRows_(action) {
  const sheet = sheetByName_(action.targetSheet || "Состав");
  const map = headerMap_(sheet);
  const out = [];
  (action.rows || []).forEach(function (row) {
    const fio = row["ФИО"];
    let rowIdx = fio ? findRow_(sheet, "ФИО", fio) : -1;
    const wasEmpty = rowIdx < 0;
    if (rowIdx < 0) rowIdx = firstEmptyRow_(sheet);
    writeRow_(sheet, rowIdx, map, row);
    if (wasEmpty && sheet.getName() === "Состав") setupStaffRow_(sheet, rowIdx);
    out.push({ fio: fio, row: rowIdx });
  });
  return { sheet: sheet.getName(), upserted: out.length, rows: out };
}

function updateDiscipline_(action) {
  // Взыскания пишутся в «Состав»: ищем сотрудника по ФИО, обновляем колонки
  // «Предупреждения»/«Выговоры». Прочие поля (Причина, Кто выдал, Отработка и т.п.)
  // в «Составе» отсутствуют — writeRow_ их просто пропустит (нужны только числа).
  const sheet = sheetByName_("Состав");
  const map = headerMap_(sheet);
  const updates = action.updates || action.row || {};
  const who = (action.lookup && action.lookup.name) || updates["Сотрудник"] || updates["ФИО"];
  const rowIdx = who ? findRow_(sheet, "ФИО", who) : -1;
  if (rowIdx < 0) return { skipped: "сотрудник не найден в «Состав»: " + who };
  writeRow_(sheet, rowIdx, map, updates);
  return { sheet: "Состав", row: rowIdx, who: who };
}

function updateStaffStatus_(action) {
  const sheet = sheetByName_("Состав");
  const map = headerMap_(sheet);
  const who = (action.lookup && action.lookup.name) || (action.updates && action.updates["ФИО"]);
  const rowIdx = who ? findRow_(sheet, "ФИО", who) : -1;
  if (rowIdx < 0) return { skipped: "staff not found: " + who };
  writeRow_(sheet, rowIdx, map, action.updates || {});
  return { sheet: "Состав", row: rowIdx, who: who };
}

function appendImport_(action, meta, note) {
  const sheet = ensureSheet_("Discord импорт", ["Дата", "Канал", "Автор", "Текст", "Ссылка", "Тип", "Примечание"]);
  const row = (action.row) || {};
  sheet.appendRow([
    row["Дата"] || new Date(),
    row["Канал"] || (meta.channel && meta.channel.name) || "",
    row["Автор"] || "",
    row["Текст"] || "",
    row["Ссылка"] || meta.messageUrl || "",
    action.type || "",
    note || "",
  ]);
  return { sheet: "Discord импорт", note: note };
}

/* ===================== Вспомогательные функции ===================== */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheetByName_(name) {
  const sheet = ss_().getSheetByName(name);
  if (!sheet) throw new Error("Лист не найден: " + name);
  return sheet;
}

function headerRowFor_(name) { return HEADER_ROWS[name] || 1; }

function headerMap_(sheet) {
  const hr = headerRowFor_(sheet.getName());
  const headers = sheet.getRange(hr, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { if (String(h).trim()) map[String(h).trim()] = i + 1; });
  return map;
}

function firstEmptyRow_(sheet) {
  const hr = headerRowFor_(sheet.getName());
  const start = hr + 1;
  const last = sheet.getLastRow();
  const maxRows = Math.max(last, start);
  const values = sheet.getRange(start, 1, maxRows - start + 1, Math.min(10, sheet.getLastColumn())).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i].every(function (v) { return String(v).trim() === ""; })) return start + i;
  }
  return maxRows + 1;
}

function ensureRowExists_(sheet, rowIndex) {
  const maxRows = sheet.getMaxRows();
  if (rowIndex <= maxRows) return;
  sheet.insertRowsAfter(maxRows, rowIndex - maxRows);
}

function findRow_(sheet, headerName, value) {
  const map = headerMap_(sheet);
  const col = map[headerName];
  if (!col) return -1;
  const hr = headerRowFor_(sheet.getName());
  const start = hr + 1;
  const last = sheet.getLastRow();
  if (last < start) return -1;
  const col1 = sheet.getRange(start, col, last - start + 1, 1).getDisplayValues();
  const needle = String(value).trim();
  for (let i = 0; i < col1.length; i++) {
    if (String(col1[i][0]).trim() === needle) return start + i;
  }
  return -1;
}

const HEADER_ALIASES = {
  "Срок": ["Срок (истечения)"],
  "Срок (истечения)": ["Срок"],
  "Ссылка на документ": ["Ссылка на материалы"],
  "Ссылка на публикацию": ["Ссылка на материалы"],
  "Ссылка на материалы": ["Ссылка на документ", "Ссылка на публикацию"],
  "Сотрудник": ["ФИО"],
  "ФИО": ["Сотрудник"],
};

function colForHeader_(map, header) {
  if (map[header]) return map[header];
  const aliases = HEADER_ALIASES[header] || [];
  for (let i = 0; i < aliases.length; i++) {
    if (map[aliases[i]]) return map[aliases[i]];
  }
  return 0;
}

function valueFromRow_(row, map, headers) {
  for (let i = 0; i < headers.length; i++) {
    const col = colForHeader_(map, headers[i]);
    if (!col) continue;
    const value = row[col - 1];
    if (value !== "" && value !== null && value !== undefined) return value;
  }
  return "";
}

function setValueByHeaders_(sheet, rowIndex, map, headers, value) {
  for (let i = 0; i < headers.length; i++) {
    const col = colForHeader_(map, headers[i]);
    if (!col) continue;
    const cell = sheet.getRange(rowIndex, col);
    if (cell.getFormula()) return;
    cell.setValue(value);
    return;
  }
}

/** Пишет явные значения по заголовкам. Данные бота важнее старых формул-шаблонов. */
function writeRow_(sheet, rowIndex, map, rowObj) {
  ensureRowExists_(sheet, rowIndex);
  Object.keys(rowObj).forEach(function (header) {
    const col = colForHeader_(map, header);
    if (!col) return; // нет такой колонки — пропускаем
    const cell = sheet.getRange(rowIndex, col);
    const val = rowObj[header];
    if (val !== undefined && val !== null && String(val) !== "") cell.setValue(val);
  });
}

function ensureSheet_(name, headers) {
  let sheet = ss_().getSheetByName(name);
  if (!sheet) {
    sheet = ss_().insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function checkSecret_(e) {
  const expected = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
  if (!expected) return false; // секрет не настроен — запрещаем всё
  const got = (e && e.parameter && e.parameter.token) || "";
  return got === expected;
}

function logAction_(action, meta, status, detail) {
  const sheet = ensureSheet_("Бот-лог", ["Время", "Статус", "Тип действия", "Лист", "Сообщение", "Детали"]);
  sheet.appendRow([
    new Date(),
    status,
    (action && action.type) || "",
    (action && action.targetSheet) || "",
    (meta && meta.messageUrl) || "",
    (detail || "").slice(0, 500),
  ]);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================== Очередь реверс-публикаций (таблица → бот) ===================== */
// Лист «Очередь публикаций» (скрытый): A=ID, B=Тип(case/roster), C=Статус(ожидает/готово), D=Данные(JSON), E=Время.

const QUEUE_SHEET = "Очередь публикаций";
const PUBLISHED_SHEET = "Опубликованные дела"; // A=messageId, B=Номер дела, C=Статус, D=Время
const PGSKO_SHEET = "ПГСкО";
const PGSKO_STATUS_PENDING = "На проверке";
const PGSKO_STATUS_APPROVED = "Зачтено";
const PGSKO_FORM_TITLE = "ПГСкО — отчёт о привлечении к ответственности";
const PGSKO_FORM_ITEMS = [
  "Ник следователя",
  "Статик следователя",
  "Ник привлеченного сотрудника",
  "Статик привлеченного сотрудника",
  "Скриншот / доказательство",
  "Комментарий",
];

// Кладёт задание в очередь (вызывается из onEdit / меню публикации состава).
function enqueuePublish_(type, dataObj) {
  const sheet = ensureSheet_(QUEUE_SHEET, ["ID", "Тип", "Статус", "Данные", "Время"]);
  const id = String(Date.now()) + "-" + Math.floor(Math.random() * 1000);
  sheet.appendRow([id, type, "ожидает", JSON.stringify(dataObj || {}), new Date()]);
  return id;
}

// Отдаёт боту список ожидающих заданий + сохранённые id сообщений состава.
function getQueue_() {
  const ss = ss_();
  const sheet = ss.getSheetByName(QUEUE_SHEET);
  const jobs = [];
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    rows.forEach(function (r) {
      if (String(r[2]).trim() !== "ожидает") return;
      var data = {};
      try { data = JSON.parse(r[3] || "{}"); } catch (ignore) {}
      const job = { id: String(r[0]), type: String(r[1]).trim() };
      Object.keys(data).forEach(function (k) { job[k] = data[k]; });
      jobs.push(job);
    });
  }
  const idsCsv = PropertiesService.getScriptProperties().getProperty("ROSTER_MSG_IDS") || "";
  const rosterMessageIds = idsCsv ? idsCsv.split(",").filter(Boolean) : [];
  return { ok: true, jobs: jobs, rosterMessageIds: rosterMessageIds };
}

function markJobDone_(queueId) {
  const sheet = ss_().getSheetByName(QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(queueId)) { sheet.getRange(i + 2, 3).setValue("готово"); return; }
  }
}

function onCasePublished_(action) {
  if (action.queueId) markJobDone_(action.queueId);
  const sheet = ensureSheet_(PUBLISHED_SHEET, ["messageId", "Номер дела", "Статус", "Время"]);
  sheet.appendRow([String(action.messageId || ""), action.caseNumber || "", action.status || "", new Date()]);
  return { ok: true, recorded: action.caseNumber, messageId: action.messageId };
}

function onRosterPublished_(action) {
  if (action.queueId) markJobDone_(action.queueId);
  const ids = (action.messageIds || []).join(",");
  PropertiesService.getScriptProperties().setProperty("ROSTER_MSG_IDS", ids);
  return { ok: true, rosterMessageIds: action.messageIds || [] };
}

function onReportPublished_(action) {
  if (action.queueId) markJobDone_(action.queueId);
  return { ok: true, messageId: action.messageId || "" };
}

// ✅ под делом → находим номер дела по messageId и переносим дело в архив.
function archiveCaseByMessage_(action) {
  const sheet = ss_().getSheetByName(PUBLISHED_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { skipped: "нет опубликованных дел" };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  let caseNumber = "";
  for (let i = rows.length - 1; i >= 0; i--) { // ищем с конца — последнее сообщение по делу
    if (String(rows[i][0]) === String(action.messageId)) { caseNumber = String(rows[i][1]).trim(); break; }
  }
  if (!caseNumber) return { skipped: "дело по messageId не найдено" };
  return archiveCaseByNumber_(caseNumber);
}

// Переносит дело из «Дела в производстве» в «Архив дел» по номеру (утверждено прокуратурой).
function archiveCaseByNumber_(caseNumber) {
  const ss = ss_();
  const active = sheetByName_("Дела в производстве");
  const archive = sheetByName_("Архив дел");
  const rowIdx = findRow_(active, "Номер дела", caseNumber);
  if (rowIdx < 0) return { skipped: "дело не найдено в активных: " + caseNumber };

  const activeMap = headerMap_(active);
  const archiveMap = headerMap_(archive);
  const targetRow = firstEmptyRow_(archive);
  ensureRowExists_(archive, targetRow);

  const activeRow = active.getRange(rowIdx, 1, 1, active.getLastColumn()).getValues()[0];
  const caseFields = [
    ["Дата поступления"],
    ["Код дела"],
    ["Номер дела"],
    ["Источник"],
    ["Следователь"],
    ["Статус"],
    ["Срок (истечения)", "Срок"],
    ["Ссылка на материалы", "Ссылка на документ", "Ссылка на публикацию"],
    ["Результат / основание"],
  ];
  caseFields.forEach(function (headers) {
    const value = valueFromRow_(activeRow, activeMap, headers);
    if (value !== "" && value !== null && value !== undefined) {
      setValueByHeaders_(archive, targetRow, archiveMap, headers, value);
    }
  });
  setValueByHeaders_(archive, targetRow, archiveMap, ["Дата закрытия"], new Date());
  setValueByHeaders_(archive, targetRow, archiveMap, ["Утверждено прокуратурой"], "Да");
  setValueByHeaders_(archive, targetRow, archiveMap, ["Дата утверждения прокуратурой"], new Date());

  archive.getRange(targetRow, 1, 1, archive.getLastColumn())
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);

  // Удаляем строку из активных дел, чтобы снизу не оставалась пустая дырка.
  const maxRowsBefore = active.getMaxRows();
  active.deleteRow(rowIdx);
  if (active.getMaxRows() < maxRowsBefore) {
    active.insertRowsAfter(active.getMaxRows(), maxRowsBefore - active.getMaxRows());
    setupCaseRow_(active, active.getMaxRows());
  }
  return { archived: caseNumber, archiveRow: targetRow };
}

/* ===================== ПГСкО: форма → Discord → зачёт ===================== */

function ensurePgSkOSheet_() {
  const headers = [
    "ID отчета",
    "Дата отчета",
    "Следователь",
    "Статик следователя",
    "Привлеченный сотрудник",
    "Статик привлеченного",
    "Доказательство",
    "Статус",
    "Проверил",
    "Дата проверки",
    "Discord message ID",
    "Ссылка на сообщение",
    "Комментарий",
  ];
  const sheet = ensureSheet_(PGSKO_SHEET, headers);
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  const map = headerMap_(sheet);
  headers.forEach(function (header, i) {
    if (!map[header]) sheet.getRange(1, i + 1).setValue(header);
  });
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  return sheet;
}

function namedValue_(namedValues, names) {
  for (let i = 0; i < names.length; i++) {
    const value = namedValues[names[i]];
    if (!value) continue;
    if (Array.isArray(value)) return value.join(", ").trim();
    return String(value).trim();
  }
  return "";
}

function getActiveStaffNames_() {
  const sheet = ss_().getSheetByName("Состав");
  const out = [];
  const seen = {};
  if (!sheet || sheet.getLastRow() < 4) return out;
  const values = sheet.getRange(4, 1, sheet.getLastRow() - 3, 9).getValues();
  values.forEach(function (r) {
    const fio = String(r[0]).trim();
    const status = String(r[8]).trim();
    if (!fio || status !== "Активен" || seen[fio]) return;
    seen[fio] = true;
    out.push(fio);
  });
  return out.sort(function (a, b) { return a.localeCompare(b, "ru"); });
}

function pgSkOFormItemCounts_(form) {
  const counts = {};
  form.getItems().forEach(function (item) {
    const title = String(item.getTitle()).trim();
    if (PGSKO_FORM_ITEMS.indexOf(title) === -1) return;
    counts[title] = (counts[title] || 0) + 1;
  });
  return counts;
}

function hasDuplicatePgSkOFormItems_(form) {
  const counts = pgSkOFormItemCounts_(form);
  return PGSKO_FORM_ITEMS.some(function (title) { return (counts[title] || 0) > 1; });
}

function hasAllPgSkOFormItems_(form) {
  const counts = pgSkOFormItemCounts_(form);
  return PGSKO_FORM_ITEMS.every(function (title) { return (counts[title] || 0) === 1; });
}

function findPgSkOFormItem_(form, title) {
  const items = form.getItems();
  for (let i = 0; i < items.length; i++) {
    if (String(items[i].getTitle()).trim() === title) return items[i];
  }
  return null;
}

function addPgSkOFormItems_(form, staff) {
  if (staff.length) {
    form.addListItem()
      .setTitle("Ник следователя")
      .setChoiceValues(staff)
      .setRequired(true);
  } else {
    form.addTextItem().setTitle("Ник следователя").setRequired(true);
  }
  form.addTextItem().setTitle("Статик следователя").setRequired(true);
  form.addTextItem().setTitle("Ник привлеченного сотрудника").setRequired(true);
  form.addTextItem().setTitle("Статик привлеченного сотрудника").setRequired(true);
  try {
    form.addFileUploadItem()
      .setTitle("Скриншот / доказательство")
      .setHelpText("Прикрепите скриншот, подтверждающий привлечение к ответственности.")
      .setRequired(true);
  } catch (err) {
    form.addTextItem()
      .setTitle("Скриншот / доказательство")
      .setHelpText("Вставьте ссылку на скриншот, если загрузка файлов недоступна.")
      .setRequired(true);
  }
  form.addParagraphTextItem().setTitle("Комментарий").setRequired(false);
}

function refreshPgSkOFormStaffList_(form, staff) {
  if (!staff.length) return;
  const item = findPgSkOFormItem_(form, "Ник следователя");
  if (!item || item.getType() !== FormApp.ItemType.LIST) return;
  item.asListItem().setChoiceValues(staff).setRequired(true);
}

function ensurePgSkOFormDestination_(form) {
  const spreadsheetId = ss_().getId();
  let destinationId = "";
  try { destinationId = form.getDestinationId(); } catch (ignore) {}
  if (destinationId !== spreadsheetId) {
    form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheetId);
  }
}

function appendPgSkOReport_(data) {
  const sheet = ensurePgSkOSheet_();
  const reportId = data.reportId || ("PGSKO-" + Utilities.getUuid().slice(0, 8).toUpperCase());
  const submittedAt = data.submittedAt || new Date();
  sheet.appendRow([
    reportId,
    submittedAt,
    data.investigatorName || "",
    data.investigatorStatic || "",
    data.targetName || "",
    data.targetStatic || "",
    data.proofUrl || "",
    PGSKO_STATUS_PENDING,
    "",
    "",
    "",
    "",
    data.comment || "",
  ]);
  enqueuePublish_("pgsko_report", {
    reportId: reportId,
    submittedAt: submittedAt,
    investigatorName: data.investigatorName || "",
    investigatorStatic: data.investigatorStatic || "",
    targetName: data.targetName || "",
    targetStatic: data.targetStatic || "",
    proofUrl: data.proofUrl || "",
    comment: data.comment || "",
  });
  return { sheet: PGSKO_SHEET, reportId: reportId };
}

function findPgSkORow_(sheet, headerName, value) {
  const row = findRow_(sheet, headerName, value);
  return row >= 0 ? row : -1;
}

function onPgSkOPublished_(action) {
  if (action.queueId) markJobDone_(action.queueId);
  const sheet = ensurePgSkOSheet_();
  const map = headerMap_(sheet);
  const row = action.reportId ? findPgSkORow_(sheet, "ID отчета", action.reportId) : -1;
  if (row < 0) return { skipped: "отчёт ПГСкО не найден: " + (action.reportId || "") };
  setValueByHeaders_(sheet, row, map, ["Discord message ID"], action.messageId || "");
  setValueByHeaders_(sheet, row, map, ["Ссылка на сообщение"], action.messageUrl || "");
  return { ok: true, reportId: action.reportId || "", messageId: action.messageId || "" };
}

function approvePgSkOByMessage_(action) {
  const sheet = ensurePgSkOSheet_();
  const row = findPgSkORow_(sheet, "Discord message ID", action.messageId || "");
  if (row < 0) return { skipped: "отчёт ПГСкО по messageId не найден" };
  const map = headerMap_(sheet);
  const status = String(sheet.getRange(row, map["Статус"]).getValue()).trim();
  if (status === PGSKO_STATUS_APPROVED) return { ok: true, alreadyApproved: true, row: row };
  setValueByHeaders_(sheet, row, map, ["Статус"], PGSKO_STATUS_APPROVED);
  setValueByHeaders_(sheet, row, map, ["Проверил"], action.approvedByName || action.approvedById || "");
  setValueByHeaders_(sheet, row, map, ["Дата проверки"], new Date());
  return { ok: true, approved: true, row: row };
}

function setupPgSkOForm_() {
  ensurePgSkOSheet_();
  const props = PropertiesService.getScriptProperties();
  let form;
  let recreated = false;
  const existingId = props.getProperty("PGSKO_FORM_ID");
  if (existingId) {
    try { form = FormApp.openById(existingId); } catch (ignore) {}
  }
  if (form && hasDuplicatePgSkOFormItems_(form)) {
    form = null;
    recreated = true;
  }
  if (!form) form = FormApp.create(PGSKO_FORM_TITLE);

  form.setTitle(PGSKO_FORM_TITLE);
  form.setDescription("Заполняется сотрудником СК после привлечения государственного служащего к ответственности.");
  form.setCollectEmail(false);
  ensurePgSkOFormDestination_(form);

  const staff = getActiveStaffNames_();
  if (!hasAllPgSkOFormItems_(form)) addPgSkOFormItems_(form, staff);
  refreshPgSkOFormStaffList_(form, staff);

  props.setProperty("PGSKO_FORM_ID", form.getId());
  props.setProperty("PGSKO_FORM_URL", form.getPublishedUrl());
  installPgSkOFormTrigger_();
  const prefix = recreated ? "Старая форма была с дублями, создана новая чистая: " : "Форма ПГСкО готова: ";
  SpreadsheetApp.getActive().toast(prefix + form.getPublishedUrl(), "ПГСкО", 12);
  return form.getPublishedUrl();
}

function installPgSkOFormTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onPgSkOFormSubmit_") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("onPgSkOFormSubmit_").forSpreadsheet(ss_()).onFormSubmit().create();
}

function onPgSkOFormSubmit_(e) {
  const named = (e && e.namedValues) || {};
  const data = {
    submittedAt: new Date(),
    investigatorName: namedValue_(named, ["Ник следователя"]),
    investigatorStatic: namedValue_(named, ["Статик следователя"]),
    targetName: namedValue_(named, ["Ник привлеченного сотрудника", "Ник привлечённого сотрудника"]),
    targetStatic: namedValue_(named, ["Статик привлеченного сотрудника", "Статик привлечённого сотрудника"]),
    proofUrl: namedValue_(named, ["Скриншот / доказательство"]),
    comment: namedValue_(named, ["Комментарий"]),
  };
  return appendPgSkOReport_(data);
}

/* === Триггеры таблицы для публикации (вызываются из onEdit/onOpen кода таблицы) === */

// Обработка чекбоксов «Отправить» / «В архив» в «Дела в производстве».
// ВЫЗЫВАТЬ из onEdit(e) кода таблицы: publishOnEdit_(e);
function publishOnEdit_(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== "Дела в производстве") return;
  const row = e.range.getRow();
  if (row <= 3) return;
  const map = headerMap_(sheet);
  const col = e.range.getColumn();
  const val = e.range.getValue();

  if (map["Отправить"] && col === map["Отправить"] && val === true) {
    const caseNumber = String(sheet.getRange(row, map["Номер дела"]).getValue()).trim();
    const status = String(sheet.getRange(row, map["Статус"]).getValue()).trim();
    const investigator = String(sheet.getRange(row, map["Следователь"]).getValue()).trim();
    const publishable = ["Возбуждено", "Отказано в возбуждении", "Прекращено", "Передано в прокуратуру"];
    const resultByStatus = {
      "Отказано в возбуждении": "Отказ в ВУД",
      "Прекращено": "Прекращено",
      "Передано в прокуратуру": "Передано в прокуратуру",
    };
    if (publishable.indexOf(status) === -1) {
      SpreadsheetApp.getActive().toast("Статус «" + (status || "пусто") + "» не публикуется в дела-ск.");
      e.range.setValue(false);
      return;
    }
    if (map["Результат / основание"] && resultByStatus[status]) {
      const resultCell = sheet.getRange(row, map["Результат / основание"]);
      if (!String(resultCell.getValue()).trim()) resultCell.setValue(resultByStatus[status]);
    }
    if (caseNumber && status) {
      enqueuePublish_("case", { caseNumber: caseNumber, status: status, investigator: investigator });
      SpreadsheetApp.getActive().toast("Дело " + caseNumber + " (" + status + ") — в очереди на публикацию");
    }
    e.range.setValue(false);
  }

  if (map["В архив"] && col === map["В архив"] && val === true) {
    const caseNumber = String(sheet.getRange(row, map["Номер дела"]).getValue()).trim();
    if (caseNumber) {
      const res = archiveCaseByNumber_(caseNumber);
      SpreadsheetApp.getActive().toast("Архив " + caseNumber + ": " + (res.archived ? "перенесено" : (res.skipped || "ошибка")));
    }
    e.range.setValue(false);
  }
}

// Собирает состав для публикации (вызывается из пункта меню).
function rosterDate_(value) {
  if (!(value instanceof Date)) return value || "";
  return Utilities.formatDate(value, Session.getScriptTimeZone(), "dd.MM.yyyy");
}

function promotionStatsByName_() {
  const sheet = ss_().getSheetByName("Повышения");
  const out = {};
  if (!sheet || sheet.getLastRow() <= 3) return out;
  const map = headerMap_(sheet);
  const rows = sheet.getRange(4, 1, sheet.getLastRow() - 3, sheet.getLastColumn()).getValues();
  rows.forEach(function (r) {
    const fio = String(valueFromRow_(r, map, ["Сотрудник", "ФИО"])).trim();
    if (!fio) return;
    out[fio] = {
      transferredCases: valueFromRow_(r, map, ["УД передано в прокуратуру"]) || 0,
      publicServiceCases: valueFromRow_(r, map, ["Привлечено госслужащих"]) || 0,
      refusals: valueFromRow_(r, map, ["Отказы в ВУД"]) || 0,
    };
  });
  return out;
}

function collectRoster_() {
  const sheet = sheetByName_("Состав");
  const last = sheet.getLastRow();
  if (last < 4) return [];
  const stats = promotionStatsByName_();
  const data = sheet.getRange(4, 1, last - 3, 14).getValues(); // A:N
  const out = [];
  data.forEach(function (r) {
    const fio = String(r[0]).trim();
    if (!fio) return;
    const personStats = stats[fio] || {};
    out.push({
      fio: fio, rank: String(r[2]).trim(), position: String(r[3]).trim(),
      department: String(r[4]).trim(), group: String(r[5]).trim(),
      joinedAt: rosterDate_(r[6]), status: String(r[8]).trim(),
      warnings: Number(r[12]) || 0, reprimands: Number(r[13]) || 0,
      transferredCases: Number(personStats.transferredCases) || 0,
      publicServiceCases: Number(r[11]) || Number(personStats.publicServiceCases) || 0,
      refusals: Number(personStats.refusals) || 0,
    });
  });
  return out;
}

// Пункт меню «Опубликовать состав» (вызывается из onOpen-меню кода таблицы).
function publishRosterMenu_() {
  enqueuePublish_("roster", { roster: collectRoster_() });
  SpreadsheetApp.getActive().toast("Состав в очереди — бот опубликует в «состав-ск» в течение ~15 сек.");
}

/* ===================== Еженедельный отчёт ===================== */

function collectWeeklyReport_() {
  const ss = ss_();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  function inWeek(d) { return d instanceof Date && d >= weekAgo && d <= now; }
  function fmt(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy"); }

  // Архив дел (закрытия за неделю + топ следователей)
  const arc = ss.getSheetByName("Архив дел");
  let transferred = 0, refused = 0, terminated = 0, archiveTotal = 0;
  const topMap = {};
  if (arc && arc.getLastRow() > 3) {
    const arcMap = headerMap_(arc);
    const v = arc.getRange(4, 1, arc.getLastRow() - 3, arc.getLastColumn()).getValues();
    v.forEach(function (r) {
      if (String(valueFromRow_(r, arcMap, ["Номер дела"])).trim()) archiveTotal++;
      const fio = String(valueFromRow_(r, arcMap, ["Следователь"])).trim();
      const status = String(valueFromRow_(r, arcMap, ["Статус"])).trim();
      const result = String(valueFromRow_(r, arcMap, ["Результат / основание"])).trim();
      const closed = valueFromRow_(r, arcMap, ["Дата закрытия"]);
      if (inWeek(closed)) {
        if (status === "Передано в прокуратуру" || result === "Передано в прокуратуру") transferred++;
        else if (status === "Отказано в возбуждении" || result === "Отказ в ВУД") refused++;
        else if (status === "Прекращено" || result === "Прекращено") terminated++;
        if (fio) topMap[fio] = (topMap[fio] || 0) + 1;
      }
    });
  }
  const top = Object.keys(topMap).map(function (k) { return [k, topMap[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);

  // Дела в производстве (новые за неделю + текущая нагрузка)
  const act = ss.getSheetByName("Дела в производстве");
  let opened = 0, inWork = 0, overdue = 0, burning = 0;
  if (act && act.getLastRow() > 3) {
    const actMap = headerMap_(act);
    const v = act.getRange(4, 1, act.getLastRow() - 3, act.getLastColumn()).getValues();
    v.forEach(function (r) {
      const post = valueFromRow_(r, actMap, ["Дата поступления"]);
      const status = String(valueFromRow_(r, actMap, ["Статус"])).trim();
      const due = valueFromRow_(r, actMap, ["Срок (истечения)", "Срок"]);
      if (inWeek(post)) opened++;
      if (status === "Назначено" || status === "Возбуждено" || status === "Приостановлено") {
        inWork++;
      }
      if (status === "Назначено" || status === "Возбуждено") {
        if (due instanceof Date) {
          if (due < today0) overdue++;
          else if (due <= new Date(today0.getTime() + 3 * 86400000)) burning++;
        }
      }
    });
  }

  // Состав (срез + сумма взысканий)
  const ros = ss.getSheetByName("Состав");
  let total = 0, apparat = 0, so = 0, opp = 0, vacation = 0, available = 0, totalW = 0, totalR = 0;
  if (ros && ros.getLastRow() > 3) {
    const v = ros.getRange(4, 1, ros.getLastRow() - 3, 14).getValues();
    v.forEach(function (r) {
      const fio = String(r[0]).trim(); if (!fio) return;
      const dep = String(r[4]).trim(), status = String(r[8]).trim(), activeInv = String(r[9]).trim();
      if (status === "Активен") {
        total++;
        if (dep === "Аппарат руководителя ГСУ СК России") apparat++;
        else if (dep === "Следственный отдел (СО)") so++;
        else if (dep === "Отдел профессиональной подготовки (ОПП)") opp++;
      }
      if (status === "Отпуск") vacation++;
      if (activeInv) available++;
      totalW += Number(r[12]) || 0; // M Предупреждения
      totalR += Number(r[13]) || 0; // N Выговоры
    });
  }

  // ПГСкО (отчёты формы + зачёты руководства)
  const pgsko = ss.getSheetByName(PGSKO_SHEET);
  let pgskoSubmittedWeek = 0, pgskoApprovedWeek = 0, pgskoPending = 0, pgskoApprovedTotal = 0;
  const pgskoTopMap = {};
  if (pgsko && pgsko.getLastRow() > 1) {
    const pgskoMap = headerMap_(pgsko);
    const v = pgsko.getRange(2, 1, pgsko.getLastRow() - 1, pgsko.getLastColumn()).getValues();
    v.forEach(function (r) {
      const fio = String(valueFromRow_(r, pgskoMap, ["Следователь"])).trim();
      const submittedAt = valueFromRow_(r, pgskoMap, ["Дата отчета"]);
      const approvedAt = valueFromRow_(r, pgskoMap, ["Дата проверки"]);
      const status = String(valueFromRow_(r, pgskoMap, ["Статус"])).trim();
      if (inWeek(submittedAt)) pgskoSubmittedWeek++;
      if (status === PGSKO_STATUS_PENDING) pgskoPending++;
      if (status === PGSKO_STATUS_APPROVED) {
        pgskoApprovedTotal++;
        const countDate = approvedAt instanceof Date ? approvedAt : submittedAt;
        if (inWeek(countDate)) {
          pgskoApprovedWeek++;
          if (fio) pgskoTopMap[fio] = (pgskoTopMap[fio] || 0) + 1;
        }
      }
    });
  }
  const pgskoTop = Object.keys(pgskoTopMap).map(function (k) { return [k, pgskoTopMap[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);

  // История за неделю (повышения, взыскания, кадры)
  const hist = ss.getSheetByName("История");
  const promotions = []; let weekW = 0, weekR = 0, appointments = 0, dismissals = 0;
  if (hist && hist.getLastRow() > 3) {
    const v = hist.getRange(4, 1, hist.getLastRow() - 3, 5).getValues();
    v.forEach(function (r) {
      if (!inWeek(r[0])) return;
      const ev = String(r[1]).trim(), who = String(r[2]).trim(), to = String(r[4]).trim();
      if (ev === "Смена звания") promotions.push([who, to]);
      else if (ev.indexOf("Предупрежд") >= 0) weekW++;
      else if (ev.indexOf("Выговор") >= 0) weekR++;
      else if (ev.indexOf("Назначен") >= 0) appointments++;
      else if (ev.indexOf("Увол") >= 0) dismissals++;
    });
  }

  // Готовы к повышению (Повышения, вердикт O = ГОТОВ)
  const prom = ss.getSheetByName("Повышения");
  const ready = [];
  if (prom && prom.getLastRow() > 3) {
    const promMap = headerMap_(prom);
    const v = prom.getRange(4, 1, prom.getLastRow() - 3, prom.getLastColumn()).getValues();
    v.forEach(function (r) {
      const fio = String(valueFromRow_(r, promMap, ["Сотрудник", "ФИО"])).trim();
      const verdict = String(valueFromRow_(r, promMap, ["Готовность к повышению"])).trim();
      if (fio && verdict === "ГОТОВ") ready.push(fio);
    });
  }

  return {
    period: fmt(weekAgo) + " — " + fmt(now),
    cases: { opened: opened, transferred: transferred, refused: refused, terminated: terminated, inWork: inWork, overdue: overdue, burning: burning },
    top: top,
    staff: { total: total, apparat: apparat, so: so, opp: opp, vacation: vacation, available: available },
    pgsko: {
      submittedWeek: pgskoSubmittedWeek,
      approvedWeek: pgskoApprovedWeek,
      pending: pgskoPending,
      totalApproved: pgskoApprovedTotal,
      top: pgskoTop,
    },
    promotions: promotions, appointments: appointments, dismissals: dismissals,
    discipline: { weekW: weekW, weekR: weekR, totalW: totalW, totalR: totalR },
    ready: ready, archiveTotal: archiveTotal,
  };
}

// Пункт меню «Сформировать отчёт сейчас».
function publishWeeklyReport_() {
  enqueuePublish_("report", collectWeeklyReport_());
  SpreadsheetApp.getActive().toast("Еженедельный отчёт поставлен в очередь — бот опубликует.");
}

// Включает автоотчёт по воскресеньям в 20:00 (запустить один раз из меню).
function installWeeklyReportTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "publishWeeklyReport_") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("publishWeeklyReport_").timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).create();
  SpreadsheetApp.getActive().toast("Еженедельный отчёт включён: воскресенье, 20:00.");
}

/* ===== Автопостановка валидации/чекбоксов на новую строку (чтобы пустые строки были чистыми) ===== */

function dvFromRange_(a1) {
  const sp = ss_().getSheetByName("Справочники");
  return SpreadsheetApp.newDataValidation().requireValueInRange(sp.getRange(a1), true).setAllowInvalid(false).build();
}

function columnLetter_(col) {
  let out = "";
  while (col > 0) {
    const mod = (col - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    col = Math.floor((col - mod) / 26);
  }
  return out;
}

// Дело: код, статус — выпадашки; «Отправить», «В архив» — чекбоксы.
function setupCaseRow_(sheet, row) {
  const map = headerMap_(sheet);
  if (map["Код дела"]) sheet.getRange(row, map["Код дела"]).setDataValidation(dvFromRange_("F3:F9"));
  if (map["Статус"]) sheet.getRange(row, map["Статус"]).setDataValidation(dvFromRange_("G3:G8"));
  if (map["Результат / основание"]) sheet.getRange(row, map["Результат / основание"]).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(["Передано в прокуратуру", "Отказ в ВУД", "Прекращено"], true)
      .setAllowInvalid(false)
      .build()
  );
  const numberCol = map["Номер дела"];
  const serialCol = map["Порядковый номер"];
  if (numberCol && serialCol) {
    const numberLetter = columnLetter_(numberCol);
    sheet.getRange(row, serialCol).setFormula(
      '=IF($' + numberLetter + row + '="";"";COUNTIF($' + numberLetter + '$4:$' + numberLetter + row + ';"<>"))'
    );
  }
  if (map["Отправить"]) sheet.getRange(row, map["Отправить"]).insertCheckboxes();
  if (map["В архив"]) sheet.getRange(row, map["В архив"]).insertCheckboxes();
}

// Сотрудник: звание(C), должность(D), отдел(E), подотдел(F), статус(I), взыскания(M,N).
function setupStaffRow_(sheet, row) {
  sheet.getRange(row, 3).setDataValidation(dvFromRange_("A3:A14"));  // Звание
  sheet.getRange(row, 4).setDataValidation(dvFromRange_("B3:B22"));  // Должность
  sheet.getRange(row, 5).setDataValidation(dvFromRange_("C3:C5"));   // Отдел
  sheet.getRange(row, 6).setDataValidation(dvFromRange_("D3:D8"));   // Подотдел
  sheet.getRange(row, 9).setDataValidation(dvFromRange_("E3:E4"));   // Статус
  sheet.getRange(row, 13, 1, 2).setDataValidation(dvFromRange_("K3:K6")); // Предупреждения, Выговоры
}
