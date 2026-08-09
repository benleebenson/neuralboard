import test from "node:test";
import assert from "node:assert/strict";
import {
  activeCharacterFocusBlock,
  applyCharacterFocusCamera,
} from "./character-focus-camera.ts";

const focus = {
  id: "focus",
  type: "characterFocus",
  startTime: 1,
  duration: 2,
  focusCharacterId: "c1",
};

const common = {
  clips: [focus],
  canvasW: 1920,
  canvasH: 1080,
  boardW: 4000,
  positionAt: (_characterId, time) => ({ x: 500 + time * 100, y: 800 }),
};

test("character focus is active only inside its timeline block", () => {
  assert.equal(activeCharacterFocusBlock([focus], 0.999), undefined);
  assert.equal(activeCharacterFocusBlock([focus], 1)?.id, "focus");
  assert.equal(activeCharacterFocusBlock([focus], 2.999)?.id, "focus");
  assert.equal(activeCharacterFocusBlock([focus], 3), undefined);
});

test("character focus follows the moving character", () => {
  const baseCamera = { cameraX: 1200, cameraY: 900, boardZoom: 1.4 };
  const camera = applyCharacterFocusCamera({ ...common, time: 2, baseCamera });
  assert.equal(camera.cameraX, 700);
  assert.equal(camera.cameraY, 730);
  assert.ok(camera.boardZoom > baseCamera.boardZoom);
});

test("character focus completely overrides an overlapping image transition", () => {
  const first = applyCharacterFocusCamera({
    ...common,
    time: 1.001,
    baseCamera: { cameraX: 100, cameraY: 100, boardZoom: 1 },
  });
  const second = applyCharacterFocusCamera({
    ...common,
    time: 1.001,
    baseCamera: { cameraX: 3500, cameraY: 1900, boardZoom: 7 },
  });
  assert.deepEqual(first, second);
  assert.equal(first.cameraX, 600.1);
  assert.equal(first.cameraY, 730);
});

test("camera resumes the progressed base camera only after the focus block ends", () => {
  const beforeEndBase = { cameraX: 1599, cameraY: 900, boardZoom: 1.4 };
  const atEndBase = { cameraX: 1600, cameraY: 900, boardZoom: 1.4 };
  const beforeEnd = applyCharacterFocusCamera({ ...common, time: 2.999, baseCamera: beforeEndBase });
  const atEnd = applyCharacterFocusCamera({ ...common, time: 3, baseCamera: atEndBase });
  assert.ok(Math.abs(beforeEnd.cameraX - 799.9) < 0.000001);
  assert.equal(beforeEnd.cameraY, 730);
  assert.deepEqual(atEnd, atEndBase);
});

test("a block remembers which character it focuses", () => {
  const camera = applyCharacterFocusCamera({
    ...common,
    clips: [{ ...focus, focusCharacterId: "c2" }],
    time: 2,
    baseCamera: { cameraX: 100, cameraY: 100, boardZoom: 1 },
    positionAt: (characterId) => characterId === "c2" ? { x: 1400, y: 600 } : { x: 300, y: 600 },
  });
  assert.equal(camera.cameraX, 1400);
});

test("an active speech bubble adds headroom around the focused character", () => {
  const baseCamera = { cameraX: 1200, cameraY: 900, boardZoom: 1.4 };
  const normal = applyCharacterFocusCamera({ ...common, time: 2, baseCamera });
  const withBubble = applyCharacterFocusCamera({
    ...common,
    time: 2,
    baseCamera,
    positionAt: (_characterId, time) => ({ x: 500 + time * 100, y: 800, speechBubble: true }),
  });
  assert.equal(withBubble.cameraX, normal.cameraX);
  assert.ok(withBubble.cameraY < normal.cameraY);
  assert.ok(withBubble.boardZoom < normal.boardZoom);
});
