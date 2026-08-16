import test from "node:test";
import assert from "node:assert/strict";
import { buildNarrationLockedImageWindows } from "./auto-build-timing.ts";

test("locks placed image blocks to narration timestamps and the next placed image", () => {
  const windows = buildNarrationLockedImageWindows([
    { id: "journal", startTime: 12.5 },
    { id: "sleep", startTime: 0 },
    { id: "alarm", startTime: 18.25 },
  ], 30, 25);

  assert.deepEqual(windows, [
    { id: "sleep", startTime: 30, endTime: 42.5, duration: 12.5 },
    { id: "journal", startTime: 42.5, endTime: 48.25, duration: 5.75 },
    { id: "alarm", startTime: 48.25, endTime: 55, duration: 6.75 },
  ]);
});

test("rebuilds windows after an unavailable planned image is removed", () => {
  const windows = buildNarrationLockedImageWindows([
    { id: "first-placed", startTime: 0 },
    // The failed 4-second planned slot is deliberately absent.
    { id: "next-placed", startTime: 8 },
  ], 0, 12);

  assert.deepEqual(windows.map(({ id, startTime, duration }) => ({ id, startTime, duration })), [
    { id: "first-placed", startTime: 0, duration: 8 },
    { id: "next-placed", startTime: 8, duration: 4 },
  ]);
});
