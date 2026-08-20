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

test("real-time export predecodes images, culls off-camera work, and stays the default", () => {
  const render = bodyBetween("const renderToCtx = useCallback", "const drawFrame = useCallback");
  assert.match(render, /boardRectIntersectsCameraFrame/);
  assert.match(render, /quality === "preview" \|\| quality === "realtime-export"/);
  assert.match(render, /quality === "preview" \? 0\.35 : 0/);
  assert.match(render, /boardEntityRepresentativesAtTime/);

  const realtime = bodyBetween("async function startRealtimeExport", "async function startDeterministicExport");
  assert.match(realtime, /currentClips\.filter\(\(clip\) => clip\.type === "image"\)/);
  assert.match(realtime, /ensureAnnotationFontsLoaded/);
  assert.match(realtime, /ensureExportImage/);
  assert.match(realtime, /captureStream/);
  assert.match(realtime, /new MediaRecorder/);
  assert.match(realtime, /requestAnimationFrame/);
  assert.match(realtime, /"realtime-export"/);
  assert.match(realtime, /videoBitsPerSecond/);

  const wrapper = bodyBetween("async function startExport", "async function exportBoardImage");
  assert.match(wrapper, /DETERMINISTIC_EXPORT_ENABLED/);
  assert.ok(wrapper.indexOf("startRealtimeExport") > wrapper.indexOf("startDeterministicExport"));
  assert.match(source, /const DETERMINISTIC_EXPORT_ENABLED = process\.env\.NEXT_PUBLIC_DETERMINISTIC_EXPORT === "1"/);
});

test("deterministic WebCodecs export remains available behind the experimental flag", () => {
  const deterministic = bodyBetween("async function startDeterministicExport", "async function startExport");
  assert.match(deterministic, /VideoEncoder\.isConfigSupported/);
  assert.match(deterministic, /prepareOfflineImagesForFrame/);
  assert.match(deterministic, /new VideoFrame/);
  assert.doesNotMatch(deterministic, /new MediaRecorder/);
});
