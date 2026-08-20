import test from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_FILL_RATIO,
  cameraForFocusRect,
} from "./focus-camera.ts";

const OUTPUTS = [
  { name: "16:9", width: 1920, height: 1080 },
  { name: "9:16", width: 1080, height: 1920 },
];

const MEDIA = [
  {
    name: "portrait image",
    width: 1200,
    height: 2400,
    expected: {
      "16:9": { width: 0.264375, height: 0.94 },
      "9:16": { width: 0.8355555555555556, height: 0.94 },
    },
  },
  {
    name: "landscape image",
    width: 2400,
    height: 1200,
    expected: {
      "16:9": { width: 0.94, height: 0.8355555555555556 },
      "9:16": { width: 0.94, height: 0.264375 },
    },
  },
  {
    name: "square image",
    width: 1200,
    height: 1200,
    expected: {
      "16:9": { width: 0.52875, height: 0.94 },
      "9:16": { width: 0.94, height: 0.52875 },
    },
  },
  {
    name: "vertical video",
    width: 1080,
    height: 1920,
    expected: {
      "16:9": { width: 0.297421875, height: 0.94 },
      "9:16": { width: 0.94, height: 0.94 },
    },
  },
];

test("focused image and video rectangles fill the limiting axis in both output aspects", () => {
  const boardWidth = 17_500;
  for (const output of OUTPUTS) {
    for (const media of MEDIA) {
      const camera = cameraForFocusRect(
        { x: 300, y: 500, width: media.width, height: media.height },
        output.width,
        output.height,
        boardWidth,
      );
      const screenScale = camera.boardZoom * output.width / boardWidth;
      const actualWidth = media.width * screenScale / output.width;
      const actualHeight = media.height * screenScale / output.height;
      const expected = media.expected[output.name];

      assert.ok(Math.abs(actualWidth - expected.width) < 1e-12, `${media.name} ${output.name} width`);
      assert.ok(Math.abs(actualHeight - expected.height) < 1e-12, `${media.name} ${output.name} height`);
      assert.ok(actualWidth <= 1 && actualHeight <= 1, `${media.name} ${output.name} remains fully visible`);
      assert.ok(
        Math.abs(Math.max(actualWidth, actualHeight) - FOCUS_FILL_RATIO) < 1e-12,
        `${media.name} ${output.name} fills its limiting axis`,
      );
    }
  }
});

test("focus camera centers the rect and implements min(frame/media) times the named ratio", () => {
  const rect = { x: 120, y: 240, width: 1200, height: 2400 };
  const camera = cameraForFocusRect(rect, 1080, 1920, 4000);
  const expectedScale = Math.min(1080 / 1200, 1920 / 2400) * FOCUS_FILL_RATIO;

  assert.equal(camera.cameraX, 720);
  assert.equal(camera.cameraY, 1440);
  assert.equal(camera.boardZoom, expectedScale * 4000 / 1080);
});
