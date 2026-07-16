const MARKER_PREFIX = "sledak-job:";
const MESSAGE_PAGE_SIZE = 100;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const CONTENT_LIMIT = 2000;
const EMBED_TOTAL_TEXT_LIMIT = 6000;

function text(value) {
  return String(value || "").trim();
}

export function publicationMarker(queueId) {
  const id = text(queueId);
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) throw new Error("Publication job has an invalid queue id");
  return `${MARKER_PREFIX}${id}`;
}

export function publicationQueueIdFromMessage(message) {
  const haystacks = [
    text(message?.content),
    ...Array.from(message?.embeds || []).map((embed) => text(embed?.footer?.text)),
  ];
  for (const value of haystacks) {
    const index = value.indexOf(MARKER_PREFIX);
    if (index < 0) continue;
    const match = value.slice(index + MARKER_PREFIX.length).match(/^[A-Za-z0-9_.:-]+/);
    if (match?.[0]) return match[0];
  }
  return "";
}

function clip(value, limit) {
  return String(value ?? "").slice(0, Math.max(0, limit));
}

function embedTextLength(embed) {
  return [
    embed?.title,
    embed?.description,
    embed?.footer?.text,
    embed?.author?.name,
    ...(embed?.fields || []).flatMap((field) => [field?.name, field?.value]),
  ].reduce((sum, value) => sum + String(value ?? "").length, 0);
}

/** Enforce Discord's documented message/embed limits before any network call. */
export function fitDiscordPayload(payload) {
  const next = { ...(payload || {}) };
  if (next.content !== undefined) next.content = clip(next.content, CONTENT_LIMIT);
  if (!Array.isArray(next.embeds)) return next;
  next.embeds = next.embeds.slice(0, 10).map((embed) => ({
    ...embed,
    title: embed?.title === undefined ? undefined : clip(embed.title, 256),
    description: embed?.description === undefined ? undefined : clip(embed.description, 4096),
    author: embed?.author ? { ...embed.author, name: clip(embed.author.name, 256) } : embed?.author,
    footer: embed?.footer ? { ...embed.footer, text: clip(embed.footer.text, 2048) } : embed?.footer,
    fields: Array.isArray(embed?.fields) ? embed.fields.slice(0, 25).map((field) => ({
      ...field,
      name: clip(field?.name, 256) || "—",
      value: clip(field?.value, 1024) || "—",
    })) : embed?.fields,
  }));

  let excess = next.embeds.reduce((sum, embed) => sum + embedTextLength(embed), 0) - EMBED_TOTAL_TEXT_LIMIT;
  if (excess <= 0) return next;
  // Footers contain the delivery key and are deliberately preserved. Trim the
  // variable business content first until the 6000-char aggregate limit fits.
  const shrink = (owner, key, minimum = 0) => {
    if (excess <= 0 || owner?.[key] === undefined) return;
    const current = String(owner[key] ?? "");
    const amount = Math.min(excess, Math.max(0, current.length - minimum));
    owner[key] = current.slice(0, current.length - amount) || (minimum ? "—" : "");
    excess -= amount;
  };
  for (let i = next.embeds.length - 1; i >= 0 && excess > 0; i -= 1) {
    const embed = next.embeds[i];
    for (let fieldIndex = (embed.fields || []).length - 1; fieldIndex >= 0 && excess > 0; fieldIndex -= 1) {
      shrink(embed.fields[fieldIndex], "value", 1);
      shrink(embed.fields[fieldIndex], "name", 1);
    }
    shrink(embed, "description", 1);
    shrink(embed, "title", 1);
    if (embed.author) shrink(embed.author, "name", 1);
  }
  // Extremely footer-heavy multi-embed payloads are not emitted by this bot,
  // but keep the generic guard valid while retaining any delivery marker.
  for (let i = next.embeds.length - 1; i >= 0 && excess > 0; i -= 1) {
    const footer = next.embeds[i].footer;
    if (!footer?.text) continue;
    const marker = String(footer.text).match(/sledak-job:[A-Za-z0-9_.:-]+/)?.[0] || "—";
    const removed = Math.max(0, String(footer.text).length - marker.length);
    if (removed <= 0) continue;
    footer.text = marker;
    excess = Math.max(0, excess - removed);
  }
  return next;
}

