import test from "node:test";
import assert from "node:assert/strict";
import {
  deterministicVideoSourceTime,
  exportFrameCount,
  exportFrameTime,
  exportFrameTimestampUs,
  snapshotDimensions,
} from "./offline-export.ts";

test("fixed-step export timestamps never depend on elapsed wall time", () => {
  assert.equal(exportFrameCount(2.01, 30), 61);
  assert.equal(exportFrameTime(30, 30), 1);
  assert.equal(exportFrameTimestampUs(1, 60), 16_667);
  assert.equal(exportFrameTimestampUs(3_240, 60), 54_000_000);
});

test("video timeline sampling is deterministic for active, ambient, and dormant clips", () => {
  assert.equal(deterministicVideoSourceTime({ timelineTime: 12, clipStart: 10, clipDuration: 5, sourceDuration: 20, sourceOffsetSec: 3, active: true, ambient: false }), 5);
  assert.equal(deterministicVideoSourceTime({ timelineTime: 12, clipStart: 20, clipDuration: 5, sourceDuration: 5, active: false, ambient: true }), 2);
  assert.equal(deterministicVideoSourceTime({ timelineTime: 12, clipStart: 20, clipDuration: 5, sourceDuration: 5, active: false, ambient: false }), 0.1);
});

test("full-board snapshots preserve enlarged-board aspect ratio at a 4096px long edge", () => {
  assert.deepEqual(snapshotDimensions(17_500, 13_000), { width: 4096, height: 3043 });
  assert.deepEqual(snapshotDimensions(4_000, 8_000), { width: 2048, height: 4096 });
});
