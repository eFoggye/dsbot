const DEFAULT_SCAN_PAGES = Number.POSITIVE_INFINITY;

function text(value) {
  return String(value || "").trim();
}

export function rosterPayloadTitle(payload) {
  return text(payload?.embeds?.[0]?.title);
}

export function rosterMessageTitle(message) {
  return text(message?.embeds?.[0]?.title);
}

export function rosterBaseTitle(value) {
  return text(value).replace(/\s+\(\d+\/\d+\)$/, "");
}

// Текущий API отдаёт уже отфильтрованный список rosterMessageIds. Старый
// rosterMessageIdsByUnit поддерживаем только как fallback для совместимости.
export function selectRosterMessageIds(queue, unit) {
  if (Array.isArray(queue?.rosterMessageIds)) {
    return queue.rosterMessageIds.map(String).filter(Boolean);
  }
  const legacy = queue?.rosterMessageIdsByUnit?.[String(unit || "")];
  return Array.isArray(legacy) ? legacy.map(String).filter(Boolean) : [];
}

function isUnknownMessage(error) {
  return String(error?.code || "") === "10008";
}

async function fetchTrackedMessage(channel, id) {
  try {
    return await channel.messages.fetch(id);
  } catch (error) {
    // Удалённый вручную Discord message — штатное отсутствие. Любая другая
    // ошибка (нет прав, rate limit, сеть) должна сорвать job: иначе пустой
    // результат чтения будет ошибочно принят за повод создать новые карточки.
    if (isUnknownMessage(error)) return null;
    throw error;
  }
}

function collectionLast(collection) {
  if (typeof collection?.last === "function") return collection.last();
  const values = [...(collection?.values?.() || [])];
  return values[values.length - 1];
}

/**
 * Возвращает только принадлежащие текущему боту сообщения с точными заголовками
 * секций состава. Благодаря этому очистка не затронет другие публикации даже в
 * случае, если канал когда-нибудь начнут использовать не только для состава.
 */
export async function discoverRosterMessages(channel, botUserId, payloads, {
  trackedIds = [],
  scanPages = DEFAULT_SCAN_PAGES,
  minCreatedAt = 0,
} = {}) {
  const expectedTitles = new Set(payloads.map(rosterPayloadTitle).filter(Boolean));
  const expectedBaseTitles = new Set([...expectedTitles].map(rosterBaseTitle));
  const found = new Map();

  const add = (message, enforceAge = false) => {
    if (!message?.id || message.author?.id !== botUserId) return;
    if (!expectedBaseTitles.has(rosterBaseTitle(rosterMessageTitle(message)))) return;
    if (enforceAge && minCreatedAt && Number(message.createdTimestamp || 0) < minCreatedAt) return;
    found.set(String(message.id), message);
  };

  for (const id of [...new Set(trackedIds.map(String).filter(Boolean))]) {
    const message = await fetchTrackedMessage(channel, id);
    add(message, false);
  }

  let before;
  for (let page = 0; page < scanPages; page += 1) {
    // Пакетный fetch намеренно fail-closed: при временной ошибке нельзя считать
    // канал пустым и отправлять ещё один комплект состава.
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch?.size) break;
    for (const message of batch.values()) add(message, true);
    before = collectionLast(batch)?.id;
    if (batch.size < 100 || !before) break;
  }

  return found;
}

function byPreference(trackedOrder) {
  return (left, right) => {
    const leftTracked = trackedOrder.has(String(left.id));
    const rightTracked = trackedOrder.has(String(right.id));
    if (leftTracked !== rightTracked) return leftTracked ? -1 : 1;
    if (leftTracked) return trackedOrder.get(String(left.id)) - trackedOrder.get(String(right.id));
    return Number(right.createdTimestamp || 0) - Number(left.createdTimestamp || 0);
  };
}

async function deleteMessage(message) {
  try {
    await message.delete();
    return true;
  } catch (error) {
    if (isUnknownMessage(error)) return false;
    throw error;
  }
}

/**
 * Приводит канал к единственному каноническому набору карточек состава:
 * одна карточка на каждую секцию, в порядке payloads. Это делает публикацию
 * идемпотентной даже при потере ACK после Discord send и при пустой таблице
 * roster_publications на портале.
 */
export async function reconcileRosterMessages(channel, botUserId, payloads, trackedIds = []) {
  const candidates = await discoverRosterMessages(channel, botUserId, payloads, {
    trackedIds,
    scanPages: DEFAULT_SCAN_PAGES,
  });
  const trackedOrder = new Map(trackedIds.map((id, index) => [String(id), index]));
  const preferred = byPreference(trackedOrder);
  const newIds = [];
  let created = 0;
  let edited = 0;
  let deletedDuplicates = 0;

  for (const payload of payloads) {
    const title = rosterPayloadTitle(payload);
    if (!title) throw new Error("Карточка состава не содержит заголовок секции");
    const baseTitle = rosterBaseTitle(title);
    const matching = [...candidates.values()]
      .filter((message) => rosterBaseTitle(rosterMessageTitle(message)) === baseTitle)
      .sort((left, right) => {
        const leftExact = rosterMessageTitle(left) === title;
        const rightExact = rosterMessageTitle(right) === title;
        if (leftExact !== rightExact) return leftExact ? -1 : 1;
        return preferred(left, right);
      });

    let primary = matching[0] || null;
    if (primary) {
      try {
        await primary.edit(payload);
        edited += 1;
      } catch (error) {
        if (!isUnknownMessage(error)) throw error;
        candidates.delete(String(primary.id));
        primary = null;
      }
    }
    if (!primary) {
      primary = await channel.send(payload);
      created += 1;
    }
    newIds.push(String(primary.id));
    candidates.delete(String(primary.id));
  }

  // Всё, что осталось с каноническим base-title, — лишняя старая карточка:
  // дубль либо устаревший chunk после уменьшения раздела.
  for (const duplicate of candidates.values()) {
    if (await deleteMessage(duplicate)) deletedDuplicates += 1;
  }

  return { messageIds: newIds, created, edited, deletedDuplicates };
}

export async function deleteRosterMessages(channel, botUserId, payloads, trackedIds, {
  purge = false,
  purgeMaxAgeMs = Number.POSITIVE_INFINITY,
} = {}) {
  const found = await discoverRosterMessages(channel, botUserId, payloads, {
    trackedIds,
    scanPages: purge ? DEFAULT_SCAN_PAGES : 0,
    minCreatedAt: purge && Number.isFinite(purgeMaxAgeMs) ? Date.now() - purgeMaxAgeMs : 0,
  });
  let deleted = 0;
  for (const message of found.values()) {
    if (await deleteMessage(message)) deleted += 1;
  }
  return { messageIds: [...found.keys()], deleted };
}
