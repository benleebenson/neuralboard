import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLODE_DETONATION_PROGRESS,
  characterDespawnedAt,
  explodeDetonationTime,
  explodeShakeAt,
  sampleExplode,
} from "./explode.ts";

const explode = {
  id: "boom-1",
  type: "sequence",
  startTime: 2,
  duration: 1.45,
  sequenceId: "explode",
  sequenceSetupDuration: 0.5,
  sequenceCenterX: 400,
  sequenceCenterY: 700,
};

test("explode holds anticipation, then hides the character at detonation", () => {
  assert.equal(sampleExplode(EXPLODE_DETONATION_PROGRESS - 0.001).characterVisible, true);
  const detonation = sampleExplode(EXPLODE_DETONATION_PROGRESS);
  assert.equal(detonation.phase, "detonation");
  assert.equal(detonation.characterVisible, false);
  assert.ok(detonation.cloudAlpha > 0);
});

test("detonation time includes walk-in setup and scales with edited performance duration", () => {
  assert.equal(
    explodeDetonationTime(explode),
    explode.startTime + explode.sequenceSetupDuration + (explode.duration - explode.sequenceSetupDuration) * EXPLODE_DETONATION_PROGRESS,
  );
});

test("despawn is deterministic under backward and forward timeline sampling", () => {
  const detonation = explodeDetonationTime(explode);
  const nextAction = { id: "walk-later", type: "walkTo", startTime: 5, duration: 1 };
  const actions = [explode, nextAction];
  assert.equal(characterDespawnedAt(detonation - 1 / 60, actions), false);
  assert.equal(characterDespawnedAt(detonation, actions), true);
  assert.equal(characterDespawnedAt(4.99, actions), true);
  assert.equal(characterDespawnedAt(5, actions), false);
  assert.equal(characterDespawnedAt(1, actions), false);
});

test("screen shake is deterministic and limited to the detonation beat", () => {
  const detonation = explodeDetonationTime(explode);
  assert.deepEqual(explodeShakeAt(detonation - 0.001, [[explode]]), { x: 0, y: 0 });
  const first = explodeShakeAt(detonation + 0.05, [[explode]]);
  assert.deepEqual(first, explodeShakeAt(detonation + 0.05, [[explode]]));
  assert.notDeepEqual(first, { x: 0, y: 0 });
  assert.deepEqual(explodeShakeAt(detonation + 0.3, [[explode]]), { x: 0, y: 0 });
});
