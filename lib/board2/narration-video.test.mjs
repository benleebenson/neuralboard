import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fitNarrationVideoShape,
  narrationVideoMaskCss,
  narrationVideoSourceTime,
  traceNarrationVideoMask,
} from "./narration-video.ts";

test("source time follows the narration clip and holds its first/last frame outside it", () => {
  const narration = { startTime: 2, duration: 10, sourceOffsetSec: 1 };
  assert.deepEqual(narrationVideoSourceTime(narration, 0), { sourceTime: 1, inRange: false });
  assert.deepEqual(narrationVideoSourceTime(narration, 5), { sourceTime: 4, inRange: true });
  assert.deepEqual(narrationVideoSourceTime(narration, 30), { sourceTime: 11, inRange: false });
  assert.equal(narrationVideoSourceTime(narration, 30, 8).sourceTime, 7.999);
});

test("circle crops to a centered square", () => {
  const fit = fitNarrationVideoShape("circle", 1920, 1080);
  assert.equal(fit.crop.top, 0);
  assert.ok(Math.abs(fit.crop.left - 21.875) < 1e-9 && Math.abs(fit.crop.right - 21.875) < 1e-9);
  assert.ok(Math.abs(fit.aspect - 1) < 1e-9);
  assert.equal(narrationVideoMaskCss(fit.mask), "ellipse(50% 50% at 50% 50%)");
});

test("freeform crops to the shape's bounds and re-expresses the polygon inside them", () => {
  const fit = fitNarrationVideoShape("freeform", 1000, 1000, { points: [0.5, 0.2, 0.8, 0.8, 0.2, 0.8] });
  for (const edge of Object.values(fit.crop)) assert.ok(Math.abs(edge - 20) < 1e-9);
  assert.deepEqual(fit.mask.points, [0.5, 0, 1, 1, 0, 1]);
  assert.equal(narrationVideoMaskCss(fit.mask), "polygon(50.000% 0.000%, 100.000% 100.000%, 0.000% 100.000%)");
});

test("crop never exceeds the media editor's 45% per edge", () => {
  const fit = fitNarrationVideoShape("rect", 100, 100, { rect: { x0: 0.9, y0: 0.9, x1: 0.95, y1: 0.97 } });
  assert.ok(fit.crop.left <= 45 && fit.crop.top <= 45);
});

test("the canvas mask traces the same polygon in item coordinates", () => {
  const calls = [];
  const ctx = {
    beginPath: () => calls.push(["begin"]),
    moveTo: (x, y) => calls.push(["move", x, y]),
    lineTo: (x, y) => calls.push(["line", x, y]),
    closePath: () => calls.push(["close"]),
    ellipse: () => calls.push(["ellipse"]),
  };
  assert.equal(traceNarrationVideoMask(ctx, { shape: "freeform", points: [0.5, 0, 1, 1, 0, 1] }, 10, 20, 100, 50), true);
  assert.deepEqual(calls, [["begin"], ["move", 60, 20], ["line", 110, 70], ["line", 10, 70], ["close"]]);
  assert.equal(traceNarrationVideoMask(ctx, { shape: "original" }, 0, 0, 1, 1), false);
});

test("preview and export draw narration videos through the one shared renderer", () => {
  const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
  const renderer = source.slice(source.indexOf("const renderToCtx = useCallback"), source.indexOf("const drawFrame = useCallback"));
  assert.match(renderer, /clip\.narrationVideoFor/);
  assert.match(renderer, /traceNarrationVideoMask\(ctx, clip\.narrationVideoMask/);
  assert.match(source, /narrationVideoSourceTime\(narration, time, sourceDuration\)/);
  // Its own audio track never plays; the narration clip carries the sound.
  assert.match(source, /if \(clip\.muted \|\| clip\.narrationVideoFor\) return 0;/);
});
