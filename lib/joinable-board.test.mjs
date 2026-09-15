import test from "node:test";
import assert from "node:assert/strict";
import { generateJoinCode, normalizeJoinCode, validJoinCode } from "./joinable-board.ts";

test("join codes normalize for easy entry across devices", () => {
  assert.equal(normalizeJoinCode(" ab-c 12!3 "), "ABC123");
  assert.equal(validJoinCode("ABC123"), true);
  assert.equal(validJoinCode("ABC12"), false);
});

test("generated join codes are six unambiguous characters", () => {
  for (let index = 0; index < 100; index++) assert.match(generateJoinCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});
