import test from "node:test";
import assert from "node:assert/strict";
import { layoutAnnotationText } from "./annotation-text-layout.ts";

const fixedWidth = (text) => text.length * 10;

test("wraps to the stored box width and preserves explicit line breaks", () => {
  assert.deepEqual(
    layoutAnnotationText("The End of Oak Street", 100, fixedWidth),
    ["The End of", "Oak Street"],
  );
  assert.deepEqual(
    layoutAnnotationText("The End\nof Oak Street", 200, fixedWidth),
    ["The End", "of Oak Street"],
  );
  assert.deepEqual(
    layoutAnnotationText("First\n\nThird", 200, fixedWidth),
    ["First", "", "Third"],
  );
});

test("line breaks are invariant when width and font measurements scale with zoom", () => {
  const text = "The End of Oak Street";
  const expected = layoutAnnotationText(text, 100, fixedWidth);
  for (const zoom of [0.08, 0.5, 1, 2.5]) {
    assert.deepEqual(
      layoutAnnotationText(text, 100 * zoom, (value) => fixedWidth(value) * zoom),
      expected,
    );
  }
});
