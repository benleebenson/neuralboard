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
  assert.match(source, /PREVIEW_IMAGE_CACHE_LIMIT = 144/);
  assert.match(source, /PREVIEW_IMAGE_WARM_CACHE_LIMIT = 48/);
  const cache = bodyBetween("function trimPreviewImageCaches", "function ensureExportImage");
  assert.doesNotMatch(cache, /\.src\s*=\s*""/);
  const overlays = bodyBetween("const drawBoardImageOverlays", "useEffect(() => { drawBoardImageOverlaysRef");
  assert.match(overlays, /if \(image\?\.complete && image\.naturalWidth > 0\) \{[\s\S]*ctx\.clearRect/);
  assert.match(source, /backgroundImage: `url\(\$\{clip\.previewUrl \?\? clip\.sourceUrl\}\)`/);
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
