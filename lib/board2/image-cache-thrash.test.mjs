import test from "node:test";
import assert from "node:assert/strict";
import { createFailedSourceMemo, PREVIEW_CACHE_PROTECT_MS, trimTieredCache } from "./image-cache-policy.ts";

// Models the board overlay draw: every pass looks up every on-screen image; a miss loads it, and
// each completed load inserts, trims, and triggers another draw pass (as loadMedia's onload does).
function simulateDraws({ onScreen, limits, protectMs, passes = 20, bytesPerImage = 1 }) {
  const hot = new Map();
  const warm = new Map();
  const lastUsed = new Map();
  let clock = 0;
  let loads = 0;
  const touch = (url) => lastUsed.set(url, clock);
  const get = (url) => {
    if (hot.has(url)) { const v = hot.get(url); hot.delete(url); hot.set(url, v); touch(url); return v; }
    if (warm.has(url)) { const v = warm.get(url); warm.delete(url); hot.set(url, v); touch(url); trim(); return v; }
    return undefined;
  };
  const trim = () => trimTieredCache(hot, warm, limits, {
    bytes: (values) => values.length * bytesPerImage,
    isProtected: (url) => clock - (lastUsed.get(url) ?? -Infinity) < protectMs,
  });
  for (let pass = 0; pass < passes; pass++) {
    clock += 16;
    const misses = onScreen.filter((url) => !get(url));
    for (const url of misses) {
      loads++;
      clock += 5;
      hot.set(url, { url });
      touch(url);
      trim();
    }
  }
  return { loads, size: hot.size + warm.size };
}

const onScreen = Array.from({ length: 45 }, (_, index) => `img-${index}`);
const limits = { hotEntries: 20, warmEntries: 5, decodedBudgetBytes: 30 };

test("without protection, more on-screen images than the cache holds reload on every draw", () => {
  const { loads } = simulateDraws({ onScreen, limits, protectMs: 0 });
  assert.ok(loads > onScreen.length * 5, `expected thrash, got ${loads} loads`);
});

test("protecting the recently drawn working set loads each on-screen image exactly once", () => {
  const { loads, size } = simulateDraws({ onScreen, limits, protectMs: PREVIEW_CACHE_PROTECT_MS });
  assert.equal(loads, onScreen.length);
  assert.equal(size, onScreen.length, "the cache runs over budget while those images are on screen");
});

test("once images leave the screen and the window passes, the budget applies again", () => {
  const hot = new Map(onScreen.map((url) => [url, url]));
  const warm = new Map();
  const result = trimTieredCache(hot, warm, limits, { bytes: (values) => values.length, isProtected: () => false });
  assert.equal(hot.size, limits.hotEntries);
  assert.ok(hot.size + warm.size <= limits.decodedBudgetBytes);
  assert.equal(result.evicted[0], "img-0", "least recently used goes first");
});

test("a failed blob: URL is never retried; other URLs back off exponentially and recover on success", () => {
  let now = 0;
  const memo = createFailedSourceMemo({ baseMs: 1000, maxMs: 8000, now: () => now });
  assert.equal(memo.recordFailure("blob:https://www.neuralboard.org/dead"), Infinity);
  now = 1e12;
  assert.ok(memo.shouldSkip("blob:https://www.neuralboard.org/dead"));

  now = 0;
  const url = "https://storage.example/a.webp";
  assert.equal(memo.shouldSkip(url), false);
  assert.equal(memo.recordFailure(url), 1000);
  assert.ok(memo.shouldSkip(url));
  now = 1000;
  assert.equal(memo.shouldSkip(url), false);
  assert.equal(memo.recordFailure(url), 2000);
  memo.recordFailure(url); memo.recordFailure(url);
  assert.equal(memo.recordFailure(url), 8000, "capped");
  memo.recordSuccess(url);
  assert.equal(memo.shouldSkip(url), false);
  assert.equal(memo.failureCount(url), 0);
});
