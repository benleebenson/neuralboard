import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source markers: ${startMarker}`);
  return source.slice(start, end);
}

test("idle character poses consume the generated narration gesture pose", () => {
  const idlePose = bodyBetween("const idlePose =", "const active = resolved.find");
  assert.match(idlePose, /leftArmA: gesturePose\.leftArmA/);
  assert.match(idlePose, /rightForeA: gesturePose\.rightForeA/);
});

test("continuous narration sync corrects drift and every resume uses an exact seek boundary", () => {
  const sync = bodyBetween("function syncNarrationAudio", "function stopNarrationAudio");
  assert.match(sync, /narrationResyncTarget/);
  assert.match(sync, /shouldResumeNarrationPlayback\(element\)/);

  const start = bodyBetween("function startNarrationAudio", "function syncNarrationAudio");
  assert.match(start, /seekNarrationElement\(clip, element, timelineTime, true\)/);
});

test("auto-build derives placed blocks and camera stops from the same narration-locked sequence", () => {
  const autoBuild = bodyBetween("async function autoBuildFromNarration", "async function generateNarrationLipSync");
  assert.match(autoBuild, /buildNarrationLockedImageWindows/);
  assert.match(autoBuild, /imageFocusRatio:\s*AUTO_IMAGE_FOCUS_RATIO/);
});

test("offline export lazily prepares camera-visible images and disables render-time viewport culling", () => {
  const render = bodyBetween("const renderToCtx = useCallback", "const drawFrame = useCallback");
  assert.match(render, /boardRectIntersectsCameraFrame/);
  assert.match(render, /quality === "preview" && !boardRectIntersectsCameraFrame/);
  assert.match(render, /0\.35,/);
  assert.match(render, /boardEntityRepresentativesAtTime/);

  const exportVideo = bodyBetween("async function startExport", "function playBoardPointFromClient");
  assert.match(exportVideo, /currentClips\.filter\(\(clip\) => clip\.type === "image"\)/);
  assert.match(exportVideo, /prepareOfflineImagesForFrame/);
  assert.match(exportVideo, /Preparing assets/);
  assert.doesNotMatch(exportVideo, /captureStream|MediaRecorder|requestAnimationFrame/);
});
