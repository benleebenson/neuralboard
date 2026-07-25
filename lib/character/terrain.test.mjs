import assert from "node:assert/strict";
import test from "node:test";
import { groundProfileY, resolveCharacterSolidMotion, resolveGroundedCharacterMotion } from "./terrain.ts";

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

test("grounded character follows its crater floor instead of sticking on the curved rim", () => {
  const crater = [{ clipId: "image", cx: 150, cy: 0, r: 80 }];
  const from = { x: 294, y: groundProfileY(clips, crater, 294).y };
  const targetX = 330;
  const result = resolveGroundedCharacterMotion(clips, crater, from, targetX, "image");
  assert.equal(result.hitX, false);
  assert.equal(result.x, targetX);
  assert.equal(result.y, groundProfileY(clips, crater, targetX).y);
});

test("ground following still respects a different image wall", () => {
  const wall = { id: "wall", type: "image", boardX: 171, boardY: 40, boardW: 120, boardH: 380 };
  const result = resolveGroundedCharacterMotion(
    [...clips, wall],
    [],
    { x: 145, y: 200 },
    180,
    "image",
  );
  assert.equal(result.hitX, true);
  assert.ok(result.x < 150);
});
