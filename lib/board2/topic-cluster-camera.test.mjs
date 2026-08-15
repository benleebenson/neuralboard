import test from "node:test";
import assert from "node:assert/strict";
import { buildTopicClusterCameraKeyframes } from "./topic-cluster-camera.ts";

test("camera establishes each cluster before visiting its timestamp-ordered images", () => {
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

  assert.deepEqual(keyframes.map((keyframe) => keyframe.time), [0, 0.42, 1.2, 2.4, 4, 6.4, 8, 8.42, 9.2, 10.4, 12]);
  const topicTwoStart = keyframes.find((keyframe) => keyframe.time === 8);
  assert.equal(topicTwoStart.cameraX, 2625);
  assert.equal(topicTwoStart.cameraY, 620);
});
