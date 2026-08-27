import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEECH_BUBBLE_FRAME_MARGIN_RATIO,
  placeSpeechBubbleInFrame,
} from "./speech-bubble-placement.ts";

function assertInsideSafeFrame(rect, width, height) {
  const margin = Math.min(width, height) * SPEECH_BUBBLE_FRAME_MARGIN_RATIO;
  assert.ok(rect.x >= margin);
  assert.ok(rect.y >= margin);
  assert.ok(rect.x + rect.width <= width - margin);
  assert.ok(rect.y + rect.height <= height - margin);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("keeps bubbles inside a seven-percent short-edge margin in both output aspects", () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const image = { x: width * 0.18, y: height * 0.2, width: width * 0.64, height: height * 0.58 };
    for (const seed of [0, 0.2, 0.51, 0.99]) {
      const result = placeSpeechBubbleInFrame(width, height, 310, 130, image, { x: width / 2, y: height * 0.7 }, seed);
      assertInsideSafeFrame(result, width, height);
    }
  }
  assert.equal(SPEECH_BUBBLE_FRAME_MARGIN_RATIO, 0.07);
});

test("uses clear parchment above the focused image before overlapping it", () => {
  const image = { x: 300, y: 350, width: 1320, height: 620 };
  const result = placeSpeechBubbleInFrame(1920, 1080, 310, 130, image, { x: 960, y: 700 }, 0.4);
  assert.ok(result.y + result.height < image.y);
  assert.equal(overlaps(result, image), false);
});

test("uses clear side space in portrait when there is insufficient room above", () => {
  const image = { x: 80, y: 100, width: 650, height: 1620 };
  const result = placeSpeechBubbleInFrame(1080, 1920, 240, 150, image, { x: 500, y: 800 }, 0.8);
  assert.ok(result.x > image.x + image.width);
  assert.equal(overlaps(result, image), false);
});

test("falls back deterministically inside the frame when a 94-percent image leaves no clear region", () => {
  const image = { x: 32, y: 32, width: 1856, height: 1016 };
  const first = placeSpeechBubbleInFrame(1920, 1080, 310, 130, image, { x: 960, y: 650 }, 0.73);
  const second = placeSpeechBubbleInFrame(1920, 1080, 310, 130, image, { x: 960, y: 650 }, 0.73);
  assert.deepEqual(first, second);
  assertInsideSafeFrame(first, 1920, 1080);
  assert.equal(overlaps(first, image), true);
});
