import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CUSTOM_ZOOM_DURATION } from "./custom-zoom-duration.ts";
import { resolveCustomZoomInsertion } from "./timeline-placement.ts";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

function bodyBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("five uninterrupted regions form five stepper-duration blocks", () => {
  const blocks = [];
  for (let index = 0; index < 5; index += 1) {
    const placement = resolveCustomZoomInsertion(blocks, 10, DEFAULT_CUSTOM_ZOOM_DURATION, 1, 5);
    blocks.push({
      type: "customZoom",
      startTime: placement.startTime,
      duration: DEFAULT_CUSTOM_ZOOM_DURATION,
      layer: placement.layer,
    });
  }

  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks.map((block) => block.startTime), [10, 11.2, 12.4, 13.6, 14.8]);
  assert.deepEqual(blocks.map((block) => block.duration), [1.2, 1.2, 1.2, 1.2, 1.2]);
});

test("continuous Custom Zoom remains armed after each completed region", () => {
  const finishGesture = bodyBetween("function finishCustomZoomGlassPointer", "// ─ Timeline drag");
  assert.match(finishGesture, /if \(!customZoomContinuousRef\.current\) disarmCustomZoomDrawMode\(\)/);
  assert.match(finishGesture, /addCustomZoomClip\(minBX, minBY, bw, bh\)/);

  const creation = bodyBetween("function addCustomZoomClip", "function adjustCustomZoomDuration");
  assert.match(creation, /const duration = customZoomDurationRef\.current/);
  assert.match(creation, /clipsRef\.current = \[\.\.\.existingClips, clip\]/);
  assert.match(creation, /resolveCustomZoomInsertion/);
});

test("continuous preference is session-persisted and has a 44px coarse-pointer toggle", () => {
  assert.match(source, /CUSTOM_ZOOM_CONTINUOUS_STORAGE_KEY/);
  assert.match(source, /window\.sessionStorage\.getItem\(CUSTOM_ZOOM_CONTINUOUS_STORAGE_KEY\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(CUSTOM_ZOOM_CONTINUOUS_STORAGE_KEY, next \? "1" : "0"\)/);
  assert.match(source, /className="nb-custom-zoom-continuous"/);
  assert.match(source, /\.nb-custom-zoom-continuous \{ min-width: 44px !important; min-height: 44px !important; \}/);
});

test("armed Custom Zoom exposes both exit affordances and navigation gestures", () => {
  const keyboard = bodyBetween("// ─ Keyboard shortcuts", "// ─ Clipboard image paste");
  assert.match(keyboard, /e\.code === "Escape" && customZoomDrawModeRef\.current/);
  assert.match(keyboard, /disarmCustomZoomDrawMode\(\)/);

  const toggle = bodyBetween("function toggleCustomZoomDrawMode", "function toggleCustomZoomContinuous");
  assert.match(toggle, /if \(customZoomDrawModeRef\.current\)/);
  assert.match(toggle, /disarmCustomZoomDrawMode\(\)/);

  const pointerDown = bodyBetween("function handleCustomZoomGlassPointerDown", "function handleCustomZoomGlassPointerMove");
  assert.match(pointerDown, /isSpaceDownRef\.current \|\| e\.button === 1/);
  assert.match(pointerDown, /type: "touch-navigation"/);
  assert.match(source, /Two fingers pan and pinch/);
});
