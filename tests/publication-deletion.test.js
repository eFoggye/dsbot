import assert from "node:assert/strict";
import test from "node:test";

import { deleteCasePublications, editActDecision } from "../src/publish/publisher.js";
import { publicationQueueIdFromMessage, withPublicationMarker } from "../src/publish/publicationDelivery.js";

const logger = { info() {}, warn() {}, error() {} };

function collection(messages) {
  const result = new Map(messages.map((message) => [message.id, message]));
  result.last = () => messages[messages.length - 1];
  return result;
}

function caseChannel(message) {
  return {
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") {
          if (arg === message.id) return message;
          throw Object.assign(new Error("Unknown Message"), { code: "10008" });
        }
        return collection(message.deleted ? [] : [message]);
      },
    },
  };
}

test("case deletion discovers an in-flight publication by queue marker and ACKs its claim", async () => {
  const previousChannel = process.env.CASES_CHANNEL_ID;
  process.env.CASES_CHANNEL_ID = "123456789012345678";
  const payload = withPublicationMarker({ embeds: [{ title: "Case" }] }, "evt_publish_1");
  const message = {
    id: "987654321098765432",
    author: { id: "bot" },
    createdTimestamp: Date.now(),
    content: payload.content || "",
    embeds: payload.embeds,
    deleted: false,
    async delete() { this.deleted = true; },
  };
  const channel = caseChannel(message);
  const client = { user: { id: "bot" }, channels: { async fetch() { return channel; } } };
  let acknowledged;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    acknowledged = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { ok: true, result: {} }; } };
  };
  try {
    await deleteCasePublications(client, {
      id: "evt_delete_1",
      claimToken: "claim-1",
      unit: "arbat",
      publications: [],
      publicationJobs: [{ id: "evt_publish_1", createdAt: new Date(Date.now() - 1000).toISOString() }],
    }, {
      botUnit: "arbat", useApi: true, botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret", httpTimeoutMs: 10,
    }, logger);
    assert.equal(message.deleted, true);
    assert.equal(acknowledged.action.type, "case_publications_deleted");
    assert.equal(acknowledged.action.claimToken, "claim-1");
    assert.deepEqual(acknowledged.action.messageIds, [message.id]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousChannel === undefined) delete process.env.CASES_CHANNEL_ID;
    else process.env.CASES_CHANNEL_ID = previousChannel;
  }
});

test("case deletion refuses a portal-supplied channel outside the local allowlist", async () => {
  const previousChannel = process.env.CASES_CHANNEL_ID;
  process.env.CASES_CHANNEL_ID = "123456789012345678";
  try {
    await assert.rejects(
      deleteCasePublications({ user: { id: "bot" }, channels: { async fetch() { throw new Error("not reached"); } } }, {
        id: "evt_delete_2",claimToken: "claim-2",unit: "arbat",
        publications: [{ messageId: "1", channelId: "999999999999999999" }],
      }, { botUnit: "arbat" }, logger),
      /CASES_LEGACY_CHANNEL_IDS/,
    );
  } finally {
    if (previousChannel === undefined) delete process.env.CASES_CHANNEL_ID;
    else process.env.CASES_CHANNEL_ID = previousChannel;
  }
});

test("act decision without a materialized message id finds the review card marker and edits before ACK", async () => {
  const previousChannel = process.env.ACT_REVIEW_CHANNEL_ID;
  process.env.ACT_REVIEW_CHANNEL_ID = "222222222222222222";
  const initial = withPublicationMarker({ embeds: [{ title: "На рассмотрении", footer: { text: "act" } }] }, "evt_act_review");
  const message = {
    id: "333333333333333333",
    author: { id: "bot" },
    createdTimestamp: Date.now(),
    content: "",
    embeds: initial.embeds,
    async edit(payload) { this.embeds = payload.embeds; this.content = payload.content || ""; return this; },
  };
  const channel = {
    messages: {
      async fetch(arg) {
        if (typeof arg === "string") throw Object.assign(new Error("Unknown Message"), { code: "10008" });
        return collection([message]);
      },
    },
  };
  const client = { user: { id: "bot" }, channels: { async fetch() { return channel; } } };
  let acknowledged;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    acknowledged = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { ok: true, result: {} }; } };
  };
  try {
    await editActDecision(client, {
      id: "evt_act_decision",claimToken: "claim-decision",unit: "arbat",actId: "act-1",
      publicationQueueId: "evt_act_review",publicationCreatedAt: new Date(Date.now() - 1000).toISOString(),
      decision: "Одобрено",status: "Одобрено",investigator: "Иванов",caseNumber: "02-СК-1",action: "Возбуждение",
    }, {
      botUnit: "arbat",useApi: true,botApiUrl: "https://portal.invalid/api/bot",botApiSecret: "secret",httpTimeoutMs: 10,
    }, logger);
    assert.equal(message.embeds[0].title, "✅ Акт одобрен");
    assert.equal(publicationQueueIdFromMessage(message), "evt_act_review");
    assert.equal(acknowledged.action.type, "act_decided_done");
    assert.equal(acknowledged.action.claimToken, "claim-decision");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousChannel === undefined) delete process.env.ACT_REVIEW_CHANNEL_ID;
    else process.env.ACT_REVIEW_CHANNEL_ID = previousChannel;
  }
});
