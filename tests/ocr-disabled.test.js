import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "BOT_API_URL",
  "BOT_API_SECRET",
  "BOT_UNIT",
  "OCR_ENABLED",
  "OCR_API_KEY",
  "ANTHROPIC_API_KEY",
];

async function withEnvironment(overrides, callback) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    DISCORD_BOT_TOKEN: "test-token",
    BOT_API_URL: "https://example.test/api/bot",
    BOT_API_SECRET: "test-secret",
    BOT_UNIT: "arbat",
    ...overrides,
  });

  try {
    return await callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("OCR remains disabled by default even when an API key exists", async () => {
  await withEnvironment({ OCR_API_KEY: "configured-key" }, () => {
    const config = loadConfig({ requireRuntime: true });
    assert.equal(config.ocrEnabled, false);
    assert.equal(config.ocrApiKey, "configured-key");
  });
});

test("OCR requires both explicit opt-in and an API key", async () => {
  await withEnvironment({ OCR_ENABLED: "true" }, () => {
    assert.throws(
      () => loadConfig({ requireRuntime: true }),
      /OCR_ENABLED=true requires OCR_API_KEY/,
    );
  });

  await withEnvironment({ OCR_ENABLED: "true", OCR_API_KEY: "configured-key" }, () => {
    assert.equal(loadConfig({ requireRuntime: true }).ocrEnabled, true);
  });
});

test("message processing checks the explicit OCR switch", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(config\.ocrEnabled && config\.ocrApiKey && event\.sheetAction\?\.type === "internal_order_needs_ocr"\)/,
  );
});
