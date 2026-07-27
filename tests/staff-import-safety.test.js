import assert from "node:assert/strict";
import test from "node:test";

import { parseStaff } from "../src/parsers/staffParser.js";

function eventFor(content) {
  return {
    cleanContent: "Руководство ГСУ СК России по АФО:\n@[⚡️] Заместитель руководителя - @Шиммер",
    content,
    createdAt: new Date().toISOString(),
    channel: { name: "состав-ск" },
    member: { displayName: "Руководитель" },
    author: { username: "leader" },
    messageUrl: "https://discord.invalid/message",
    roleMentions: [{ id: "10", name: "[⚡️] Заместитель руководителя ГСУ СК России" }],
    mentions: [{ id: "20", displayName: "Шиммер Георгий Карлович" }],
    embeds: [],
  };
}

test("legacy leadership roster resolves to the portal department and normalizes ppk", () => {
  const action = parseStaff(eventFor(
    "Руководство ГСУ СК России по АФО:\n<@&10> - <@20> [<:ppk:30>]",
  ));
  assert.equal(action.type, "upsert_staff_rows");
  assert.equal(action.rows.length, 1);
  assert.deepEqual(action.rows[0], {
    "ФИО": "Шиммер Георгий Карлович",
    "Звание": "Подполковник",
    "Должность": "[⚡️] Заместитель руководителя ГСУ СК России",
    "Отдел": "Аппарат руководителя ГСУ СК России",
    "Подразделение": "Аппарат руководителя ГСУ СК России",
    "Подотдел": "Руководство",
    "Группа": "Руководство",
    "Статус": "Активен",
  });
});
