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

test("advanced board utilities live in the Tools properties panel", () => {
  const panel = bodyBetween("data-tools-panel", "selectedCharAction || characterPanelOpen");
  assert.match(source, /🔧 Tools/);
  assert.match(panel, /Export quality/);
  assert.match(panel, /Export frame rate/);
  assert.match(panel, /Export bitrate/);
  assert.match(panel, /📚 Assets/);
  assert.match(panel, /Export board image/);
  assert.match(panel, /Board Data/);
  assert.match(panel, /Ambient video/);
  assert.match(panel, /Camera & services/);
  assert.match(panel, /Regenerate camera now/);
  assert.match(panel, /Bridge:/);
});

test("camera keyframes regenerate automatically after timeline changes", () => {
  assert.match(source, /Camera framing is derived state/);
  assert.match(source, /setKeyframesOutOfDate\(true\)/);
  assert.match(source, /window\.setTimeout\(\(\) => \{ void generateCameraKeyframes\(\); \}, 400\)/);
  assert.match(source, /currentGeneratedBoardSource/);
});

test("the primary timeline bar still exposes the main Export action", () => {
  const timeline = bodyBetween("Timeline controls bar", "{/* Ruler */}");
  assert.match(timeline, /isExporting \? "✕ Cancel" : "⬇ Export"/);
});
