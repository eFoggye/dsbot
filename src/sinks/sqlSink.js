import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

const sqlCache = new Map();

const FINAL_ARCHIVE_STATUSES = new Set(["Отказано в возбуждении"]);

function getSql(config) {
  if (!config.databaseUrl) return null;
  if (!sqlCache.has(config.databaseUrl)) sqlCache.set(config.databaseUrl, neon(config.databaseUrl));
  return sqlCache.get(config.databaseUrl);
}

function clean(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return clean(value).toLowerCase();
}

function idFor(prefix, value) {
  return `${prefix}_${crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 24)}`;
}

function parseDate(value) {
  const s = clean(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+03:00`);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
}

function parseCaseCode(caseNumber) {
  const match = clean(caseNumber).match(/^02-([А-ЯA-Z]+)-/i);
  return match ? match[1].toUpperCase() : "";
}

function sourceForCode(code) {
  return {
    "СК": "Следственный Комитет",
    "ОП": "Обращение в Прокуратуру",
    "ПП": "Постановление Прокуратуры",
    "ОПУ": "Обращение в Прокуратуру Устное",
    "СУД": "Суд",
    "ФСБ": "ФСБ",
    "ГП": "Генеральная прокуратура",
  }[String(code || "").toUpperCase()] || "";
}

async function findStaff(sql, fio) {
  if (!fio) return null;
  const rows = await sql`SELECT * FROM staff_members WHERE normalized_fio = ${normalizeName(fio)} LIMIT 1`;
  return rows[0] || null;
}

async function ensureStaff(sql, fio, extra = {}) {
  const name = clean(fio);
  if (!name) return null;
  const normalized = normalizeName(name);
  const id = idFor("stf", normalized);
  const existing = await findStaff(sql, name);
  if (existing) return existing;
  const rows = await sql`
    INSERT INTO staff_members (id, fio, normalized_fio, rank, status)
    VALUES (${id}, ${name}, ${normalized}, ${extra.rank || ""}, ${extra.status || "Активен"})
    ON CONFLICT (normalized_fio) DO UPDATE SET fio = EXCLUDED.fio
    RETURNING *
  `;
  return rows[0];
}

async function markOutboxProcessed(sql, queueId) {
  if (!queueId) return;
  await sql`UPDATE outbox_events SET status = 'processed', processed_at = now(), error = NULL WHERE id = ${queueId}`;
}

async function markOutboxError(sql, queueId, error) {
  if (!queueId) return;
  await sql`UPDATE outbox_events SET status = 'error', error = ${String(error || "").slice(0, 1000)} WHERE id = ${queueId}`;
}

async function saveRawMessage(sql, event) {
  await sql`
    INSERT INTO discord_messages (
      id, channel_id, channel_name, author_id, author_name, content, raw, created_at
    )
    VALUES (
      ${event.messageId}, ${event.channelId}, ${event.channel?.name || ""}, ${event.author?.id || ""},
      ${event.member?.displayName || event.author?.globalName || event.author?.username || ""},
      ${event.cleanContent || event.content || ""}, ${JSON.stringify(event)}::jsonb, ${parseDate(event.createdAt)}
    )
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content,
      raw = EXCLUDED.raw,
      ingested_at = now()
  `;
}

async function upsertAssignment(sql, action, meta) {
  const row = action.row || {};
  const caseNumber = clean(row["Номер дела"] || action.lookup?.caseNumber);
  if (!caseNumber) return;
  const investigator = clean(row["Следователь"] || action.data?.investigatorName);
  const staff = await ensureStaff(sql, investigator);
  const caseCode = clean(row["Код дела"]) || parseCaseCode(caseNumber);
  await sql`
    INSERT INTO cases (
      id, case_number, case_code, source, investigator_id, investigator_fio,
      status, received_at, due_at, materials_url
    )
    VALUES (
      ${idFor("case", caseNumber.toLowerCase())}, ${caseNumber}, ${caseCode}, ${clean(row["Источник"]) || sourceForCode(caseCode)},
      ${staff?.id || null}, ${investigator}, ${clean(row["Статус"]) || "Назначено"},
      ${parseDate(row["Дата поступления"] || meta?.receivedAt)}, ${parseDate(row["Срок (истечения)"] || action.data?.deadlineAt)},
      ${clean(row["Ссылка на материалы"] || meta?.messageUrl)}
    )
    ON CONFLICT (case_number) DO UPDATE SET
      case_code = EXCLUDED.case_code,
      source = EXCLUDED.source,
      investigator_id = EXCLUDED.investigator_id,
      investigator_fio = EXCLUDED.investigator_fio,
      status = EXCLUDED.status,
      received_at = COALESCE(cases.received_at, EXCLUDED.received_at),
      due_at = EXCLUDED.due_at,
      materials_url = COALESCE(NULLIF(EXCLUDED.materials_url, ''), cases.materials_url),
      archived_at = NULL,
      updated_at = now()
  `;
}

async function applyCaseStatus(sql, action, meta) {
  const data = action.data || {};
  const updates = action.updates || {};
  const caseNumber = clean(data.caseNumber || action.lookup?.caseNumber);
  if (!caseNumber) return;
  const status = clean(updates["Статус"]);
  const result = clean(updates["Результат / основание"]);
  const investigator = clean(data.investigatorName || updates["Закрыл / изменил"]);
  const staff = await ensureStaff(sql, investigator);
  const existing = await sql`SELECT * FROM cases WHERE lower(case_number) = ${caseNumber.toLowerCase()} LIMIT 1`;

  if (!existing[0]) {
    if (status !== "Возбуждено" && status !== "В производстве") return;
    const code = clean(data.caseCode) || parseCaseCode(caseNumber);
    await sql`
      INSERT INTO cases (
        id, case_number, case_code, source, investigator_id, investigator_fio,
        status, received_at, materials_url, result
      )
      VALUES (
        ${idFor("case", caseNumber.toLowerCase())}, ${caseNumber}, ${code}, ${sourceForCode(code)},
        ${staff?.id || null}, ${investigator}, ${status || "Возбуждено"}, ${parseDate(data.eventDate || meta?.receivedAt)},
        ${clean(updates["Ссылка на публикацию"] || meta?.messageUrl)}, ${result}
      )
    `;
    return;
  }

  await sql`
    UPDATE cases
    SET status = COALESCE(NULLIF(${status}, ''), status),
        result = COALESCE(NULLIF(${result}, ''), result),
        investigator_id = COALESCE(${staff?.id || null}, investigator_id),
        investigator_fio = COALESCE(NULLIF(${investigator}, ''), investigator_fio),
        materials_url = COALESCE(NULLIF(${clean(updates["Ссылка на публикацию"] || meta?.messageUrl)}, ''), materials_url),
        archived_at = CASE WHEN ${FINAL_ARCHIVE_STATUSES.has(status)} THEN now() ELSE archived_at END,
        closed_at = CASE WHEN ${FINAL_ARCHIVE_STATUSES.has(status)} THEN now() ELSE closed_at END,
        updated_at = now()
    WHERE lower(case_number) = ${caseNumber.toLowerCase()}
  `;
}

async function upsertStaffRows(sql, action) {
  const rows = action.rows || [];
  for (const [index, row] of rows.entries()) {
    const fio = clean(row["ФИО"]);
    if (!fio) continue;
    const staff = await ensureStaff(sql, fio, { rank: clean(row["Звание"]), status: clean(row["Статус"]) || "Активен" });
    await sql`
      UPDATE staff_members
      SET rank = COALESCE(NULLIF(${clean(row["Звание"])}, ''), rank),
          status = COALESCE(NULLIF(${clean(row["Статус"])}, ''), status),
          updated_at = now()
      WHERE id = ${staff.id}
    `;
    const position = clean(row["Должность"]);
    const department = clean(row["Подразделение"] || row["Отдел"]);
    if (!position && !department) continue;
    const posId = idFor("pos", `${staff.id}:${position}:${department}:${clean(row["Группа"] || row["Подотдел"])}`);
    await sql`
      INSERT INTO staff_positions (id, staff_id, position, department, group_name, display_order)
      VALUES (${posId}, ${staff.id}, ${position}, ${department}, ${clean(row["Группа"] || row["Подотдел"])}, ${index + 1})
      ON CONFLICT (id) DO UPDATE SET
        position = EXCLUDED.position,
        department = EXCLUDED.department,
        group_name = EXCLUDED.group_name,
        display_order = EXCLUDED.display_order
    `;
  }
}

async function applyDiscipline(sql, action) {
  const updates = action.updates || {};
  const fio = clean(updates["Сотрудник"] || action.lookup?.name);
  if (!fio) return;
  const staff = await ensureStaff(sql, fio);
  const warnings = updates["Предупреждения"];
  const reprimands = updates["Выговоры"];
  await sql`
    UPDATE staff_members
    SET warnings = CASE WHEN ${warnings === undefined} THEN warnings ELSE ${Number(warnings) || 0} END,
        reprimands = CASE WHEN ${reprimands === undefined} THEN reprimands ELSE ${Number(reprimands) || 0} END,
        updated_at = now()
    WHERE id = ${staff.id}
  `;
  await sql`
    INSERT INTO discipline_records (
      id, staff_id, fio, type, reason, workoff, workoff_status, issued_at, removed_at
    )
    VALUES (
      ${idFor("disc", `${fio}:${updates["Дата выдачи"]}:${updates["Тип последнего взыскания"]}:${updates["Причина"]}`)},
      ${staff.id}, ${fio}, ${clean(updates["Тип последнего взыскания"]) || "Обновление"}, ${clean(updates["Причина"])},
      ${clean(updates["Отработка"])}, ${clean(updates["Статус отработки"])}, ${parseDate(updates["Дата выдачи"])},
      ${action.data?.removal ? new Date() : null}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function applyStaffStatus(sql, action) {
  const fio = clean(action.data?.employeeName || action.lookup?.employeeName);
  const status = clean(action.data?.status || action.updates?.["Статус"]);
  if (!fio || !status) return;
  const staff = await ensureStaff(sql, fio);
  await sql`UPDATE staff_members SET status = ${status}, updated_at = now() WHERE id = ${staff.id}`;
}

async function acknowledgeAction(sql, action) {
  const type = action.type;
  const queueId = action.queueId;

  if (type === "case_published") {
    const caseNumber = clean(action.caseNumber);
    const caseRows = await sql`SELECT id FROM cases WHERE lower(case_number) = ${caseNumber.toLowerCase()} LIMIT 1`;
    if (action.messageId) {
      await sql`
        INSERT INTO case_publications (message_id, case_id, case_number, status, queue_id)
        VALUES (${action.messageId}, ${caseRows[0]?.id || null}, ${caseNumber}, ${clean(action.status)}, ${queueId || ""})
        ON CONFLICT (message_id) DO UPDATE SET
          case_id = EXCLUDED.case_id,
          case_number = EXCLUDED.case_number,
          status = EXCLUDED.status,
          queue_id = EXCLUDED.queue_id
      `;
    }
    await markOutboxProcessed(sql, queueId);
    return;
  }

  if (type === "pgsko_published") {
    await sql`
      UPDATE pgsko_reports
      SET discord_message_id = ${clean(action.messageId)}, message_url = ${clean(action.messageUrl)}
      WHERE id = ${clean(action.reportId)}
    `;
    await markOutboxProcessed(sql, queueId);
    return;
  }

  if (type === "act_review_published") {
    await sql`UPDATE case_acts SET discord_message_id = ${clean(action.messageId)} WHERE id = ${clean(action.actId)}`;
    await markOutboxProcessed(sql, queueId);
    return;
  }

  if (type === "act_decided_done" || type === "roster_published" || type === "report_published") {
    await markOutboxProcessed(sql, queueId);
    return;
  }

  if (type === "archive_case_by_message") {
    const rows = await sql`SELECT * FROM case_publications WHERE message_id = ${clean(action.messageId)} LIMIT 1`;
    const publication = rows[0];
    if (!publication) return;
    await sql`
      UPDATE cases
      SET archived_at = COALESCE(archived_at, now()),
          closed_at = COALESCE(closed_at, now()),
          prosecutor_approved = true,
          prosecutor_approved_at = COALESCE(prosecutor_approved_at, now()),
          updated_at = now()
      WHERE lower(case_number) = ${publication.case_number.toLowerCase()}
    `;
    return;
  }

  if (type === "approve_pgsko_by_message") {
    await sql`
      UPDATE pgsko_reports
      SET status = 'Зачтено',
          checked_by = ${clean(action.approvedByName)},
          checked_at = now()
      WHERE discord_message_id = ${clean(action.messageId)}
    `;
  }
}

export async function postActionToSql(action, meta, config, logger) {
  const sql = getSql(config);
  if (!sql || !action) return;
  try {
    switch (action.type) {
      case "append_active_case":
        await upsertAssignment(sql, action, meta);
        break;
      case "case_status_event":
        await applyCaseStatus(sql, action, meta);
        break;
      case "upsert_staff_rows":
        await upsertStaffRows(sql, action);
        break;
      case "discipline_event":
        await applyDiscipline(sql, action);
        break;
      case "staff_status_event":
        await applyStaffStatus(sql, action);
        break;
      default:
        await acknowledgeAction(sql, action);
        break;
    }
  } catch (error) {
    await markOutboxError(sql, action.queueId, error.message);
    logger.warn("SQL delivery failed", { error: error.message, actionType: action.type });
  }
}

export async function postMessageEventToSql(event, config, logger) {
  const sql = getSql(config);
  if (!sql) return;
  try {
    await saveRawMessage(sql, event);
    if (!event.sheetAction) return;
    const meta = {
      messageId: event.messageId,
      messageUrl: event.messageUrl,
      channelId: event.channelId,
      channel: event.channel,
      receivedAt: event.receivedAt,
      author: event.author,
    };
    await postActionToSql(event.sheetAction, meta, config, logger);
  } catch (error) {
    logger.warn("SQL message delivery failed", { error: error.message, messageId: event.messageId });
  }
}

async function buildJob(sql, event) {
  const payload = event.payload || {};
  if (event.event_type === "case_publish_requested") {
    return { id: event.id, type: "case", ...payload };
  }
  if (event.event_type === "pgsko_report_submitted") {
    const rows = await sql`SELECT * FROM pgsko_reports WHERE id = ${payload.reportId || ""} LIMIT 1`;
    const report = rows[0];
    if (!report) return null;
    return {
      id: event.id,
      type: "pgsko_report",
      reportId: report.id,
      submittedAt: report.submitted_at,
      investigatorName: report.investigator_fio,
      investigatorStatic: report.investigator_static,
      targetName: report.target_name,
      targetStatic: report.target_static,
      proofUrl: report.proof_url,
      comment: report.comment,
    };
  }
  if (event.event_type === "case_act_submitted") {
    const rows = await sql`SELECT * FROM case_acts WHERE id = ${payload.actId || ""} LIMIT 1`;
    const act = rows[0];
    if (!act) return null;
    return {
      id: event.id,
      type: "act_review",
      actId: act.id,
      submittedAt: act.submitted_at,
      investigator: act.investigator_fio,
      caseNumber: act.case_number,
      action: act.action,
      docUrl: act.doc_url,
      comment: act.comment,
    };
  }
  if (event.event_type === "case_act_decided") {
    const rows = await sql`SELECT * FROM case_acts WHERE id = ${payload.actId || ""} LIMIT 1`;
    const act = rows[0];
    if (!act) return null;
    return {
      id: event.id,
      type: "act_decided",
      actId: act.id,
      messageId: act.discord_message_id,
      investigator: act.investigator_fio,
      caseNumber: act.case_number,
      action: act.action,
      docUrl: act.doc_url,
      decision: payload.decision,
      status: act.status,
      decidedBy: act.decided_by,
      reason: act.reject_reason,
    };
  }
  return null;
}

export async function fetchPublishQueueFromSql(config, logger) {
  const sql = getSql(config);
  if (!sql) return null;
  try {
    const rows = await sql`
      SELECT *
      FROM outbox_events
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
    `;
    const jobs = [];
    for (const row of rows) {
      const job = await buildJob(sql, row);
      if (job) {
        jobs.push(job);
      } else {
        await markOutboxError(sql, row.id, `Unsupported or incomplete outbox event: ${row.event_type}`);
      }
    }
    return { ok: true, jobs, rosterMessageIds: [] };
  } catch (error) {
    logger.warn("Не удалось получить SQL-очередь публикаций", { error: error.message });
    return null;
  }
}
