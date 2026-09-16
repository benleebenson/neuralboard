import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("clear zoom boxes removes only customZoom clips", () => {
  const start = page.indexOf("function clearCustomZoomBoxes()");
  const end = page.indexOf("function adjustCustomZoomDuration", start);
  const implementation = page.slice(start, end);

  assert.match(implementation, /filter\(\(clip\) => clip\.type !== "customZoom"\)/);
  assert.doesNotMatch(implementation, /setAnnotations\(/);
  assert.doesNotMatch(implementation, /setCharacterActions/);
});

test("undo controls are adjacent to export and support the standard shortcut", () => {
  assert.match(page, />↶ Undo<\/button>[\s\S]*?>⌧ Clear zoom boxes<\/button>[\s\S]*?\{isExporting \? "✕ Cancel" : "⬇ Export"\}/);
  assert.match(page, /event\.key\.toLowerCase\(\) !== "z"/);
  assert.match(page, /const undoBoard = useCallback/);
});

test("custom zoom drawing is unbounded and covers the visible board viewport", () => {
  const coordinateStart = page.indexOf("function clientToCustomZoomBoardPoint");
  const coordinateEnd = page.indexOf("function rectsIntersect", coordinateStart);
  const coordinateImplementation = page.slice(coordinateStart, coordinateEnd);
  assert.match(coordinateImplementation, /return clientToBoardPoint\(clientX, clientY\)/);
  assert.doesNotMatch(coordinateImplementation, /clamp\(/);

  assert.match(page, /aria-label="Custom Zoom drawing surface"[\s\S]*?left: -boardPan\.x,[\s\S]*?top: -boardPan\.y,[\s\S]*?width: boardViewportSize\.width,[\s\S]*?height: boardViewportSize\.height/);
});
