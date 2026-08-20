import test from "node:test";
import assert from "node:assert/strict";
import { decodedImageBytes, previewCachePolicy } from "./image-cache-policy.ts";

test("large boards use a bounded adaptive cache well below the former 192 entries", () => {
  const policy = previewCachePolicy({ deviceMemoryGb: 8, boardImageCount: 312 });
  assert.ok(policy.hotEntries + policy.warmEntries <= 96);
  assert.ok(policy.hotEntries + policy.warmEntries < 192);
  assert.equal(policy.preloadViewportMargin, 0.25);
});

test("decoded image accounting measures RGBA pixel memory", () => {
  assert.equal(decodedImageBytes([{ complete: true, naturalWidth: 1280, naturalHeight: 720 }]), 1280 * 720 * 4);
});
