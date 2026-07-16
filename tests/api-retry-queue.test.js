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
