import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { publisherPollDelay } from "../src/publish/publisher.js";

test("publisher backs off while idle and becomes responsive after finding work", () => {
  const config = loadConfig({ requireRuntime: false });
  assert.equal(config.publisherActivePollMs, 30_000);
  assert.equal(config.publisherIdlePollMs, 15 * 60_000);
  assert.equal(config.apiRetryBackoffMs, 15 * 60_000);
  assert.equal(publisherPollDelay(0, config), 15 * 60_000);
  assert.equal(publisherPollDelay(2, config), 30_000);
});

test("unsafe sub-five-minute idle polling is clamped", () => {
  const previous = process.env.PUBLISH_IDLE_POLL_MS;
  process.env.PUBLISH_IDLE_POLL_MS = "1000";
  try {
    const config = loadConfig({ requireRuntime: false });
    assert.equal(config.publisherIdlePollMs, 5 * 60_000);
  } finally {
    if (previous === undefined) delete process.env.PUBLISH_IDLE_POLL_MS;
    else process.env.PUBLISH_IDLE_POLL_MS = previous;
  }
});
