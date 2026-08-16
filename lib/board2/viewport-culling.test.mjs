import test from "node:test";
import assert from "node:assert/strict";
import { boardRectIntersectsCameraFrame, cameraFrameBounds } from "./viewport-culling.ts";

test("camera bounds expand in board space as the camera zooms out", () => {
  const close = cameraFrameBounds({ cameraX: 2000, cameraY: 1500, boardZoom: 2 }, 1920, 1080, 4000);
  const wide = cameraFrameBounds({ cameraX: 2000, cameraY: 1500, boardZoom: 0.5 }, 1920, 1080, 4000);

  assert.equal(close.width, 2000);
  assert.equal(wide.width, 8000);
  assert.equal(wide.height, 4500);
});

test("wide views retain every media rect that intersects the rendered frame", () => {
  const wideCamera = { cameraX: 2000, cameraY: 1500, boardZoom: 0.5 };
  const boardMedia = [
    { x: 0, y: 0, width: 300, height: 200 },
    { x: 1850, y: 1400, width: 300, height: 200 },
    { x: 3700, y: 2800, width: 300, height: 200 },
  ];

  assert.ok(boardMedia.every((rect) => boardRectIntersectsCameraFrame(rect, wideCamera, 1920, 1080, 4000)));
});

test("preview margin includes nearby off-frame media while exact export bounds do not", () => {
  const camera = { cameraX: 2000, cameraY: 1500, boardZoom: 2 };
  const nearby = { x: 3050, y: 1400, width: 100, height: 100 };

  assert.equal(boardRectIntersectsCameraFrame(nearby, camera, 1920, 1080, 4000, 0), false);
  assert.equal(boardRectIntersectsCameraFrame(nearby, camera, 1920, 1080, 4000, 0.35), true);
});
