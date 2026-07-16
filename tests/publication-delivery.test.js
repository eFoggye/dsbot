import assert from "node:assert/strict";
import test from "node:test";

import {
  fitDiscordPayload,
  publicationQueueIdFromMessage,
  publishOnce,
  withPublicationMarker,
} from "../src/publish/publicationDelivery.js";

function collection(messages) {
  const value = new Map(messages.map((message) => [message.id, message]));
  value.last = () => messages[messages.length - 1];
  return value;
}

function mockChannel() {
  const stored = [];
  let sends = 0;
  const makeMessage = (id, payload, createdTimestamp = Date.now()) => ({
    id,
    channelId: "channel-1",
    author: { id: "bot" },
    createdTimestamp,
    content: payload.content || "",
    embeds: payload.embeds || [],
    edits: 0,
    deletions: 0,
    async edit(next) {
      this.content = next.content || "";
      this.embeds = next.embeds || [];
      this.edits += 1;
      return this;
    },
    async delete() { this.deletions += 1; },
  });
  return {
    stored,
    get sends() { return sends; },
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") {
          const found = stored.find((message) => message.id === arg);
          if (!found) throw Object.assign(new Error("Unknown Message"), { code: "10008" });
          return found;
        }
        const ordered = [...stored].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        const beforeIndex = arg?.before ? ordered.findIndex((message) => message.id === arg.before) + 1 : 0;
        return collection(ordered.slice(beforeIndex, beforeIndex + Number(arg?.limit || 100)));
      },
    },
    async send(payload) {
      sends += 1;
      const message = makeMessage(`sent-${sends}`, payload, Date.now() + sends);
      stored.push(message);
      return message;
    },
    add(id, payload, timestamp) {
      const message = makeMessage(id, payload, timestamp);
      stored.push(message);
      return message;
    },
  };
}

test("lost portal ACK reuses the marked Discord message instead of sending twice", async () => {
  const channel = mockChannel();
  const job = { id: "evt_case_123", createdAt: new Date(Date.now() - 1000).toISOString() };
  const payload = { embeds: [{ title: "Case", footer: { text: "footer" } }], allowedMentions: { parse: [] } };

  const first = await publishOnce(channel, "bot", job, payload);
  const replay = await publishOnce(channel, "bot", job, payload);

  assert.equal(channel.sends, 1);
  assert.equal(replay.reused, true);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(publicationQueueIdFromMessage(replay.message), job.id);
});

test("plain-content publications carry the same durable delivery key", () => {
  const marked = withPublicationMarker({ content: "KSO task", allowedMentions: { parse: [] } }, "evt_kso_1");
  assert.match(marked.content, /sledak-job:evt_kso_1/);
  assert.equal(publicationQueueIdFromMessage({ content: marked.content, embeds: [] }), "evt_kso_1");
});

test("same-job Discord duplicates are collapsed during replay", async () => {
  const channel = mockChannel();
  const job = { id: "evt_report_1", createdAt: new Date(Date.now() - 1000).toISOString() };
  const payload = { embeds: [{ title: "Report" }] };
  const marked = withPublicationMarker(payload, job.id);
  const first = channel.add("old-1", marked, Date.now());
  const duplicate = channel.add("old-2", marked, Date.now() + 1);

  const result = await publishOnce(channel, "bot", job, payload);

  assert.equal(channel.sends, 0);
  assert.equal(result.message.id, first.id);
  assert.equal(duplicate.deletions, 1);
});

test("oversized publication payloads fit Discord limits without losing the delivery key", () => {
  const fields = Array.from({ length: 30 }, (_, index) => ({
    name: `field-${index}-${"n".repeat(400)}`,
    value: "v".repeat(2000),
  }));
  const marked = withPublicationMarker({
    content: "c".repeat(3000),
    embeds: [{
      title: "t".repeat(400),
      description: "d".repeat(5000),
      fields,
      footer: { text: "f".repeat(2500) },
    }],
  }, "evt_large_1");
  const fitted = fitDiscordPayload(marked);
  const embed = fitted.embeds[0];
  const total = [embed.title, embed.description, embed.footer?.text,
    ...(embed.fields || []).flatMap((field) => [field.name, field.value])]
    .reduce((sum, value) => sum + String(value || "").length, 0);
  assert.ok(fitted.content.length <= 2000);
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.name.length >= 1 && field.name.length <= 256
    && field.value.length >= 1 && field.value.length <= 1024));
  assert.ok(total <= 6000);
  assert.equal(publicationQueueIdFromMessage({ content: fitted.content, embeds: fitted.embeds }), "evt_large_1");
});
