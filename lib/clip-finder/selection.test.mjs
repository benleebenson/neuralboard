import test from "node:test";
import assert from "node:assert/strict";
import { buildClipAnalysisWindows, dedupeClipSuggestions, parseClipSuggestions } from "./selection.ts";

test("long podcasts are split into bounded analysis windows", () => {
  const windows = buildClipAnalysisWindows(3600);
  assert.equal(windows.length, 4);
  assert.deepEqual(windows.at(-1), { index: 3, startTime: 2700, endTime: 3600 });
});

test("clip JSON parser strips fences and rejects invalid boundaries", () => {
  const clips = parseClipSuggestions('```json\n[{"startTime":10,"endTime":20,"title":"A claim","reason":"Strong hook","transcript":"Exact words"},{"startTime":20,"endTime":10,"title":"Bad","reason":"Bad","transcript":"Bad"}]\n```', 60);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].title, "A claim");
});

test("substantially overlapping suggestions are de-duplicated", () => {
  const base = { title: "Title", reason: "Reason", transcript: "Words" };
  assert.equal(dedupeClipSuggestions([
    { ...base, startTime: 10, endTime: 30 },
    { ...base, startTime: 12, endTime: 29 },
    { ...base, startTime: 50, endTime: 70 },
  ]).length, 2);
});
