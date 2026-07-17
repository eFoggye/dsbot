import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { preflightPublicationChannels } from "../src/publish/publisher.js";

test("PGSKO Discord defaults to disabled", () => {
  const previous = process.env.PGSKO_DISCORD_ENABLED;
  delete process.env.PGSKO_DISCORD_ENABLED;
  try {
    assert.equal(loadConfig({ requireRuntime: false }).pgskoDiscordEnabled, false);
    process.env.PGSKO_DISCORD_ENABLED = "true";
    assert.equal(loadConfig({ requireRuntime: false }).pgskoDiscordEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.PGSKO_DISCORD_ENABLED;
    else process.env.PGSKO_DISCORD_ENABLED = previous;
  }
});

test("Arbat preflight does not require PGSKO or KSO channels when disabled", async () => {
  const previousReport = process.env.REPORT_CHANNEL_ID;
  process.env.REPORT_CHANNEL_ID = "123456789012345678";
  const errors = [];
  const logger = { info() {}, warn() {}, error(message, meta) { errors.push({ message, meta }); } };
  const client = {
    user: { id: "bot" },
    channels: {
      async fetch() {
        return { permissionsFor() { return { has() { return true; } }; } };
      },
    },
  };
  try {
    await preflightPublicationChannels(client, {
      botUnit: "arbat",
      pgskoDiscordEnabled: false,
    }, logger);
    assert.ok(!errors.some(({ meta }) => meta?.envName === "PGSKO_REPORT_CHANNEL_ID"));
    assert.ok(!errors.some(({ meta }) => meta?.envName === "KSO_TASKS_CHANNEL_ID"));
  } finally {
    if (previousReport === undefined) delete process.env.REPORT_CHANNEL_ID;
    else process.env.REPORT_CHANNEL_ID = previousReport;
  }
});
