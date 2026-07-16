import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publisher = fs.readFileSync(new URL("../src/publish/publisher.js", import.meta.url), "utf8");

test("publisher supports safe deletion jobs from the portal", () => {
  assert.match(publisher, /job\.type === "roster_delete"/);
  assert.match(publisher, /job\.type === "case_publications_delete"/);
  assert.match(publisher, /message\.author\?\.id !== client\.user\?\.id/);
  assert.match(publisher, /storedChannelId !== channelId/);
  assert.match(publisher, /type: "case_publications_deleted"/);
  assert.match(publisher, /discoveredCount: messageIds\.length/);
  assert.match(publisher, /if \(polling\) return/);
  assert.doesNotMatch(publisher, /channel\.messages\.fetch\(id\)\.catch\(\(\) => null\)/);
});
