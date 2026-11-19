import test from "node:test";
import assert from "node:assert/strict";
import { penPathCommands, penSvgPath, tracePenPath } from "./board2/pen-path.ts";

const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }];

test("a pen stroke is one path from its first point to its last, with no gaps", () => {
  const commands = penPathCommands(pts);
  assert.deepEqual(commands[0], { op: "M", x: 0, y: 0 });
  assert.deepEqual(commands.at(-1), { op: "L", x: 30, y: 10 });
  // Every piece starts where the one before it ended (canvas/SVG continue from the current point).
  const ends = commands.map((c) => [c.x, c.y]);
  assert.deepEqual(ends, [[0, 0], [15, 5], [25, 10], [30, 10]]);
  assert.equal(commands.filter((c) => c.op === "M").length, 1, "never lifts the pen");
});

test("two points make a straight line; the SVG path scales with zoom", () => {
  assert.equal(penSvgPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), "M 1 2 L 3 4");
  assert.equal(penSvgPath(pts, 2), "M 0 0 Q 20 0 30 10 Q 40 20 50 20 L 60 20");
});

test("canvas tracing follows the same commands", () => {
  const calls = [];
  const ctx = { moveTo: (...a) => calls.push(["M", ...a]), quadraticCurveTo: (...a) => calls.push(["Q", ...a]), lineTo: (...a) => calls.push(["L", ...a]) };
  tracePenPath(ctx, pts, (x) => x + 100, (y) => y);
  assert.deepEqual(calls, [["M", 100, 0], ["Q", 110, 0, 115, 5], ["Q", 120, 10, 125, 10], ["L", 130, 10]]);
});
