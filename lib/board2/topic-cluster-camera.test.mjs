import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CAMERA_EASING,
  auditCameraMotion,
  auditTopicCameraArrivals,
  buildTopicClusterCameraKeyframes,
  countBroadMovesInsideNarrowBeats,
} from "./topic-cluster-camera.ts";
import { FOCUS_FILL_RATIO } from "./focus-camera.ts";
import { smootherstep } from "../camera-keyframes.ts";

const baseOptions = {
  canvasWidth: 1920,
  canvasHeight: 1080,
  boardWidth: 4000,
  imageFocusRatio: FOCUS_FILL_RATIO,
};

test("camera arrives at every narration deadline and spends 75% moving", () => {
  const clips = [
    { id: "a", startTime: 0, duration: 4, boardX: 200, boardY: 300, boardW: 400, boardH: 260, topicId: "cars", scope: "narrow" },
    { id: "b", startTime: 4, duration: 4, boardX: 700, boardY: 360, boardW: 360, boardH: 280, topicId: "cars", scope: "narrow" },
    { id: "c", startTime: 8, duration: 4, boardX: 2400, boardY: 500, boardW: 420, boardH: 300, topicId: "dreams", scope: "narrow" },
  ];
  const options = { ...baseOptions, clips, topicBounds: [] };
  const keyframes = buildTopicClusterCameraKeyframes(options);
  const audit = auditTopicCameraArrivals(options, keyframes);
  const motion = auditCameraMotion(keyframes, 0, 12);

  assert.deepEqual(keyframes.map((keyframe) => keyframe.time), [0, 1, 4, 5, 8, 9, 12]);
  assert.equal(Math.max(...audit.map((beat) => beat.driftSeconds)), 0);
  assert.equal(motion.motionFraction, 0.75);
  assert.equal(motion.holdFraction, 0.25);
  assert.equal(motion.easing, AUTO_CAMERA_EASING);
  assert.equal(motion.velocityContinuousAtMoveHoldBoundaries, true);
});

test("quintic smootherstep meets holds with zero boundary velocity", () => {
  const h = 0.00001;
  const startVelocity = (smootherstep(h) - smootherstep(0)) / h;
  const endVelocity = (smootherstep(1) - smootherstep(1 - h)) / h;
  assert.ok(Math.abs(startVelocity) < 0.00001);
  assert.ok(Math.abs(endVelocity) < 0.00001);
});

test("individual narrow stops fill the limiting frame dimension in both aspect ratios", () => {
  const cases = [
    { canvasWidth: 1920, canvasHeight: 1080, rect: { boardW: 1200, boardH: 600 } },
    { canvasWidth: 1920, canvasHeight: 1080, rect: { boardW: 600, boardH: 1200 } },
    { canvasWidth: 1080, canvasHeight: 1920, rect: { boardW: 1200, boardH: 600 } },
    { canvasWidth: 1080, canvasHeight: 1920, rect: { boardW: 600, boardH: 1200 } },
  ];

  for (const { canvasWidth, canvasHeight, rect } of cases) {
    const [focus] = buildTopicClusterCameraKeyframes({
      clips: [{ id: "focus", startTime: 10, duration: 4, boardX: 1000, boardY: 800, ...rect, topicId: "topic", scope: "narrow" }],
      topicBounds: [{ topicId: "topic", x: 900, y: 700, width: 1800, height: 1500 }],
      canvasWidth,
      canvasHeight,
      boardWidth: 17_500,
      imageFocusRatio: FOCUS_FILL_RATIO,
    });
    const scale = focus.boardZoom * canvasWidth / 17_500;
    const widthRatio = rect.boardW * scale / canvasWidth;
    const heightRatio = rect.boardH * scale / canvasHeight;
    assert.ok(Math.abs(Math.max(widthRatio, heightRatio) - FOCUS_FILL_RATIO) < 1e-10);
    assert.equal(focus.shot, "tight");
  }
});

