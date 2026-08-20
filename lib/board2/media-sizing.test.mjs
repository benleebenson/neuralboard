import test from "node:test";
import assert from "node:assert/strict";
import { fitMediaDimensions } from "./media-sizing.ts";

test("fits portrait images without changing their aspect ratio", () => {
  assert.deepEqual(fitMediaDimensions(1200, 2400), { w: 300, h: 600 });
});

test("fits landscape images without changing their aspect ratio", () => {
  assert.deepEqual(fitMediaDimensions(2400, 1200), { w: 800, h: 400 });
});

test("fits square images without changing their aspect ratio", () => {
  assert.deepEqual(fitMediaDimensions(1600, 1600), { w: 600, h: 600 });
});

test("does not upscale small images", () => {
  assert.deepEqual(fitMediaDimensions(320, 200), { w: 320, h: 200 });
});
