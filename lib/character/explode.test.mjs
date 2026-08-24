import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLODE_BLAST_SECONDS,
  EXPLODE_DURATION_SECONDS,
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

test("explode detonates immediately with no anticipation", () => {
  assert.equal(EXPLODE_DURATION_SECONDS, 0.3);
  assert.equal(EXPLODE_BLAST_SECONDS, 0.25);
  assert.equal(EXPLODE_DETONATION_PROGRESS, 0);
  const detonation = sampleExplode(0);
  assert.equal(detonation.phase, "detonation");
  assert.equal(detonation.characterVisible, false);
  assert.equal(detonation.burst, 1);
  assert.equal(sampleExplode(1).phase, "aftermath");
  assert.equal(sampleExplode(1).burst, 0);
});

test("detonation occurs immediately after any legacy walk-in setup", () => {
  assert.equal(
    explodeDetonationTime(explode),
    explode.startTime + explode.sequenceSetupDuration,
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
  assert.deepEqual(explodeShakeAt(detonation + EXPLODE_BLAST_SECONDS + 0.01, [[explode]]), { x: 0, y: 0 });
});
