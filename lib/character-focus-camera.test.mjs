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

test("character focus follows the moving character while preserving the underlying camera", () => {
  const baseCamera = { cameraX: 1200, cameraY: 900, boardZoom: 1.4 };
  const camera = applyCharacterFocusCamera({ ...common, time: 2, baseCamera });
  assert.equal(camera.cameraX, 700);
  assert.equal(camera.cameraY, 730);
  assert.ok(camera.boardZoom > baseCamera.boardZoom);
});

test("camera resumes the progressed base pan when the focus block ends", () => {
  const beforeEndBase = { cameraX: 1599, cameraY: 900, boardZoom: 1.4 };
  const atEndBase = { cameraX: 1600, cameraY: 900, boardZoom: 1.4 };
  const beforeEnd = applyCharacterFocusCamera({ ...common, time: 2.999, baseCamera: beforeEndBase });
  const atEnd = applyCharacterFocusCamera({ ...common, time: 3, baseCamera: atEndBase });
  assert.ok(Math.abs(beforeEnd.cameraX - beforeEndBase.cameraX) < 0.1);
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
