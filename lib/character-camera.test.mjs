import test from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOW_CAM_MAX_TRAIL_FRAME_FRACTION,
  classifyCharacterAction,
  characterProjectDuration,
  deriveCharacterCameraKeyframes,
  deriveFollowCameraKeyframes,
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

test("follow camera trails fast motion more than slow motion and keeps the character in frame", () => {
  const common = {
    actions: [{ id: "move", type: "grapple", startTime: 0, duration: 1.2, fromX: 0, fromY: 500, targetX: 1800, targetY: 500 }],
    clips: [],
    duration: 2.2,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
  };
  const slowPositionAt = (time) => ({ x: 100 + Math.min(time, 1.2) * 100, y: 500 });
  const fastPositionAt = (time) => ({ x: 100 + Math.min(time, 1.2) * 1500, y: 500 });
  const slow = deriveFollowCameraKeyframes({ ...common, positionAt: slowPositionAt }).keyframes;
  const fast = deriveFollowCameraKeyframes({ ...common, positionAt: fastPositionAt }).keyframes;
  const slowAtOne = slow.find((keyframe) => keyframe.time === 1);
  const fastAtOne = fast.find((keyframe) => keyframe.time === 1);
  assert.ok(slowAtOne && fastAtOne);
  const slowTrail = slowPositionAt(1).x - slowAtOne.cameraX;
  const fastTrail = fastPositionAt(1).x - fastAtOne.cameraX;
  assert.ok(slowTrail < 45, `slow trail was ${slowTrail}`);
  assert.ok(fastTrail > slowTrail * 4, `fast trail ${fastTrail} was not much larger than ${slowTrail}`);

  const visibleWidth = common.boardW / fastAtOne.boardZoom;
  assert.ok(fastTrail <= visibleWidth * FOLLOW_CAM_MAX_TRAIL_FRAME_FRACTION + 0.001);
  assert.ok(fast.some((keyframe) => keyframe.time > 1.2 && keyframe.cameraX > fastPositionAt(keyframe.time).x));
});

test("frameSurface detects the starting surface, holds it static, and eases back by block end", () => {
  const frameClip = { id: "frame", type: "frameSurface", startTime: 1, duration: 2, holdFraction: 0.6 };
  const surface = { id: "video", type: "video", boardX: 400, boardY: 500, boardW: 800, boardH: 450 };
  const followArgs = {
    actions: [{ id: "idle", type: "idle", startTime: 0, duration: 3, fromX: 600, fromY: 500 }],
    clips: [surface, frameClip],
    duration: 4,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
    positionAt: (time) => ({ x: time < 2 ? 600 : 600 + (time - 2) * 400, y: 500 }),
  };
  const withFrame = deriveFollowCameraKeyframes(followArgs);
  const withoutFrame = deriveFollowCameraKeyframes({ ...followArgs, clips: [surface] });
  assert.deepEqual(withFrame.framedSurfaces, [{ blockId: "frame", clipId: "video", start: 1, end: 3 }]);
  assert.equal(withFrame.notes.length, 0);
  const held = withFrame.keyframes.find((keyframe) => keyframe.time === 2);
  assert.ok(held);
  assert.equal(held.cameraX, 800);
  assert.equal(held.cameraY, 725);
  assert.equal(held.boardZoom, 3.5);
  for (const boundary of [1, 3]) {
    assert.deepEqual(
      withFrame.keyframes.find((keyframe) => keyframe.time === boundary),
      withoutFrame.keyframes.find((keyframe) => keyframe.time === boundary),
    );
  }
});

test("frameSurface on parchment uses wide character framing and reports a note", () => {
  const result = deriveFollowCameraKeyframes({
    actions: [{ id: "idle", type: "idle", startTime: 0, duration: 2, fromX: 900, fromY: 700 }],
    clips: [{ id: "bare", type: "frameSurface", startTime: 0.5, duration: 1, holdFraction: 0.6 }],
    duration: 3,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
    positionAt: () => ({ x: 900, y: 700 }),
  });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0].message, /bare parchment/);
  assert.equal(result.keyframes.find((keyframe) => keyframe.time === 1)?.boardZoom, 3.375);
});

test("follow video windows are the union of settled occupancy and frameSurface framing", () => {
  const result = deriveFollowCameraKeyframes({
    actions: [
      { id: "idle", type: "idle", startTime: 0, duration: 1, fromX: 600, fromY: 500 },
      { id: "move", type: "walkTo", startTime: 1, duration: 2, fromX: 600, fromY: 500, targetX: 1300, targetY: 500 },
    ],
    clips: [
      { id: "video", type: "video", boardX: 400, boardY: 500, boardW: 800, boardH: 450 },
      { id: "frame", type: "frameSurface", startTime: 0.8, duration: 1.7, holdFraction: 0.6 },
    ],
    duration: 4,
    canvasW: 1920,
    canvasH: 1080,
    boardW: 4000,
    positionAt: (time) => ({ x: time < 1 ? 600 : 600 + Math.min(2, time - 1) * 350, y: 500 }),
  });
  assert.deepEqual(result.occupancyWindows, [{ clipId: "video", start: 0, end: 2.5 }]);
});