test("a broad beat owns its interval and replaces the tight image stop", () => {
  const clips = [
    { id: "detail", startTime: 0, duration: 5, boardX: 200, boardY: 300, boardW: 400, boardH: 260, topicId: "one", scope: "narrow" },
    { id: "thesis", startTime: 5, duration: 5, boardX: 900, boardY: 400, boardW: 420, boardH: 300, topicId: "one", scope: "broad" },
    { id: "example", startTime: 10, duration: 5, boardX: 1500, boardY: 450, boardW: 360, boardH: 260, topicId: "one", scope: "narrow" },
  ];
  const options = {
    ...baseOptions,
    clips,
    topicBounds: [{ topicId: "one", x: 100, y: 180, width: 1900, height: 900 }],
  };
  const frames = buildTopicClusterCameraKeyframes(options);
  const broadFrames = frames.filter((frame) => frame.time >= 5 && frame.time < 10);

  assert.ok(broadFrames.length >= 2);
  assert.ok(broadFrames.every((frame) => frame.beatId === "thesis" && frame.scope === "broad" && frame.shot === "wide"));
  assert.equal(countBroadMovesInsideNarrowBeats(clips, frames), 0);
  assert.equal(auditTopicCameraArrivals(options, frames)[1].framing, "wide cluster move");
});

test("elapsed time and the legacy gap option cannot manufacture a broad move", () => {
  const clips = [{ id: "long-specific-example", startTime: 0, duration: 45, boardX: 500, boardY: 400, boardW: 600, boardH: 400, topicId: "one", scope: "narrow" }];
  const frames = buildTopicClusterCameraKeyframes({
    ...baseOptions,
    clips,
    topicBounds: [{ topicId: "one", x: 200, y: 200, width: 1800, height: 1100 }],
    maxBroadPanGapSec: 1,
  });
  assert.equal(frames.filter((frame) => frame.broadPan).length, 0);
  assert.ok(frames.every((frame) => frame.shot === "tight"));
});

test("revisiting the same image still gets a slow drift instead of a long freeze", () => {
  const clips = [
    { id: "first", startTime: 0, duration: 4, boardX: 500, boardY: 400, boardW: 600, boardH: 400, topicId: "one", scope: "narrow" },
    { id: "revisit", startTime: 4, duration: 4, boardX: 500, boardY: 400, boardW: 600, boardH: 400, topicId: "one", scope: "narrow" },
  ];
  const frames = buildTopicClusterCameraKeyframes({ ...baseOptions, clips, topicBounds: [] });
  const motion = auditCameraMotion(frames, 0, 8);
  assert.equal(motion.motionFraction, 0.75);
  assert.ok(frames.some((frame) => frame.time > 1 && frame.time < 4));
});

test("real narration timings budget longer pre-roll without arrival drift", () => {
  const clips = [
    { id: "bbtv-intro", startTime: 0, duration: 6.2, boardX: 300, boardY: 260, boardW: 920, boardH: 560, topicId: "intro", scope: "broad" },
    { id: "sleeping", startTime: 6.2, duration: 7.65, boardX: 3600, boardY: 500, boardW: 720, boardH: 520, topicId: "dreams", scope: "narrow" },
    { id: "journal", startTime: 13.85, duration: 8.55, boardX: 6600, boardY: 1800, boardW: 640, boardH: 760, topicId: "practice", scope: "narrow" },
    { id: "reality-check", startTime: 22.4, duration: 7.6, boardX: 9700, boardY: 700, boardW: 880, boardH: 540, topicId: "practice", scope: "narrow" },
  ];
  const options = {
    clips,
    topicBounds: [
      { topicId: "intro", x: 100, y: 100, width: 1500, height: 900 },
      { topicId: "dreams", x: 3300, y: 300, width: 1500, height: 1000 },
      { topicId: "practice", x: 6200, y: 400, width: 4600, height: 2200 },
    ],
    canvasWidth: 1920,
    canvasHeight: 1080,
    boardWidth: 12000,
    imageFocusRatio: FOCUS_FILL_RATIO,
  };
  const keyframes = buildTopicClusterCameraKeyframes(options);
  const audit = auditTopicCameraArrivals(options, keyframes);
  assert.deepEqual(audit.slice(1).map((beat) => Number(beat.travelSeconds.toFixed(4))), [4.65, 5.7375, 6.4125]);
  assert.equal(Math.max(...audit.map((beat) => beat.driftSeconds)), 0);
  assert.ok(audit.slice(1).every((beat) => beat.travelSeconds > 2.5));
});
