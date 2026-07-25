import assert from "node:assert/strict";
import test from "node:test";
import {
  bazookaRagdollImpulse,
  bazookaShotKey,
  firstBazookaCharacterHit,
} from "./impacts.ts";

test("bazooka character raycast chooses the nearest character", () => {
  const hit = firstBazookaCharacterHit(
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    [
      { role: "guest", guestId: "far", center: { x: 700, y: 0 }, radius: 50 },
      { role: "host", center: { x: 300, y: 0 }, radius: 50 },
    ],
  );
  assert.equal(hit?.role, "host");
  assert.equal(hit?.distance, 250);
  assert.deepEqual(hit?.point, { x: 250, y: 0 });
});

test("bazooka character raycast ignores misses and targets behind the shooter", () => {
  const hit = firstBazookaCharacterHit(
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    [
      { role: "host", center: { x: -80, y: 0 }, radius: 40 },
      { role: "guest", guestId: "miss", center: { x: 400, y: 90 }, radius: 50 },
    ],
  );
  assert.equal(hit, null);
});

test("ragdoll impulse always adds lift and a stable shot identity", () => {
  const impulse = bazookaRagdollImpulse({ x: 1, y: 0 }, 12);
  assert.equal(impulse.x, 820);
  assert.equal(impulse.y, -520);
  assert.ok(impulse.spin > 0);
  assert.equal(
    bazookaShotKey({ sessionId: "session", startTime: 100, seed: 12 }),
    "session:100:12",
  );
});
