import test from "node:test";
import assert from "node:assert/strict";
import {
  animatedImageFrameIndex,
  animatedImageSourceUrl,
  isAnimatableImageType,
  mergeFrameDurations,
  normalizedFrameDurationMs,
} from "./animated-image.ts";

test("picks the frame showing at a timeline instant and loops from zero", () => {
  const starts = [0, 100, 250, 300];
  const loop = 400;
  assert.equal(animatedImageFrameIndex(starts, loop, 0), 0);
  assert.equal(animatedImageFrameIndex(starts, loop, 0.099), 0);
  assert.equal(animatedImageFrameIndex(starts, loop, 0.1), 1);
  assert.equal(animatedImageFrameIndex(starts, loop, 0.26), 2);
  assert.equal(animatedImageFrameIndex(starts, loop, 0.399), 3);
  assert.equal(animatedImageFrameIndex(starts, loop, 0.4), 0);
  assert.equal(animatedImageFrameIndex(starts, loop, 1.3), 1);
  assert.equal(animatedImageFrameIndex([0], 100, 5), 0);
});

test("treats tiny GIF delays the way browsers display them", () => {
  assert.equal(normalizedFrameDurationMs(0), 100);
  assert.equal(normalizedFrameDurationMs(10_000), 100);
  assert.equal(normalizedFrameDurationMs(40_000), 40);
  assert.equal(normalizedFrameDurationMs(null), 100);
});

test("merges long frame lists without changing the loop length", () => {
  const durations = Array.from({ length: 10 }, () => 50);
  const merged = mergeFrameDurations(durations, 4);
  assert.deepEqual(merged.keep, [0, 3, 6, 9]);
  assert.deepEqual(merged.durationsMs, [150, 150, 150, 50]);
  assert.equal(merged.durationsMs.reduce((a, b) => a + b, 0), 500);
  assert.deepEqual(mergeFrameDurations([10, 20]).keep, [0, 1]);
});

test("finds the real GIF behind a pasted or dropped image URL", () => {
  assert.equal(animatedImageSourceUrl("https://upload.wikimedia.org/a/b/Earth.gif"), "https://upload.wikimedia.org/a/b/Earth.gif");
  assert.equal(animatedImageSourceUrl("https://example.com/cat.GIF?x=1"), "https://example.com/cat.GIF?x=1");
  assert.equal(animatedImageSourceUrl("https://example.com/cat.png"), null);
  assert.equal(animatedImageSourceUrl("https://example.com/cat.webp"), null);
  assert.equal(
    animatedImageSourceUrl("https://media2.giphy.com/media/v1.Y2lk/abc123/giphy.webp?cid=1&rid=giphy.webp&ct=g"),
    "https://media2.giphy.com/media/v1.Y2lk/abc123/giphy.gif?cid=1&ct=g",
  );
  assert.equal(animatedImageSourceUrl("https://media.giphy.com/media/abc123/200w.mp4"), "https://media.giphy.com/media/abc123/200w.gif");
  assert.equal(animatedImageSourceUrl("https://giphy.com/gifs/funny-cat-dance-abc123XYZ"), "https://media.giphy.com/media/abc123XYZ/giphy.gif");
  assert.equal(animatedImageSourceUrl("https://giphy.com/gifs/abc123XYZ"), "https://media.giphy.com/media/abc123XYZ/giphy.gif");
  assert.equal(animatedImageSourceUrl("https://media.tenor.com/abcAAAAd/dance.webp"), "https://media.tenor.com/abcAAAAd/dance.webp");
  assert.equal(animatedImageSourceUrl("https://media1.tenor.com/m/abcAAAAC/dance.gif"), "https://media1.tenor.com/m/abcAAAAC/dance.gif");
  assert.equal(animatedImageSourceUrl("https://tenor.com/view/dance-gif-123"), null);
  assert.equal(animatedImageSourceUrl("data:image/gif;base64,R0lGOD"), "data:image/gif;base64,R0lGOD");
  assert.equal(animatedImageSourceUrl("data:image/png;base64,AAA"), null);
  assert.equal(animatedImageSourceUrl("blob:http://localhost:3000/x"), null);
  assert.equal(animatedImageSourceUrl("not a url"), null);
  assert.equal(animatedImageSourceUrl(""), null);
});

test("only GIF and WebP can animate", () => {
  assert.equal(isAnimatableImageType("image/gif"), true);
  assert.equal(isAnimatableImageType("image/webp; charset=binary"), true);
  assert.equal(isAnimatableImageType("image/png"), false);
});
