import assert from "node:assert/strict";
import test from "node:test";
import {
  combatHealthColor,
  bazookaCharacterHitZones,
  GUEST_BAZOOKA_MAX_HEALTH,
  HOST_BAZOOKA_MAX_HEALTH,
  bazookaRagdollImpulse,
  bazookaShotKey,
  firstBazookaCharacterHit,
  nextBazookaHealth,
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

test("bazooka health uses three guest hits and ten host hits", () => {
  let guestHealth = { current: GUEST_BAZOOKA_MAX_HEALTH, max: GUEST_BAZOOKA_MAX_HEALTH, hitAt: 0 };
  for (let hit = 1; hit <= GUEST_BAZOOKA_MAX_HEALTH; hit += 1) {
    guestHealth = nextBazookaHealth(guestHealth.current, guestHealth.max, hit);
  }
  assert.equal(guestHealth.current, 0);

  let hostHealth = { current: HOST_BAZOOKA_MAX_HEALTH, max: HOST_BAZOOKA_MAX_HEALTH, hitAt: 0 };
  for (let hit = 1; hit <= HOST_BAZOOKA_MAX_HEALTH; hit += 1) {
    hostHealth = nextBazookaHealth(hostHealth.current, hostHealth.max, hit);
  }
  assert.equal(hostHealth.current, 0);
  assert.match(combatHealthColor(guestHealth.max, guestHealth.max), /^hsl\(120 /);
  assert.match(combatHealthColor(0, guestHealth.max), /^hsl\(0 /);
});

test("live hit zones allow a character to jump clear of a rocket", () => {
  const standingZones = bazookaCharacterHitZones({ role: "host", x: 500, y: 600 });
  const jumpingZones = bazookaCharacterHitZones({ role: "host", x: 500, y: 430 });
  const from = { x: 300, y: 492 };
  const to = { x: 700, y: 492 };
  assert.ok(firstBazookaCharacterHit(from, to, standingZones));
  assert.equal(firstBazookaCharacterHit(from, to, jumpingZones), null);
});
