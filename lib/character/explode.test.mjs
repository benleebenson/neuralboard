import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLODE_BLAST_SECONDS,
  EXPLODE_DURATION_SECONDS,
  EXPLODE_DETONATION_PROGRESS,
  EXPLODE_SHAKE_SECONDS,
  SECONDARY_COMBUSTION_DURATION_SECONDS,
  characterDespawnedAt,
  explodeDetonationTime,
  explodeShakeAt,
  sampleSecondaryCombustion,
  sampleExplode,
  sharedExplosionImageSurfaceId,
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
  assert.ok(Math.hypot(first.x, first.y) > 10, "export shake should read as a strong full-frame impact");
  assert.deepEqual(explodeShakeAt(detonation + EXPLODE_SHAKE_SECONDS + 0.01, [[explode]]), { x: 0, y: 0 });
});

test("chain reactions require both characters to share the same image top", () => {
  const surfaces = [
    { id: "image-a", type: "image", boardX: 100, boardY: 500, boardW: 700, boardH: 360 },
    { id: "image-b", type: "image", boardX: 900, boardY: 500, boardW: 700, boardH: 360 },
    { id: "video-a", type: "video", boardX: 100, boardY: 900, boardW: 700, boardH: 360 },
  ];
  assert.equal(sharedExplosionImageSurfaceId({ x: 250, y: 500 }, { x: 620, y: 500 }, surfaces), "image-a");
  assert.equal(sharedExplosionImageSurfaceId({ x: 250, y: 500 }, { x: 1000, y: 500 }, surfaces), null);
  assert.equal(sharedExplosionImageSurfaceId({ x: 250, y: 900 }, { x: 620, y: 900 }, surfaces), null);
});

test("the secondary character separates into parts and exits the frame", () => {
  const event = {
    id: "boom:secondary:c2",
    detonationTime: 2,
    origin: { x: 200, y: 500 },
    victimStart: { x: 560, y: 500 },
  };
  const start = sampleSecondaryCombustion(2, event);
  const flying = sampleSecondaryCombustion(3.2, event);
  assert.equal(start?.pieces.length, 6);
  assert.equal(flying?.active, true);
  assert.ok((flying?.pieces[1].x ?? 0) - event.victimStart.x > 1000);
  assert.equal(sampleSecondaryCombustion(2 + SECONDARY_COMBUSTION_DURATION_SECONDS + 0.01, event)?.active, false);
});
