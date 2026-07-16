import assert from "node:assert/strict";
import test from "node:test";

import {
  positionRoleIdsForUnit,
  publicationChannelsForUnit,
  rankEmojiMapForUnit,
} from "../src/publish/publishConfig.js";

test("non-Arbat units never inherit Arbat publication channels, roles or emojis", () => {
  const keys = [
    "CASES_CHANNEL_ID","TVERSKOY_CASES_CHANNEL_ID","POSITION_ROLE_IDS_JSON",
    "TVERSKOY_POSITION_ROLE_IDS_JSON","RANK_EMOJI_JSON","TVERSKOY_RANK_EMOJI_JSON",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  try {
    assert.ok(publicationChannelsForUnit("arbat").cases);
    assert.equal(publicationChannelsForUnit("tverskoy").cases, "");
    assert.deepEqual(positionRoleIdsForUnit("tverskoy"), {});
    assert.deepEqual(rankEmojiMapForUnit("tverskoy"), {});
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
