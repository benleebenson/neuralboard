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

test("focus areas are click-through with border and Option-click selection paths", () => {
  const pointerHandler = bodyBetween("function handleBoardClipPointerDown", "// ─ Board clip resize");
  assert.match(pointerHandler, /e\.altKey && clip\.type !== "customZoom"/);
  assert.match(source, /pointerEvents: clip\.type === "customZoom" \? "none"/);
  assert.match(source, /data-focus-area-border/);
  assert.match(source, /background: "rgba\(184,226,255,0\.09\)"/);
});

test("preview cache remains bounded and never clears a canvas before a replacement is drawable", () => {
  assert.match(source, /calculatePreviewCachePolicy/);
  assert.match(source, /decodedBudgetBytes/);
  assert.match(source, /requestIdleCallback/);
  const cache = bodyBetween("function trimPreviewImageCaches", "function ensureExportImage");
  assert.doesNotMatch(cache, /\.src\s*=\s*""/);
  const overlays = bodyBetween("const drawBoardImageOverlays", "useEffect(() => { drawBoardImageOverlaysRef");
  assert.match(overlays, /if \(image\?\.complete && image\.naturalWidth > 0\) \{[\s\S]*ctx\.clearRect/);
  assert.match(source, /backgroundImage: `url\(\$\{clip\.previewUrl \?\? clip\.sourceUrl\}\)`/);
});

test("experimental deterministic video export paints progress before probing and logs every exact encoder request", () => {
  const exportVideo = bodyBetween("async function startDeterministicExport", "async function startExport");
  assert.ok(exportVideo.indexOf("setIsExporting(true)") < exportVideo.indexOf("await yieldForExportUi()"));
  assert.ok(exportVideo.indexOf("await yieldForExportUi()") < exportVideo.indexOf("VideoEncoder.isConfigSupported"));
  assert.match(exportVideo, /codec: candidate\.videoConfig\.codec/);
  assert.match(exportVideo, /hardwareAcceleration: candidate\.videoConfig\.hardwareAcceleration/);
  assert.match(exportVideo, /console\.info\("\[board2:export\] VideoEncoder\.isConfigSupported"/);
  assert.match(exportVideo, /selectedCandidate\.width/);
  assert.match(exportVideo, /new WebMMuxer/);
});

test("paste creates timeline references and recipe persistence preserves every appearance", () => {
  const paste = bodyBetween("async function pasteClip", "async function duplicateClip");
  assert.match(paste, /mediaId: boardEntityId\(src\), featured: true/);
  const recipe = bodyBetween("const boardMediaById", "const snapshotThumbnail");
  assert.match(recipe, /boardMediaById/);
  assert.match(recipe, /mediaId: clip\.mediaId \?\? clip\.id/);
  const load = bodyBetween("const normalizedRecipeClips", "const manifest = schemaVersion");
  assert.match(load, /const appearances = blocks/);
  assert.match(load, /return \[canonical, \.\.\.appearances\]/);
});

test("manual image ingestion stays board-only until the explicit playhead action", () => {
  const placement = bodyBetween("async function addClipAndPlaceOnBoard", "function queueMediaPlacement");
  assert.match(placement, /const shouldFeatureOnTimeline = item\.type === "video"/);
  assert.match(placement, /!shouldFeatureOnTimeline \? \{ mediaId: clipId, featured: false as const \}/);
  assert.match(placement, /shouldFeatureOnTimeline[\s\S]*resolveManualTimelineInsertion/);

  const ingestion = bodyBetween("async function ingestMediaFile", "function openPlayAddMenu");
  assert.match(ingestion, /await addClipAndPlaceOnBoard\(item, center\)/);
  assert.match(ingestion, /function handleBoardFileDrop/);
  assert.match(ingestion, /await ingestMediaFile\(file, file\.name/);

  const browserImage = bodyBetween("async function commitImagePlaceholder", "function openTrimModalForPlaceholder");
  assert.match(browserImage, /mediaId: clipId, featured: false as const/);
  assert.doesNotMatch(browserImage, /resolveManualTimelineInsertion/);

  const featureAction = bodyBetween("function addBoardMediaToTimeline", "function addPanClip");
  assert.match(featureAction, /const requestedStart = playheadRef\.current/);
  assert.match(featureAction, /resolveManualTimelineInsertion\(prev, requestedStart/);
  assert.match(featureAction, /featured: true/);
});

test("auto-build remains featured and camera events ignore board-only scenery", () => {
  const autoBuild = bodyBetween("const autoClips: Clip[]", "clipsRef.current = nextClips");
  assert.match(autoBuild, /featured: true/);
  assert.match(autoBuild, /startTime,/);

  const camera = bodyBetween("function generateCameraKeyframes", "// ─ AI character choreography");
  assert.match(camera, /topicAwareClips[\s\S]*filter\(\(clip\) => isFeaturedTimelineClip\(clip\)/);
  assert.match(camera, /allClipsSorted[\s\S]*filter\(\(c\) => isFeaturedTimelineClip\(c\)/);
  assert.match(camera, /boardPlacedClips = clipsRef\.current\.filter/);
});

test("all new image placement waits for decoded intrinsic dimensions", () => {
  const placement = bodyBetween("async function addClipAndPlaceOnBoard", "function queueMediaPlacement");
  assert.match(placement, /await decodeImageForPlacement\(item\.url\)/);
  const ingestion = bodyBetween("async function ingestMediaFile", "async function handleMediaUpload");
  assert.match(ingestion, /await decodeImageForPlacement\(url\)/);
  const browserImage = bodyBetween("async function commitImagePlaceholder", "function openTrimModalForPlaceholder");
  assert.match(browserImage, /await decodeImageForPlacement\(blobUrl\)/);
  const timelineDrop = bodyBetween("async function handleTimelineDrop", "// ─ Play \/ pause");
  assert.match(timelineDrop, /await decodeImageForPlacement\(item\.url\)/);
  assert.match(source, /return fitMediaDimensions\(img\.naturalWidth, img\.naturalHeight\)/);
});
