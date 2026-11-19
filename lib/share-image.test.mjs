import test from "node:test";
import assert from "node:assert/strict";
import { isAnimatedWebp, SHARE_IMAGE_MAX_SIDE, shareImagePlan } from "./board2/share-image.ts";

const MB = 1024 * 1024;

test("an oversized phone photo is resized to the max side and re-saved as JPEG", () => {
  assert.deepEqual(shareImagePlan({ mime: "image/jpeg", width: 4032, height: 3024, size: 6 * MB, animated: false }), { action: "jpeg", width: SHARE_IMAGE_MAX_SIDE, height: 1920, quality: 0.82 });
  assert.deepEqual(shareImagePlan({ mime: "image/heic", width: 3024, height: 4032, size: 2 * MB, animated: false }), { action: "jpeg", width: 1920, height: SHARE_IMAGE_MAX_SIDE, quality: 0.82 });
  const heavyPng = shareImagePlan({ mime: "image/png", width: 2000, height: 1000, size: 9 * MB, animated: false });
  assert.deepEqual(heavyPng, { action: "jpeg", width: 2000, height: 1000, quality: 0.82 }, "heavy but not too wide: re-saved at full size");
});

test("small JPEG and HEIC are re-saved at full size, dropping their metadata", () => {
  assert.deepEqual(shareImagePlan({ mime: "image/jpeg", width: 1200, height: 900, size: MB, animated: false }), { action: "jpeg", width: 1200, height: 900, quality: 0.9 });
  assert.equal(shareImagePlan({ mime: "image/heif", width: 1200, height: 900, size: MB, animated: false }).action, "jpeg");
});

test("small PNG/WebP and anything animated keep their bytes", () => {
  assert.equal(shareImagePlan({ mime: "image/png", width: 1200, height: 900, size: MB, animated: false }).action, "keep");
  assert.equal(shareImagePlan({ mime: "image/webp", width: 1200, height: 900, size: MB, animated: false }).action, "keep");
  assert.equal(shareImagePlan({ mime: "image/gif", width: 4000, height: 4000, size: 12 * MB, animated: false }).action, "keep");
  assert.equal(shareImagePlan({ mime: "image/webp", width: 4000, height: 4000, size: 12 * MB, animated: true }).action, "keep");
});

test("animated WebP is told apart from a still one by the VP8X animation flag", () => {
  const webp = (chunk, flags) => { const bytes = new Uint8Array(32); bytes.set(new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`)); bytes[20] = flags; return bytes; };
  assert.equal(isAnimatedWebp(webp("VP8X", 0x02)), true);
  assert.equal(isAnimatedWebp(webp("VP8X", 0x10)), false, "alpha only");
  assert.equal(isAnimatedWebp(webp("VP8 ", 0x02)), false, "simple lossy");
  assert.equal(isAnimatedWebp(new Uint8Array(8)), false);
});
