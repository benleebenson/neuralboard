import assert from "node:assert/strict";
import test from "node:test";
import { groundProfileY, resolveCharacterSolidMotion } from "./terrain.ts";

const clips = [{ id: "image", type: "image", boardX: 100, boardY: 200, boardW: 300, boardH: 220 }];

test("image top remains standable all the way to its outer edges", () => {
  assert.equal(groundProfileY(clips, [], 100)?.y, 200);
  assert.equal(groundProfileY(clips, [], 400)?.y, 200);
});

test("character sweep stops at image side walls", () => {
  const result = resolveCharacterSolidMotion(
    clips,
    [],
    { x: 50, y: 330 },
    { x: 140, y: 330 },
  );
  assert.equal(result.hitX, true);
  assert.ok(result.x <= 78.1);
});

test("character sweep stops below an image instead of jumping through it", () => {
  const result = resolveCharacterSolidMotion(
    clips,
    [],
    { x: 250, y: 650 },
    { x: 250, y: 560 },
  );
  assert.equal(result.hitCeiling, true);
  assert.ok(result.y >= 618);
});
