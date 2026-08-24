import assert from "node:assert/strict";
import test from "node:test";
import { bazookaShake, craterForImpact, explodeCratersAt } from "./craters.ts";
import { characterDespawnedAt, explodeSeed } from "./explode.ts";
import { sampleTrenchCoatReveal, TRENCH_COAT_REVEAL_DURATION } from "./trench-coat-reveal.ts";

test("explode reuses the bazooka crater data on the struck surface", () => {
  const surface = { id: "image-1", boardX: 100, boardY: 400, boardW: 600, boardH: 300 };
  const action = {
    id: "boom",
    type: "sequence",
    startTime: 2,
    duration: 0.3,
    sequenceId: "explode",
    targetX: 360,
    targetY: 400,
  };
  assert.deepEqual(explodeCratersAt(1.99, [[action]], [surface]), []);
  assert.deepEqual(
    explodeCratersAt(2, [[action]], [surface]),
    [craterForImpact(surface, { x: action.targetX, y: action.targetY }, explodeSeed(action.id))],
  );
});

test("explode crater generation is deterministic and does not duplicate a crater", () => {
  const surface = { id: "video-1", boardX: 0, boardY: 200, boardW: 500, boardH: 280 };
  const action = { id: "same-boom", type: "sequence", startTime: 0, duration: 0.3, sequenceId: "explode", targetX: 250, targetY: 200 };
  const once = explodeCratersAt(1, [[action]], [surface]);
  assert.deepEqual(explodeCratersAt(1, [[action]], [surface], once), once);
});

test("an explode action cuts cleanly from a held-open trench reveal", () => {
  const surface = { id: "image-tnt", boardX: 100, boardY: 500, boardW: 700, boardH: 360 };
  const explode = {
    id: "reveal-then-boom",
    type: "sequence",
    startTime: TRENCH_COAT_REVEAL_DURATION,
    duration: 0.3,
    sequenceId: "explode",
    targetX: 450,
    targetY: 500,
  };
  assert.equal(sampleTrenchCoatReveal(1).open, 1);
  assert.equal(characterDespawnedAt(explode.startTime - 1 / 60, [explode]), false);
  assert.equal(characterDespawnedAt(explode.startTime, [explode]), true);
  assert.equal(explodeCratersAt(explode.startTime - 1 / 60, [[explode]], [surface]).length, 0);
  assert.equal(explodeCratersAt(explode.startTime, [[explode]], [surface]).length, 1);
});

test("bazooka impacts create a strong deterministic export shake", () => {
  const event = {
    startTime: 0,
    from: { x: 0, y: 0 },
    target: { x: 1100, y: 0 },
    seed: 42,
  };
  const impact = bazookaShake([event], 1050);
  assert.deepEqual(impact, bazookaShake([event], 1050));
  assert.ok(Math.hypot(impact.x, impact.y) > 10);
  assert.deepEqual(bazookaShake([event], 1500), { x: 0, y: 0 });
});
