import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_FOCUS_DISTANCE_MULTIPLIER_CEILING,
  CHARACTER_FOCUS_DISTANCE_MULTIPLIER_FLOOR,
  DEFAULT_CHARACTER_FOCUS_LEAD_IN_SECONDS,
  DEFAULT_CHARACTER_FOCUS_LEAD_OUT_SECONDS,
  activeCharacterFocusBlock,
  applyCharacterFocusCamera,
  characterFocusDistanceMultiplier,
  normalizeCharacterFocusTransitionSeconds,
  resolveCharacterFocusTransitionDurations,
} from "./character-focus-camera.ts";

const focus = {
  id: "focus",
  type: "characterFocus",
  startTime: 1,
  duration: 2,
  focusCharacterId: "c1",
  focusLeadInSeconds: 0.5,
  focusLeadOutSeconds: 0.5,
};

const baseCameraAt = (time) => ({ cameraX: 1000 + time * 200, cameraY: 900, boardZoom: 1.4 });

const common = {
  clips: [focus],
  canvasW: 1920,
  canvasH: 1080,
  boardW: 4000,
  baseCameraAt,
  positionAt: (_characterId, time) => ({ x: 500 + time * 100, y: 800 }),
};

test("character focus is active only inside its timeline block", () => {
  assert.equal(activeCharacterFocusBlock([focus], 0.999), undefined);
  assert.equal(activeCharacterFocusBlock([focus], 1)?.id, "focus");
  assert.equal(activeCharacterFocusBlock([focus], 2.999)?.id, "focus");
  assert.equal(activeCharacterFocusBlock([focus], 3), undefined);
});

test("character focus follows the moving character", () => {
  const camera = applyCharacterFocusCamera({ ...common, time: 2 });
  assert.equal(camera.cameraX, 700);
  assert.equal(camera.cameraY, 730);
  assert.ok(camera.boardZoom > baseCameraAt(2).boardZoom);
});

test("lead-in starts continuously and uses ease-in-out for position and zoom", () => {
  const atStart = applyCharacterFocusCamera({ ...common, time: focus.startTime });
  assert.deepEqual(atStart, baseCameraAt(focus.startTime));

  const targetAtStart = { cameraX: 600, cameraY: 730, boardZoom: 0.55 * 1080 * 4000 / (1920 * 170) };
  const durations = resolveCharacterFocusTransitionDurations(
    focus,
    baseCameraAt(1),
    targetAtStart,
    { ...targetAtStart, cameraX: 800 },
    baseCameraAt(3),
  );
  const halfway = applyCharacterFocusCamera({ ...common, time: 1 + durations.leadIn / 2 });
  const halfwayTargetX = 500 + (1 + durations.leadIn / 2) * 100;
  const positionProgress = (halfway.cameraX - baseCameraAt(1).cameraX) / (halfwayTargetX - baseCameraAt(1).cameraX);
  const zoomProgress = (halfway.boardZoom - baseCameraAt(1).boardZoom) / (targetAtStart.boardZoom - baseCameraAt(1).boardZoom);
  assert.ok(Math.abs(positionProgress - 0.5) < 1e-9);
  assert.ok(Math.abs(zoomProgress - 0.5) < 1e-9);
});

test("lead-out approaches the progressed next framing without a boundary jump", () => {
  const beforeEnd = applyCharacterFocusCamera({ ...common, time: 2.999999 });
  const atEnd = applyCharacterFocusCamera({ ...common, time: 3 });
  assert.ok(Math.abs(beforeEnd.cameraX - atEnd.cameraX) < 0.001);
  assert.ok(Math.abs(beforeEnd.cameraY - atEnd.cameraY) < 0.001);
  assert.ok(Math.abs(beforeEnd.boardZoom - atEnd.boardZoom) < 0.001);
  assert.deepEqual(atEnd, baseCameraAt(3));
});

test("a block remembers which character it focuses", () => {
  const camera = applyCharacterFocusCamera({
    ...common,
    clips: [{ ...focus, focusCharacterId: "c2" }],
    time: 2,
    positionAt: (characterId) => characterId === "c2" ? { x: 1400, y: 600 } : { x: 300, y: 600 },
  });
  assert.equal(camera.cameraX, 1400);
});

test("an active speech bubble adds headroom around the focused character", () => {
  const normal = applyCharacterFocusCamera({ ...common, time: 2 });
  const withBubble = applyCharacterFocusCamera({
    ...common,
    time: 2,
    positionAt: (_characterId, time) => ({ x: 500 + time * 100, y: 800, speechBubble: true }),
  });
  assert.equal(withBubble.cameraX, normal.cameraX);
  assert.ok(withBubble.cameraY < normal.cameraY);
  assert.ok(withBubble.boardZoom < normal.boardZoom);
});

test("distance scaling is clamped to named floor and ceiling multipliers", () => {
  const origin = { cameraX: 0, cameraY: 0, boardZoom: 1 };
  assert.equal(
    characterFocusDistanceMultiplier(origin, { cameraX: 1, cameraY: 0, boardZoom: 1 }),
    CHARACTER_FOCUS_DISTANCE_MULTIPLIER_FLOOR,
  );
  assert.equal(
    characterFocusDistanceMultiplier(origin, { cameraX: 5000, cameraY: 0, boardZoom: 1 }),
    CHARACTER_FOCUS_DISTANCE_MULTIPLIER_CEILING,
  );
});

test("a too-short block becomes proportionally all-transition with no negative hold", () => {
  const camera = { cameraX: 0, cameraY: 0, boardZoom: 1 };
  const focusCamera = { cameraX: 1000, cameraY: 0, boardZoom: 2 };
  const durations = resolveCharacterFocusTransitionDurations(
    { ...focus, duration: 0.25, focusLeadInSeconds: 1, focusLeadOutSeconds: 3 },
    camera,
    focusCamera,
    focusCamera,
    camera,
  );
  assert.ok(Math.abs(durations.leadIn - 0.0625) < 1e-12);
  assert.ok(Math.abs(durations.leadOut - 0.1875) < 1e-12);
  assert.equal(durations.hold, 0);
  assert.ok(Math.abs(durations.leadIn + durations.leadOut - 0.25) < 1e-12);
});

test("legacy blocks normalize missing transition fields to exported defaults", () => {
  assert.equal(normalizeCharacterFocusTransitionSeconds(undefined, DEFAULT_CHARACTER_FOCUS_LEAD_IN_SECONDS), 0.5);
  assert.equal(normalizeCharacterFocusTransitionSeconds(undefined, DEFAULT_CHARACTER_FOCUS_LEAD_OUT_SECONDS), 0.5);
});

test("overlapping focus blocks transition from the camera already on screen", () => {
  const second = { ...focus, id: "focus-2", startTime: 2, focusCharacterId: "c2" };
  const args = {
    ...common,
    clips: [focus, second],
    positionAt: (characterId, time) => characterId === "c2"
      ? { x: 1800, y: 700 }
      : { x: 500 + time * 100, y: 800 },
  };
  const before = applyCharacterFocusCamera({ ...args, time: 1.999999 });
  const boundary = applyCharacterFocusCamera({ ...args, time: 2 });
  assert.ok(Math.abs(before.cameraX - boundary.cameraX) < 0.001);
  assert.ok(Math.abs(before.cameraY - boundary.cameraY) < 0.001);
  assert.ok(Math.abs(before.boardZoom - boundary.boardZoom) < 0.001);
});
