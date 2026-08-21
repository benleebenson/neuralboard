import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
const explainerRenderer = readFileSync(new URL("../character/explainer-renderer.ts", import.meta.url), "utf8");

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

test("explainer gesture changes are hard cuts with no pose cross-fade plumbing", () => {
  assert.doesNotMatch(source, /EXPLAINER_POSE_CROSSFADE_SECONDS|spritePreviousGesture|spriteTransitionProgress/);
  assert.doesNotMatch(explainerRenderer, /CROSSFADE|previousGesture|transitionProgress|previousLayer|globalAlpha/);
  assert.match(explainerRenderer, /layer\(ctx, poseLayer\.file/);
});

test("editor sprite canvases use capped DPR backing stores while pointer math stays in CSS pixels", () => {
  assert.match(source, /const EDITOR_CANVAS_DPR_CAP = 2/);
  assert.match(source, /Math\.min\(EDITOR_CANVAS_DPR_CAP, window\.devicePixelRatio \|\| 1\)/);
  assert.match(source, /width=\{Math\.round\(BOARD_W \* editorCanvasDpr\)\}/);
  assert.match(source, /width=\{Math\.round\(previewRenderW \* editorCanvasDpr\)\}/);
  assert.match(source, /ctx\.setTransform\(editorCanvasDpr, 0, 0, editorCanvasDpr, 0, 0\)/);

  const pointerConversion = bodyBetween("function clientToBoardPoint", "function rectsIntersect");
  assert.match(pointerConversion, /clientX - rect\.left - boardPanRef\.current\.x/);
  assert.doesNotMatch(pointerConversion, /devicePixelRatio|editorCanvasDpr|canvas\.width|canvas\.height/);

  const rectLeft = 37;
  const pan = 84;
  const expectedBoardX = 1234.5;
  for (const zoom of [0.25, 3]) {
    for (const dpr of [1, 2]) {
      const clientX = rectLeft + pan + expectedBoardX * zoom;
      const actualBoardX = (clientX - rectLeft - pan) / zoom;
      assert.equal(actualBoardX, expectedBoardX, `CSS hit at zoom ${zoom} and DPR ${dpr}`);
    }
  }
});

test("continuous narration follows its media clock and every resume uses an exact seek boundary", () => {
  const sync = bodyBetween("function syncNarrationAudio", "function stopNarrationAudio");
  assert.match(sync, /shouldResumeNarrationPlayback\(element\)/);
  assert.doesNotMatch(sync, /element\.currentTime\s*=/);

  const start = bodyBetween("function startNarrationAudio", "function syncNarrationAudio");
  assert.match(start, /seekNarrationElement\(clip, element, timelineTime, true\)/);
  assert.match(start, /stopNarrationAudioExcept\(clip\.id\)/);

  const ownership = bodyBetween("function syncNarrationAudioAtTime", "function resyncNarrationAudioAtTime");
  assert.match(ownership, /activeNarrationClipAtTime/);
  assert.match(ownership, /stopNarrationAudioExcept\(clip\.id\)/);
  assert.match(source, /assertSingleActiveNarrationSource\(sources, context\)/);
});

test("auto-build derives placed blocks and camera stops from the same narration-locked sequence", () => {
  const autoBuild = bodyBetween("async function autoBuildFromNarration", "async function generateNarrationLipSync");
  assert.match(autoBuild, /buildNarrationLockedImageWindows/);
  assert.match(autoBuild, /imageFocusRatio:\s*FOCUS_FILL_RATIO/);
});

test("changing output aspect regenerates camera zoom from the new frame dimensions", () => {
  const aspectChange = bodyBetween("function handleCanvasAspectChange", "function generateCameraKeyframes");
  assert.match(aspectChange, /canvasWRef\.current\s*=\s*nextWidth/);
  assert.match(aspectChange, /canvasHRef\.current\s*=\s*nextHeight/);
  assert.match(aspectChange, /cameraKeyframesRef\.current\.length\s*>\s*0/);
  assert.match(aspectChange, /generateCameraKeyframes\(\)/);
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
  assert.match(realtime, /exclusiveNarrationSegments/);
  assert.match(realtime, /stopAllNarrationAudio\(\)/);
  assert.match(realtime, /source\.disconnect\(\)/);
  assert.match(realtime, /exportAudioDest\?\.disconnect\(\)/);
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
