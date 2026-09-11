import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
const imageDropSource = readFileSync(new URL("./image-drop.ts", import.meta.url), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source markers: ${startMarker}`);
  return source.slice(start, end);
}

test("board workspaces keep independent mounted editors and expose export state in tabs", () => {
  assert.match(source, /function Board2Editor\(/);
  assert.match(source, /workspaces\.map\(\(workspace\) => \(/);
  assert.match(source, /<Board2Editor/);
  assert.match(source, /workspace\.isExporting \? `● Exporting \$\{percent\}%/);
  assert.match(source, /disabled=\{workspace\.isExporting\}/);
  assert.match(source, /display: workspace\.id === activeWorkspaceId \? "block" : "none"/);
});

test("inactive board tabs cannot consume editor keyboard or paste events", () => {
  assert.match(source, /const onKeyDown = \(e: KeyboardEvent\) => \{\n\s+if \(!isWorkspaceActive\) return;/);
  assert.match(source, /const onPaste = \(e: ClipboardEvent\) => \{\n\s+if \(!isWorkspaceActive\) return;/);
});

test("the workspace is seamless parchment without a visible finite board frame", () => {
  const desktopBoard = bodyBetween("Center: board (primary)", "Right: properties panel");
  const mobileBoard = bodyBetween("── Board ──", "── Timeline ──");
  assert.match(desktopBoard, /background: BOARD_SURFACE_COLOR/);
  assert.match(mobileBoard, /background: BOARD_SURFACE_COLOR/);
  assert.doesNotMatch(desktopBoard, /boxShadow: "4px 4px 18px rgba\(42,42,42,0\.3\)"/);
  assert.doesNotMatch(mobileBoard, /border: "1\.5px dashed rgba\(42,42,42,0\.2\)"/);
  assert.match(source, /constrainToBoard: false/);
  assert.match(imageDropSource, /if \(options\.constrainToBoard === false\) return \{ boardX, boardY \}/);
});
