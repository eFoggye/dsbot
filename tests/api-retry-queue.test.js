import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fetchPublishQueueFromApi, flushApiRetryQueue } from "../src/sinks/botApiSink.js";

const logger = { info() {}, warn() {}, error() {} };

test("retry flush preserves every valid entry when the API is unavailable", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "sledak-retry-"));
  const file = path.join(outputDir, "retry-queue.ndjson");
  const lines = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    queuedAt: Date.now() - index,
    body: { op: "action", action: { type: "test", index } },
  }));
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() { return { ok: false, error: "offline" }; },
  });
  try {
    await flushApiRetryQueue({
      useApi: true,
      outputDir,
      botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret",
      botUnit: "arbat",
      httpTimeoutMs: 10,
    }, logger);
    const remaining = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.equal(remaining.length, 600);
    assert.deepEqual(remaining, lines);
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("queue polling advertises the lease protocol and deployed release", async () => {
  let requestBody;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: { jobs: [] } }; },
    };
  };
  try {
    const result = await fetchPublishQueueFromApi({
      useApi: true,
      outputDir: os.tmpdir(),
      botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret",
      botUnit: "arbat",
      appRelease: "abc123",
      httpTimeoutMs: 10,
    }, logger, "arbat");
    assert.deepEqual(result, { jobs: [] });
    assert.equal(requestBody.protocolVersion, 2);
    assert.equal(requestBody.appRelease, "abc123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("disabled staff import removes a queued roster mutation without calling the API", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "sledak-retry-staff-"));
  const file = path.join(outputDir, "retry-queue.ndjson");
  const entry = {
    queuedAt: Date.now(),
    body: {
      op: "message_event",
      event: {
        receivedAt: new Date().toISOString(),
        sheetAction: { type: "upsert_staff_rows", rows: [{ "ФИО": "Тест Тестович" }] },
      },
    },
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`);
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not be called"); };
  try {
    await flushApiRetryQueue({
      useApi: true,
      outputDir,
      botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret",
      botUnit: "arbat",
      staffImportEnabled: false,
    }, logger);
    assert.equal(await fs.readFile(file, "utf8"), "");
    assert.equal(calls, 0);
    const deadLetter = await fs.readFile(path.join(outputDir, "retry-dead-letter.ndjson"), "utf8");
    assert.match(deadLetter, /staff_import_disabled/);
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("staff retry older than ten minutes is terminal even when import is enabled", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "sledak-retry-stale-staff-"));
  const file = path.join(outputDir, "retry-queue.ndjson");
  const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await fs.writeFile(file, `${JSON.stringify({
    queuedAt: Date.parse(stale),
    body: { op: "message_event", event: { receivedAt: stale, sheetAction: { type: "upsert_staff_rows" } } },
  })}\n`);
  try {
    await flushApiRetryQueue({
      useApi: true,
      outputDir,
      botApiUrl: "https://portal.invalid/api/bot",
      botApiSecret: "secret",
      botUnit: "arbat",
      staffImportEnabled: true,
    }, logger);
    assert.equal(await fs.readFile(file, "utf8"), "");
    assert.match(await fs.readFile(path.join(outputDir, "retry-dead-letter.ndjson"), "utf8"), /stale_staff_import/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
