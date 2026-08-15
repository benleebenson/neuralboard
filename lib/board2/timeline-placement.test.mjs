import test from "node:test";
import assert from "node:assert/strict";
import { resolveTimelineInsertion } from "./timeline-placement.ts";

test("inserts both pan and image durations at a mid-project playhead instead of the timeline end", () => {
  const longTimeline = [{ startTime: 0, duration: 1800, layer: 4 }];
  assert.deepEqual(resolveTimelineInsertion(longTimeline, 900, 5, 1, 5), {
    startTime: 900,
    layer: 1,
    resolution: "requested-layer",
  });
  assert.deepEqual(resolveTimelineInsertion(longTimeline, 900, 4, 1, 5), {
    startTime: 900,
    layer: 1,
    resolution: "requested-layer",
  });
});

test("uses another layer at the playhead instead of appending", () => {
  const placement = resolveTimelineInsertion([
    { startTime: 80, duration: 20, layer: 1 },
  ], 90, 5, 1, 5);

  assert.deepEqual(placement, {
    startTime: 90,
    layer: 2,
    resolution: "alternate-layer",
  });
});

test("uses the earliest complete gap when every layer is occupied at the playhead", () => {
  const intervals = Array.from({ length: 5 }, (_, layer) => ({
    startTime: 80,
    duration: layer === 3 ? 12 : 20,
    layer,
  }));

  assert.deepEqual(resolveTimelineInsertion(intervals, 90, 5, 1, 5), {
    startTime: 92,
    layer: 3,
    resolution: "shifted",
  });
});

test("skips a gap that is shorter than the new block duration", () => {
  const intervals = [
    { startTime: 0, duration: 12, layer: 1 },
    { startTime: 14, duration: 4, layer: 1 },
    ...[0, 2, 3, 4].map((layer) => ({ startTime: 0, duration: 30, layer })),
  ];

  assert.deepEqual(resolveTimelineInsertion(intervals, 10, 4, 1, 5), {
    startTime: 18,
    layer: 1,
    resolution: "shifted",
  });
});
