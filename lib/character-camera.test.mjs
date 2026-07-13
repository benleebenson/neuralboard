import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCharacterAction,
  characterProjectDuration,
  deriveCharacterCameraKeyframes,
  deriveOccupancyWindows,
} from "./character-camera.ts";

const actions = [
  { id: "travel", type: "walkTo", startTime: 0, duration: 1, fromX: 100, fromY: 500, targetX: 500, targetY: 500 },
  { id: "settled", type: "idle", startTime: 1, duration: 2, fromX: 500, fromY: 500 },
];
const clips = [
  { id: "video", type: "video", boardX: 400, boardY: 500, boardW: 800, boardH: 450 },
];
const positionAt = (time) => ({ x: time < 1 ? 100 + 400 * time : 500, y: 500 });

test("character duration ends one second after the last action", () => {
  assert.equal(characterProjectDuration(actions), 4);
});

test("camera action classification covers travel, settled, and custom stationary actions", () => {
  assert.equal(classifyCharacterAction("zipline"), "travel");
  assert.equal(classifyCharacterAction("dance"), "settled");
  assert.equal(classifyCharacterAction("customPose"), "settled");
});

test("travel samples every 250ms and applies a 0.3 EMA", () => {
  const keyframes = deriveCharacterCameraKeyframes({
    actions,
    clips,
    duration: 4,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
    positionAt,
  });
  const travel = keyframes.filter((keyframe) => keyframe.time <= 1);
  assert.deepEqual(travel.map((keyframe) => keyframe.time), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(
    travel.map((keyframe) => Number(keyframe.cameraX.toFixed(2))),
    [100, 130, 181, 246.7, 322.69],
  );
  assert.ok(travel.slice(1).every((keyframe) => keyframe.easing === "linear" || keyframe.easing === "ease-in-out"));
});

test("occupancy starts only after travel and drives a continuous video window", () => {
  const windows = deriveOccupancyWindows({ actions, clips, duration: 4, positionAt });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].clipId, "video");
  assert.ok(windows[0].start >= 1 && windows[0].start < 1.051);
  assert.equal(windows[0].end, 4);
});

test("settled framing can widen for a nearby second character", () => {
  const common = {
    actions: [{ id: "idle", type: "idle", startTime: 0, duration: 2, fromX: 500, fromY: 500 }],
    clips,
    duration: 3,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
    positionAt: () => ({ x: 500, y: 500 }),
  };
  const solo = deriveCharacterCameraKeyframes(common);
  const pair = deriveCharacterCameraKeyframes({ ...common, secondPositionAt: () => ({ x: 1240, y: 500 }) });
  assert.ok(pair[0].boardZoom < solo[0].boardZoom);
});
