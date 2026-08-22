import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCustomZoomInsertion,
  resolveTimelineInsertion,
} from "./timeline-placement.ts";

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

test("custom zooms start at the playhead and then form a duration-based chain", () => {
  const blocks = [];
  for (let index = 0; index < 4; index += 1) {
    const placement = resolveCustomZoomInsertion(blocks, 10, 1.2, 1, 5);
    blocks.push({
      type: "customZoom",
      startTime: placement.startTime,
      duration: 1.2,
      layer: placement.layer,
    });
  }

  assert.deepEqual(blocks.map((block) => block.startTime), [10, 11.2, 12.4, 13.6]);
  assert.deepEqual(resolveCustomZoomInsertion(blocks, 2, 1.2, 1, 5), {
    startTime: 14.8,
    layer: 1,
    resolution: "requested-layer",
  });
});

test("custom zoom chaining follows the latest-ending timeline block and ignores board-only areas", () => {
  const blocks = [
    { type: "customZoom", startTime: 100, duration: 2, layer: 4, featured: false },
    { type: "customZoom", startTime: 10, duration: 1.2, layer: 2 },
    { type: "customZoom", startTime: 4, duration: 9, layer: 3 },
  ];

  assert.deepEqual(resolveCustomZoomInsertion(blocks, 50, 1.2, 1, 5), {
    startTime: 13,
    layer: 3,
    resolution: "requested-layer",
  });
});

test("custom zoom chaining reports existing overlap resolution", () => {
  const blocks = [
    { type: "customZoom", startTime: 10, duration: 1.2, layer: 1 },
    { type: "image", startTime: 11, duration: 2, layer: 1 },
  ];

  assert.deepEqual(resolveCustomZoomInsertion(blocks, 0, 1.2, 1, 5), {
    startTime: 11.2,
    layer: 2,
    resolution: "alternate-layer",
  });

  const allLayersOccupied = [
    { type: "customZoom", startTime: 10, duration: 1.2, layer: 1 },
    ...Array.from({ length: 5 }, (_, layer) => ({
      type: "image",
      startTime: 11,
      duration: layer === 3 ? 2 : 4,
      layer,
    })),
  ];
  assert.deepEqual(resolveCustomZoomInsertion(allLayersOccupied, 0, 1.2, 1, 5), {
    startTime: 13,
    layer: 3,
    resolution: "shifted",
  });
});
