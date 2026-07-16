import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteRosterMessages,
  discoverRosterMessages,
  reconcileRosterMessages,
  selectRosterMessageIds,
} from "../src/publish/rosterReconciler.js";

function payload(title) {
  return { embeds: [{ title, description: "updated" }], allowedMentions: { parse: [] } };
}

function mockMessage(id, title, { authorId = "bot", createdTimestamp = Number(id) || 1 } = {}) {
  return {
    id: String(id),
    author: { id: authorId },
    embeds: [{ title }],
    createdTimestamp,
    edits: 0,
    deletions: 0,
    async edit(next) {
      this.edits += 1;
      this.embeds = next.embeds;
      return this;
    },
    async delete() {
      this.deletions += 1;
    },
  };
}

function mockCollection(messages) {
  const collection = new Map(messages.map((message) => [message.id, message]));
  collection.last = () => messages[messages.length - 1];
  return collection;
}

function mockChannel(initial = []) {
  const messagesById = new Map(initial.map((message) => [message.id, message]));
  const sent = [];
  return {
    sent,
    messagesById,
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") {
          const message = messagesById.get(arg);
          if (!message) throw Object.assign(new Error("Unknown Message"), { code: "10008" });
          return message;
        }
        return mockCollection([...messagesById.values()]);
      },
    },
    async send(next) {
      const message = mockMessage(`new-${sent.length + 1}`, next.embeds[0].title, {
        createdTimestamp: Date.now() + sent.length,
      });
      message.embeds = next.embeds;
      messagesById.set(message.id, message);
      sent.push(message);
      return message;
    },
  };
}

test("the unit-filtered direct roster ids win over the obsolete per-unit shape", () => {
  assert.deepEqual(selectRosterMessageIds({
    rosterMessageIds: ["current-1", "current-2"],
    rosterMessageIdsByUnit: { arbat: [] },
  }, "arbat"), ["current-1", "current-2"]);
  assert.deepEqual(selectRosterMessageIds({
    rosterMessageIdsByUnit: { arbat: ["legacy"] },
  }, "arbat"), ["legacy"]);
});

test("reconciliation reuses one roster card per section and deletes duplicates", async () => {
  const first = mockMessage("101", "A", { createdTimestamp: 101 });
  const duplicate = mockMessage("102", "A", { createdTimestamp: 102 });
  const second = mockMessage("103", "B", { createdTimestamp: 103 });
  const channel = mockChannel([first, duplicate, second]);

  const result = await reconcileRosterMessages(channel, "bot", [payload("A"), payload("B")], [first.id, second.id]);

  assert.deepEqual(result.messageIds, [first.id, second.id]);
  assert.equal(result.created, 0);
  assert.equal(result.edited, 2);
  assert.equal(result.deletedDuplicates, 1);
  assert.equal(duplicate.deletions, 1);
  assert.equal(channel.sent.length, 0);
});

test("a repeated job after a lost acknowledgement does not send a second roster", async () => {
  const channel = mockChannel();
  const payloads = [payload("A"), payload("B")];

  const first = await reconcileRosterMessages(channel, "bot", payloads, []);
  const second = await reconcileRosterMessages(channel, "bot", payloads, []);

  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.edited, 2);
  assert.equal(channel.sent.length, 2);
  assert.deepEqual(second.messageIds, first.messageIds);
});

test("roster discovery and purge ignore foreign and unrelated bot messages", async () => {
  const roster = mockMessage("201", "A");
  const foreignRoster = mockMessage("202", "A", { authorId: "someone-else" });
  const unrelatedBotMessage = mockMessage("203", "Not roster");
  const channel = mockChannel([roster, foreignRoster, unrelatedBotMessage]);
  const payloads = [payload("A"), payload("B")];

  const found = await discoverRosterMessages(channel, "bot", payloads, { scanPages: 3 });
  const result = await deleteRosterMessages(channel, "bot", payloads, [], { purge: true, purgeMaxAgeMs: Number.MAX_SAFE_INTEGER });

  assert.deepEqual([...found.keys()], [roster.id]);
  assert.deepEqual(result.messageIds, [roster.id]);
  assert.equal(roster.deletions, 1);
  assert.equal(foreignRoster.deletions, 0);
  assert.equal(unrelatedBotMessage.deletions, 0);
});

test("an explicitly tracked roster message is deleted even when it is older than the purge window", async () => {
  const oldTracked = mockMessage("301", "A", { createdTimestamp: 1 });
  const channel = mockChannel([oldTracked]);
  const result = await deleteRosterMessages(channel, "bot", [payload("A")], [oldTracked.id], {
    purge: true,
    purgeMaxAgeMs: 1,
  });

  assert.deepEqual(result.messageIds, [oldTracked.id]);
  assert.equal(oldTracked.deletions, 1);
});

test("a transient Discord read failure aborts reconciliation instead of creating another roster", async () => {
  const channel = mockChannel();
  channel.messages.fetch = async () => {
    throw Object.assign(new Error("Discord temporarily unavailable"), { code: "ECONNRESET" });
  };

  await assert.rejects(
    reconcileRosterMessages(channel, "bot", [payload("A")], []),
    /temporarily unavailable/,
  );
  assert.equal(channel.sent.length, 0);
});
