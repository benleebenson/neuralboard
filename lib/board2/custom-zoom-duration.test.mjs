import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CUSTOM_ZOOM_DURATION,
  MAX_CUSTOM_ZOOM_DURATION,
  MIN_CUSTOM_ZOOM_DURATION,
  normalizeCustomZoomDuration,
} from "./custom-zoom-duration.ts";

test("custom zoom duration defaults to 1.2 seconds and rounds to tenths", () => {
  assert.equal(DEFAULT_CUSTOM_ZOOM_DURATION, 1.2);
  assert.equal(normalizeCustomZoomDuration(undefined), 1.2);
  assert.equal(normalizeCustomZoomDuration(0.799999999), 0.8);
  assert.equal(normalizeCustomZoomDuration("2.5"), 2.5);
});

test("custom zoom duration is constrained to the supported range", () => {
  assert.equal(normalizeCustomZoomDuration(0.1), MIN_CUSTOM_ZOOM_DURATION);
  assert.equal(normalizeCustomZoomDuration(9), MAX_CUSTOM_ZOOM_DURATION);
});