/**
 * Adds a durable, harmless delivery key to the Discord payload. Discord has no
 * transactional send+ACK primitive, so this marker is the source of truth when
 * a portal ACK is lost and an at-least-once queue job is delivered again.
 */
export function withPublicationMarker(payload, queueId) {
  const marker = publicationMarker(queueId);
  const next = {
    ...(payload || {}),
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };
  if (Array.isArray(payload?.embeds) && payload.embeds.length) {
    next.embeds = payload.embeds.map((embed, index) => {
      if (index !== 0) return { ...embed };
      const footer = embed?.footer || {};
      const previous = text(footer.text);
      const withoutOldMarker = previous.replace(/(?:\s*[·|]\s*)?sledak-job:[A-Za-z0-9_.:-]+/g, "").trim();
      const separator = withoutOldMarker ? " · " : "";
      const prefix = withoutOldMarker.slice(0, Math.max(0, 2048 - separator.length - marker.length));
      return {
        ...embed,
        footer: {
          ...footer,
          text: `${prefix}${prefix ? separator : ""}${marker}`,
        },
      };
    });
    return fitDiscordPayload(next);
  }
  const content = text(payload?.content);
  const withoutOldMarker = content.replace(/\n?-# sledak-job:[A-Za-z0-9_.:-]+\s*$/g, "").trimEnd();
  const markerLine = `-# ${marker}`;
  const separator = withoutOldMarker ? "\n" : "";
  const body = withoutOldMarker.slice(0, Math.max(0, CONTENT_LIMIT - separator.length - markerLine.length));
  next.content = `${body}${body ? separator : ""}${markerLine}`;
  return fitDiscordPayload(next);
}

function collectionLast(collection) {
  if (typeof collection?.last === "function") return collection.last();
  const values = [...(collection?.values?.() || [])];
  return values[values.length - 1];
}

function isUnknownMessage(error) {
  return String(error?.code || "") === "10008";
}

async function deleteDuplicate(message) {
  try {
    await message.delete();
  } catch (error) {
    if (!isUnknownMessage(error)) throw error;
  }
}

/** Scan only the time range in which this job could have created a message. */
export async function findPublicationMessages(channel, botUserId, job) {
  const markerId = text(job?.id);
  if (!markerId) return [];
  const createdAt = new Date(job?.createdAt || job?.intentAt || 0).getTime();
  const minTimestamp = Number.isFinite(createdAt) && createdAt > 0
    ? createdAt - CLOCK_SKEW_MS
    : 0;
  const found = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: MESSAGE_PAGE_SIZE, before });
    if (!batch?.size) break;
    let reachedPastWindow = false;
    for (const message of batch.values()) {
      const timestamp = Number(message?.createdTimestamp || 0);
      if (minTimestamp && timestamp && timestamp < minTimestamp) {
        reachedPastWindow = true;
        continue;
      }
      if (message?.author?.id === botUserId && publicationQueueIdFromMessage(message) === markerId) {
        found.push(message);
      }
    }
    before = collectionLast(batch)?.id;
    if (reachedPastWindow || batch.size < MESSAGE_PAGE_SIZE || !before) break;
  }
  return found.sort((left, right) => Number(left.createdTimestamp || 0) - Number(right.createdTimestamp || 0));
}

/**
 * Idempotent Discord create. If send succeeded but ACK did not, replay edits the
 * already marked message and removes any same-job duplicates instead of sending.
 */
export async function publishOnce(channel, botUserId, job, payload) {
  const marked = withPublicationMarker(payload, job.id);
  const existing = await findPublicationMessages(channel, botUserId, job);
  let message = existing[0] || null;
  if (message) {
    try {
      message = await message.edit(marked);
    } catch (error) {
      if (!isUnknownMessage(error)) throw error;
      message = null;
    }
  }
  if (!message) message = await channel.send(marked);
  for (const duplicate of existing.slice(1)) await deleteDuplicate(duplicate);
  return {
    message,
    reused: existing.length > 0,
    deletedDuplicates: Math.max(0, existing.length - 1),
  };
}
