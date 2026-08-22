import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

function bodyBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("new custom zoom blocks use the current preference without changing other defaults", () => {
  const customZoomCreation = bodyBetween("function addCustomZoomClip", "function adjustCustomZoomDuration");
  assert.match(customZoomCreation, /const duration = customZoomDurationRef\.current/);

  const panCreation = bodyBetween("function addPanClip", "function addCharacterFocusClip");
  assert.match(panCreation, /const duration = 5/);
  const characterFocusCreation = bodyBetween("function addCharacterFocusClip", "function addCustomZoomClip");
  assert.match(characterFocusCreation, /const duration = 3/);
});

test("the preference is saved and restored in recipe timeline settings", () => {
  const savePath = bodyBetween("async function buildRecipeManifest", "async function saveBoard");
  assert.match(savePath, /schemaVersion: 6 as const/);
  assert.match(savePath, /customZoomDurationSeconds: customZoomDurationRef\.current/);

  const loadPath = bodyBetween("async function loadBoard", "async function redownloadYtClip");
  assert.match(loadPath, /customZoomDurationSeconds: rawManifest\.timeline\?\.customZoomDurationSeconds/);
  assert.match(loadPath, /customZoomDurationRef\.current = loadedCustomZoomDuration/);
  assert.match(loadPath, /setCustomZoomDuration\(loadedCustomZoomDuration\)/);
});

test("the toolbar stepper is available in Board Mode with coarse-pointer targets", () => {
  assert.match(source, /\{renderCustomZoomControls\(\)\}/);
  assert.match(source, /boardMode && \([\s\S]*?\{renderCustomZoomControls\(true\)\}/);
  assert.match(source, /@media \(pointer: coarse\)[\s\S]*?\.nb-custom-zoom-step \{ width: 44px !important; min-width: 44px !important; height: 44px !important; \}/);
});
