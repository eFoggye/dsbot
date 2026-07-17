import assert from "node:assert/strict";
import test from "node:test";

import { pollOnce } from "../src/publish/publisher.js";

const logger = { info() {}, warn() {}, error() {} };

test("a missing publication channel is NACKed and is never acknowledged as success", async () => {
  const previous = process.env.REPORT_CHANNEL_ID;
  delete process.env.REPORT_CHANNEL_ID;
  const actions = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.op === "queue") {
      return {
        ok: true,status: 200,
        async json() { return { ok: true, result: { jobs: [{ id: "evt_report",type: "report",unit: "arbat",claimToken: "claim" }] } }; },
      };
    }
    actions.push(body.action);
    return { ok: true,status: 200,async json() { return { ok: true,result: {} }; } };
  };
  try {
    await pollOnce({ user: { id: "bot" },channels: { async fetch() { throw new Error("must not fetch"); } } }, {
      botUnit: "arbat",useApi: true,botApiUrl: "https://portal.invalid/api/bot",botApiSecret: "secret",httpTimeoutMs: 10,
    }, logger);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, "publication_failed");
    assert.equal(actions[0].queueId, "evt_report");
    assert.equal(actions[0].claimToken, "claim");
    assert.equal(actions[0].errorCode, "MISSING_PUBLICATION_CHANNEL");
    assert.ok(!actions.some((action) => action.type === "report_published"));
  } finally {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.REPORT_CHANNEL_ID;
    else process.env.REPORT_CHANNEL_ID = previous;
  }
});

test("an unknown publication job is explicitly NACKed", async () => {
  const actions = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.op === "queue") {
      return {
        ok: true,status: 200,
        async json() { return { ok: true,result: { jobs: [{ id: "evt_unknown",type: "future_type",unit: "arbat",claimToken: "claim" }] } }; },
      };
    }
    actions.push(body.action);
    return { ok: true,status: 200,async json() { return { ok: true,result: {} }; } };
  };
  try {
    await pollOnce({ user: { id: "bot" } }, {
      botUnit: "arbat",useApi: true,botApiUrl: "https://portal.invalid/api/bot",botApiSecret: "secret",httpTimeoutMs: 10,
    }, logger);
    assert.equal(actions[0]?.type, "publication_failed");
    assert.equal(actions[0]?.errorCode, "UNSUPPORTED_PUBLICATION_JOB");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("disabled PGSKO Discord closes a stale job without fetching a channel", async () => {
  const actions = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.op === "queue") {
      return {
        ok: true,status: 200,
        async json() {
          return {
            ok: true,
            result: {
              jobs: [{
                id: "evt_pgsko",type: "pgsko_report",unit: "arbat",
                reportId: "pgs_1",claimToken: "claim",
              }],
            },
          };
        },
      };
    }
    actions.push(body.action);
    return { ok: true,status: 200,async json() { return { ok: true,result: {} }; } };
  };
  try {
    await pollOnce({
      user: { id: "bot" },
      channels: { async fetch() { throw new Error("PGSKO channel must not be fetched"); } },
    }, {
      botUnit: "arbat",useApi: true,botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret",httpTimeoutMs: 10,pgskoDiscordEnabled: false,
    }, logger);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, "pgsko_discord_skipped");
    assert.equal(actions[0].reportId, "pgs_1");
    assert.equal(actions[0].claimToken, "claim");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
