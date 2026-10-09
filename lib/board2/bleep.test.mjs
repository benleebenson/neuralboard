import test from "node:test";
import assert from "node:assert/strict";
import { bleepRanges, cutSegmentsForBleeps, isBleepedAt } from "./bleep.ts";

test("bleepRanges merges overlapping blocks and ignores muted or non-bleep clips", () => {
  const ranges = bleepRanges([
    { type: "bleep", startTime: 5, duration: 1 },
    { type: "bleep", startTime: 1, duration: 1 },
    { type: "bleep", startTime: 1.5, duration: 1 },
    { type: "bleep", startTime: 8, duration: 1, muted: true },
    { type: "narration", startTime: 0, duration: 10 },
  ]);
  assert.deepEqual(ranges, [{ startTime: 1, endTime: 2.5 }, { startTime: 5, endTime: 6 }]);
  assert.equal(isBleepedAt(ranges, 1), true);
  assert.equal(isBleepedAt(ranges, 2.5), false);
  assert.equal(isBleepedAt(ranges, 8.5), false);
});

test("cutSegmentsForBleeps splits narration around a bleep and keeps it in sync", () => {
  const segments = cutSegmentsForBleeps(
    [{ clipId: "n", startTime: 0, duration: 10, sourceOffsetSec: 2 }],
    [{ startTime: 3, endTime: 4 }, { startTime: 9, endTime: 12 }],
  );
  assert.deepEqual(segments, [
    { clipId: "n", startTime: 0, duration: 3, sourceOffsetSec: 2 },
    { clipId: "n", startTime: 4, duration: 5, sourceOffsetSec: 6 },
  ]);
});

test("cutSegmentsForBleeps drops a segment fully covered by a bleep", () => {
  assert.deepEqual(cutSegmentsForBleeps(
    [{ clipId: "n", startTime: 2, duration: 1, sourceOffsetSec: 0 }],
    [{ startTime: 1, endTime: 4 }],
  ), []);
});
