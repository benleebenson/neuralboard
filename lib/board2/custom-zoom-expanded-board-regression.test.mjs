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

test("custom zoom drawing uses the current expanded board dimensions", () => {
  const pointConversion = bodyBetween("function clientToCustomZoomBoardPoint", "function rectsIntersect");
  assert.match(pointConversion, /boardDimensionsRef\.current/);
  assert.match(pointConversion, /dimensions\.width/);
  assert.match(pointConversion, /dimensions\.height/);
  assert.doesNotMatch(pointConversion, /BOARD_W|BOARD_H/);

  const handlers = bodyBetween("function handleCustomZoomGlassPointerDown", "// ─ Timeline drag");
  assert.equal((handlers.match(/clientToCustomZoomBoardPoint/g) ?? []).length, 3);
  assert.doesNotMatch(handlers, /clientToBoardPoint\(/);

  assert.match(source, /data-custom-zoom-board-width=\{boardDimensions\.width\}/);
  assert.match(source, /width: boardDimensions\.width \* boardZoom/);
  assert.match(source, /height: boardDimensions\.height \* boardZoom/);
});
