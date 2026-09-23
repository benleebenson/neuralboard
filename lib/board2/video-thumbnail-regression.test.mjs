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

test("video cards paint captured thumbnails on mobile and desktop boards", () => {
  const thumbnailBackgrounds = source.match(/backgroundColor: "#1a1a2e", backgroundImage: clip\.thumbnailBlobUrl \? `url\(\$\{clip\.thumbnailBlobUrl\}\)`/g) ?? [];
  assert.equal(thumbnailBackgrounds.length, 2);
  assert.match(source, /function registerVideoThumbnail/);
  assert.match(source, /captureVideoThumbnail\(clipId, url\)/);
});

test("restored YouTube cards keep a thumbnail and expose a pointer-safe re-download button", () => {
  const savePath = bodyBetween("async function buildRecipeManifest", "async function saveBoard");
  assert.match(savePath, /needsRedownload: true,[\s\S]*thumbnailDataUri:/);
  assert.match(savePath, /thumbnailBlobUrl: _t/);

  const loadPath = bodyBetween("async function loadBoard", "async function redownloadYtClip");
  assert.match(loadPath, /registerVideoThumbnail\(mc\.id, persistedThumbnailUrl\)/);
  assert.match(loadPath, /img\.youtube\.com\/vi\/\$\{mc\.youtubeId\}\/hqdefault\.jpg/);
  assert.match(loadPath, /thumbnailBlobUrl: _staleThumbnailBlobUrl/);

  const buttons = source.match(/data-video-redownload=\{clip\.id\}/g) ?? [];
  const pointerGuards = source.match(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/g) ?? [];
  assert.equal(buttons.length, 2);
  assert.ok(pointerGuards.length >= 2);
});

test("one YouTube restore refreshes every timeline appearance of the board video", () => {
  const restore = bodyBetween("async function redownloadYtClip", "// ─── Render");
  assert.match(restore, /referencesBoardEntity\(candidate, entityId\)/);
  assert.match(restore, /createVideoElement\(relatedClip\.id, sourceUrl\)/);
  assert.match(restore, /needsRedownload: false/);
});
