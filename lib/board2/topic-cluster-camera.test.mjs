import test from "node:test";
import assert from "node:assert/strict";
import { auditTopicCameraArrivals, buildTopicClusterCameraKeyframes } from "./topic-cluster-camera.ts";
import { FOCUS_FILL_RATIO } from "./focus-camera.ts";

test("camera reaches every image at its narration timestamp and establishes new clusters beforehand", () => {
  const keyframes = buildTopicClusterCameraKeyframes({
    clips: [
      { id: "a", startTime: 0, duration: 4, boardX: 200, boardY: 300, boardW: 400, boardH: 260, topicId: "cars" },
      { id: "b", startTime: 4, duration: 4, boardX: 700, boardY: 360, boardW: 360, boardH: 280, topicId: "cars" },
      { id: "c", startTime: 8, duration: 4, boardX: 2400, boardY: 500, boardW: 420, boardH: 300, topicId: "dreams" },
    ],
    topicBounds: [
      { topicId: "cars", x: 120, y: 180, width: 1020, height: 540 },
      { topicId: "dreams", x: 2300, y: 360, width: 650, height: 520 },
    ],
    canvasWidth: 1920,
    canvasHeight: 1080,
    boardWidth: 4000,
    imageFocusRatio: 0.7,
  });

  assert.deepEqual(keyframes.map((keyframe) => keyframe.time), [0, 2.4, 3.292, 4, 5.574, 6.4, 7.28, 8, 10.4, 12]);
  const topicTwoStart = keyframes.find((keyframe) => keyframe.time === 8);
  assert.equal(topicTwoStart.cameraX, 2610);
  assert.equal(topicTwoStart.cameraY, 650);
  assert.equal(topicTwoStart.boardZoom, 5.25);
});

test("individual image stops fill the limiting frame dimension in landscape and portrait output", () => {
  const cases = [
    { canvasWidth: 1920, canvasHeight: 1080, rect: { boardW: 1200, boardH: 600 } },
    { canvasWidth: 1920, canvasHeight: 1080, rect: { boardW: 600, boardH: 1200 } },
    { canvasWidth: 1080, canvasHeight: 1920, rect: { boardW: 1200, boardH: 600 } },
    { canvasWidth: 1080, canvasHeight: 1920, rect: { boardW: 600, boardH: 1200 } },
  ];

  for (const { canvasWidth, canvasHeight, rect } of cases) {
    const [focus] = buildTopicClusterCameraKeyframes({
      clips: [{ id: "focus", startTime: 10, duration: 4, boardX: 1000, boardY: 800, ...rect, topicId: "topic" }],
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
  }
});

test("long multi-image camera timing stays locked to absolute narration timestamps", () => {
  const clips = [
    { id: "intro", startTime: 30, duration: 12.5, boardX: 100, boardY: 200, boardW: 400, boardH: 300, topicId: "sleep" },
    { id: "journal", startTime: 42.5, duration: 5.75, boardX: 900, boardY: 400, boardW: 500, boardH: 300, topicId: "sleep" },
    { id: "alarm", startTime: 48.25, duration: 221.75, boardX: 2500, boardY: 900, boardW: 450, boardH: 300, topicId: "habits" },
  ];
  const keyframes = buildTopicClusterCameraKeyframes({
    clips,
    topicBounds: [
      { topicId: "sleep", x: 50, y: 100, width: 1500, height: 800 },
      { topicId: "habits", x: 2300, y: 700, width: 900, height: 700 },
    ],
    canvasWidth: 1920,
    canvasHeight: 1080,
    boardWidth: 4000,
    imageFocusRatio: 0.7,
  });

  for (const clip of clips) {
    const focus = keyframes.find((keyframe) => keyframe.time === clip.startTime);
    assert.ok(focus, `missing focus keyframe for ${clip.id}`);
    assert.equal(focus.cameraX, clip.boardX + clip.boardW / 2);
    assert.equal(focus.cameraY, clip.boardY + clip.boardH / 2);
  }
});

test("auto-build schedules wide sweeps with a bounded gap and returns to one image location", () => {
  const clips = Array.from({ length: 20 }, (_, index) => ({
    id: `beat-${index}`, startTime: index * 3, duration: 3,
    boardX: index % 5 === 0 ? 200 : 300 + index * 30, boardY: 400,
    boardW: 400, boardH: 260, topicId: "one", shot: index % 6 === 0 ? "wide" : "tight",
  }));
  const frames = buildTopicClusterCameraKeyframes({
    clips, topicBounds: [{ topicId: "one", x: 100, y: 200, width: 1800, height: 900 }],
    canvasWidth: 1920, canvasHeight: 1080, boardWidth: 4000,
    imageFocusRatio: 0.7, maxBroadPanGapSec: 18,
  });
  const broadStarts = frames.filter((frame) => frame.broadPan).filter((_, index) => index % 2 === 0);
  assert.ok(broadStarts.length >= 4);
  assert.ok(Math.max(...[0, ...broadStarts.map((frame) => frame.time), 60].slice(1)
    .map((time, index) => time - [0, ...broadStarts.map((frame) => frame.time)][index])) <= 20);
  const returns = frames.filter((frame) => frame.time === 15 || frame.time === 30);
  assert.equal(returns.length, 2);
  assert.equal(returns[0].cameraX, returns[1].cameraX);
});

test("a long narration hold still receives broad scans", () => {
  const frames = buildTopicClusterCameraKeyframes({
    clips: [{ id: "long", startTime: 0, duration: 45, boardX: 500, boardY: 400, boardW: 600, boardH: 400, topicId: "one", shot: "tight" }],
    topicBounds: [{ topicId: "one", x: 200, y: 200, width: 1800, height: 1100 }],
    canvasWidth: 1920, canvasHeight: 1080, boardWidth: 4000,
    imageFocusRatio: 0.7, maxBroadPanGapSec: 18,
  });
  assert.deepEqual(frames.filter((frame) => frame.broadPan).filter((_, index) => index % 2 === 0).map((frame) => frame.time), [16, 32]);
});

test("real narration fixture budgets travel before every spoken image moment", () => {
  // Hand-timed from a real BBTV-style lucid-dreaming narration excerpt: “Welcome back to BBTV…
  // tonight we're talking about lucid dreaming… write the dream down… test whether you're awake.”
  const clips = [
    { id: "bbtv-intro", startTime: 0, duration: 6.2, boardX: 300, boardY: 260, boardW: 920, boardH: 560, topicId: "intro", role: "intro" },
    { id: "sleeping", startTime: 6.2, duration: 7.65, boardX: 3600, boardY: 500, boardW: 720, boardH: 520, topicId: "dreams" },
    { id: "journal", startTime: 13.85, duration: 8.55, boardX: 6600, boardY: 1800, boardW: 640, boardH: 760, topicId: "practice" },
    { id: "reality-check", startTime: 22.4, duration: 7.6, boardX: 9700, boardY: 700, boardW: 880, boardH: 540, topicId: "practice" },
  ];
  const options = { clips, topicBounds: [], canvasWidth: 1920, canvasHeight: 1080, boardWidth: 12000, imageFocusRatio: 0.94 };
  const keyframes = buildTopicClusterCameraKeyframes(options);
  const audit = auditTopicCameraArrivals(options, keyframes);
  assert.ok(audit.slice(1).every((beat) => beat.travelSeconds >= 0.35 && beat.travelSeconds <= 2.5));
  assert.equal(Math.max(...audit.map((beat) => beat.driftSeconds)), 0);
});
