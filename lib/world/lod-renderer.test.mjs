import test from "node:test";
import assert from "node:assert/strict";

// Minimal canvas stand-in so the cache logic can run without a browser; it counts renders.
let surfaces = 0;
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; surfaces += 1; }
  getContext() {
    return { fillRect() {}, drawImage() {}, set fillStyle(_) {}, set globalAlpha(_) {}, set imageSmoothingEnabled(_) {}, set imageSmoothingQuality(_) {} };
  }
};

const { FarBlobCache, drawRegion, lodWeights } = await import("./lod-renderer.ts");

const region = (id, fingerprint) => ({ id, name: id, bounds: { x: 0, y: 0, width: 4000, height: 3000 }, lod: { contentFingerprint: fingerprint, media: [], far: { cols: 4, rows: 3, extentWidth: 1000, extentHeight: 800, density: Array(12).fill(50) } } });

test("LOD weights always sum to 1 and cross-fade monotonically through the thresholds", () => {
  let previous = lodWeights(0.001);
  assert.deepEqual(previous, { far: 1, mid: 0, near: 0 });
  for (let zoom = 0.002; zoom <= 3; zoom *= 1.05) {
    const weights = lodWeights(zoom);
    assert.ok(Math.abs(weights.far + weights.mid + weights.near - 1) < 1e-9, `sum at ${zoom}`);
    assert.ok(weights.far <= previous.far + 1e-12, "far only fades out as you zoom in");
    assert.ok(weights.near >= previous.near - 1e-12, "near only fades in as you zoom in");
    // No pop: adjacent zoom steps never jump a layer's opacity by more than a small amount.
    assert.ok(Math.abs(weights.far - previous.far) < 0.2 && Math.abs(weights.near - previous.near) < 0.2);
    previous = weights;
  }
  assert.deepEqual(lodWeights(2), { far: 0, mid: 0, near: 1 });
});

test("a far blob is built once per content fingerprint, not per frame", () => {
  const cache = new FarBlobCache();
  const a = region("a", "fp1");
  const before = surfaces;
  for (let frame = 0; frame < 300; frame += 1) assert.ok(cache.get(a, frame));
  assert.equal(cache.stats().built, 1);
  assert.equal(surfaces - before, 2, "one blob surface plus one tiny grid surface, once");
  assert.equal(cache.get(region("a", "fp2"), 301) !== null, true);
  assert.equal(cache.stats().built, 2, "contents changed → regenerated exactly once");
  cache.get(region("a", "fp2"), 302);
  assert.equal(cache.stats().built, 2);
});

test("prewarm builds missing blobs within a budget and reports what is left", () => {
  const cache = new FarBlobCache();
  const regions = Array.from({ length: 30 }, (_, index) => region(`r${index}`, `fp${index}`));
  assert.equal(cache.prewarm(regions, 10_000, 0), 0);
  assert.equal(cache.stats().cached, 30);
  assert.equal(cache.prewarm(regions, 10_000, 1), 0);
  assert.equal(cache.stats().built, 30, "a second pass builds nothing");
  const fresh = new FarBlobCache();
  assert.equal(fresh.prewarm(regions, -1, 0), 30, "no budget → nothing built, all reported remaining");
});

test("the cache is bounded however large the world grows", () => {
  const cache = new FarBlobCache();
  for (let index = 0; index < 700; index += 1) cache.get(region(`r${index}`, `fp${index}`), index);
  assert.ok(cache.stats().cached <= 400);
});

test("FAR requests no media at all and blits one cached bitmap per region; MID asks only for previews", () => {
  const media = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, type: "image", x: (index % 8) * 440, y: Math.floor(index / 8) * 520, width: 380, height: 300, rotation: 0, asset: `${"ab".repeat(16)}.jpg`, preview: true }));
  const rich = { ...region("r", "fp"), lod: { ...region("r", "fp").lod, media } };
  const wants = [];
  const images = { want: (path, kind) => wants.push({ path, kind }), get: () => undefined, isFailed: () => false };
  const calls = { drawImage: 0 };
  const ctx = new Proxy({}, { get: (_, name) => name === "drawImage" ? () => { calls.drawImage += 1; } : () => {}, set: () => true });
  const blobs = new FarBlobCache();
  const frame = (zoom) => ({ camera: { x: 2000, y: 1500, zoom }, viewport: { x: -1e6, y: -1e6, width: 2e6, height: 2e6 }, weights: lodWeights(zoom), now: 0, images, blobs, isSelected: () => false });
  drawRegion(ctx, rich, frame(0.03));
  assert.equal(wants.length, 0, "no media requested at FAR");
  assert.equal(calls.drawImage, 1, "exactly the region's cached blob");
  drawRegion(ctx, rich, frame(0.2));
  assert.ok(wants.length > 0 && wants.every((want) => want.kind === "preview" && want.path.startsWith("previews/")), "MID loads previews only, never originals");
  wants.length = 0;
  drawRegion(ctx, rich, frame(0.7));
  assert.ok(wants.every((want) => want.kind === "preview"), "items smaller than a preview on screen keep using the preview even at NEAR");
  wants.length = 0;
  drawRegion(ctx, rich, frame(2));
  assert.ok(wants.some((want) => want.kind === "full" && want.path.startsWith("assets/")), "large on screen → the original");
});
