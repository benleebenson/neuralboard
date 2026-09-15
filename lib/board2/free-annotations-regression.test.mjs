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

test("manual annotation tools are available without a Pro subscription", () => {
  const toolbar = bodyBetween("Annotation toolbar — available to every board editor", "Legacy floating character launcher is intentionally not mounted");
  assert.match(toolbar, /🎨 Annotations/);
  assert.match(toolbar, /id: "text"/);
  assert.match(toolbar, /id: "arrow"/);
  assert.match(toolbar, /id: "circle"/);
  assert.match(toolbar, /id: "highlight"/);
  assert.match(toolbar, /id: "pen"/);
  assert.match(toolbar, /id: "emoji"/);
  assert.doesNotMatch(toolbar, /ProGated/);
  assert.doesNotMatch(source, /featureName="Annotation tools"/);
});

test("the legacy floating character button is not mounted beneath annotations", () => {
  const launcher = bodyBetween("Legacy floating character launcher is intentionally not mounted", "Character placement overlay");
  assert.match(launcher, /\{false && \(/);
  assert.match(launcher, /🧍 Character/);
});

test("AI annotation generation remains separately Pro gated", () => {
  assert.match(source, /<ProGated featureName="AI Annotation Generation">/);
});
