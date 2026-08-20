import test from "node:test";
import assert from "node:assert/strict";
import { buildTopicClusterCameraKeyframes } from "./topic-cluster-camera.ts";
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

  assert.deepEqual(keyframes.map((keyframe) => keyframe.time), [0, 2.4, 4, 6.4, 7.28, 8, 10.4, 12]);
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
