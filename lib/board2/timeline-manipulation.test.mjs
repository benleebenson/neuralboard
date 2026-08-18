import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTimelineBlockDrag,
  timelineLayerOverlap,
} from "./timeline-manipulation.ts";

const visualTypes = ["pan", "customZoom", "image", "video", "characterFocus"];

for (const type of visualTypes) {
  test(`${type} resizes from the dragged edge without colliding with itself`, () => {
    const block = { id: "active", type, startTime: 10, duration: 5, layer: 1 };
    const result = applyTimelineBlockDrag([block], {
      kind: "resize-right",
      blockId: block.id,
      originalStartTime: block.startTime,
      originalDuration: block.duration,
      originalLayer: block.layer,
    }, {
      deltaSeconds: -2,
      targetLayer: 1,
      playhead: 10,
      snapThresholdSeconds: 0.05,
    });

    assert.equal(result[0].startTime, 10);
    assert.equal(result[0].duration, 3);
  });
}

test("right resize grows to the dragged edge and clamps against only the next block", () => {
  const blocks = [
    { id: "active", type: "customZoom", startTime: 10, duration: 3, layer: 2 },
    { id: "next", type: "image", startTime: 16, duration: 4, layer: 2 },
  ];
  const result = applyTimelineBlockDrag(blocks, {
    kind: "resize-right",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 3,
    originalLayer: 2,
  }, {
    deltaSeconds: 10,
    targetLayer: 2,
    playhead: 0,
    snapThresholdSeconds: 0,
  });

  assert.equal(result[0].duration, 6);
});

test("left resize follows the dragged edge and clamps against only the previous block", () => {
  const blocks = [
    { id: "previous", type: "pan", startTime: 2, duration: 4, layer: 1 },
    { id: "active", type: "image", startTime: 10, duration: 5, layer: 1 },
  ];
  const result = applyTimelineBlockDrag(blocks, {
    kind: "resize-left",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 5,
    originalLayer: 1,
  }, {
    deltaSeconds: -8,
    targetLayer: 1,
    playhead: 0,
    snapThresholdSeconds: 0,
  });

  assert.equal(result[1].startTime, 6);
  assert.equal(result[1].duration, 9);
});

test("moving a resized block ignores its own occupied interval", () => {
  const blocks = [
    { id: "active", type: "image", startTime: 10, duration: 3, layer: 1 },
    { id: "other", type: "video", startTime: 30, duration: 4, layer: 1 },
  ];
  const result = applyTimelineBlockDrag(blocks, {
    kind: "move",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 3,
    originalLayer: 1,
  }, {
    deltaSeconds: 5,
    targetLayer: 1,
    playhead: 0,
    snapThresholdSeconds: 0,
  });

  assert.equal(result[0].startTime, 15);
  assert.equal(result[0].layer, 1);
  assert.equal(timelineLayerOverlap(blocks, 15, 3, "active", 1), false);
});

test("moving an existing block never snaps back to the playhead", () => {
  const block = { id: "active", type: "image", startTime: 5.5, duration: 5, layer: 1 };
  const result = applyTimelineBlockDrag([block], {
    kind: "move",
    blockId: block.id,
    originalStartTime: block.startTime,
    originalDuration: block.duration,
    originalLayer: block.layer,
  }, {
    deltaSeconds: 0.05,
    targetLayer: 1,
    playhead: 5.5,
    snapThresholdSeconds: 0.1,
  });

  assert.equal(result[0].startTime, 5.55);
});

for (const type of visualTypes) {
  test(`${type} moves left, right, to t=0, and between layers`, () => {
    const block = { id: "active", type, startTime: 10, duration: 3, layer: 1 };
    const drag = {
      kind: "move",
      blockId: block.id,
      originalStartTime: block.startTime,
      originalDuration: block.duration,
      originalLayer: block.layer,
    };
    const options = { targetLayer: 1, playhead: 10, snapThresholdSeconds: 0 };

    assert.equal(applyTimelineBlockDrag([block], drag, { ...options, deltaSeconds: -4 })[0].startTime, 6);
    assert.equal(applyTimelineBlockDrag([block], drag, { ...options, deltaSeconds: 4 })[0].startTime, 14);
    assert.equal(applyTimelineBlockDrag([block], drag, { ...options, deltaSeconds: -20 })[0].startTime, 0);
    assert.equal(applyTimelineBlockDrag([block], drag, { ...options, deltaSeconds: 2, targetLayer: 4 })[0].layer, 4);
  });
}

test("moving between layers ignores self but still rejects another block", () => {
  const blocks = [
    { id: "active", type: "pan", startTime: 10, duration: 5, layer: 1 },
    { id: "blocked", type: "customZoom", startTime: 15, duration: 5, layer: 1 },
  ];
  const moved = applyTimelineBlockDrag(blocks, {
    kind: "move",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 5,
    originalLayer: 1,
  }, {
    deltaSeconds: 5,
    targetLayer: 3,
    playhead: 0,
    snapThresholdSeconds: 0,
  });

  assert.equal(moved[0].startTime, 15);
  assert.equal(moved[0].layer, 3);
});

test("pre-existing overlap does not make a resize collapse to the minimum", () => {
  const blocks = [
    { id: "active", type: "image", startTime: 10, duration: 5, layer: 1 },
    { id: "legacy-overlap", type: "video", startTime: 12, duration: 6, layer: 1 },
  ];
  const result = applyTimelineBlockDrag(blocks, {
    kind: "resize-right",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 5,
    originalLayer: 1,
  }, {
    deltaSeconds: -1,
    targetLayer: 1,
    playhead: 0,
    snapThresholdSeconds: 0,
  });

  assert.equal(result[0].duration, 4);
});

test("a persisted minimum-duration block can be lengthened and moved again", () => {
  const collapsed = { id: "active", type: "pan", startTime: 10, duration: 0.1, layer: 1 };
  const lengthened = applyTimelineBlockDrag([collapsed], {
    kind: "resize-right",
    blockId: "active",
    originalStartTime: 10,
    originalDuration: 0.1,
    originalLayer: 1,
  }, {
    deltaSeconds: 2,
    targetLayer: 1,
    playhead: 10,
    snapThresholdSeconds: 0,
  });
  const moved = applyTimelineBlockDrag(lengthened, {
    kind: "move",
    blockId: "active",
    originalStartTime: lengthened[0].startTime,
    originalDuration: lengthened[0].duration,
    originalLayer: lengthened[0].layer,
  }, {
    deltaSeconds: 5,
    targetLayer: 4,
    playhead: 10,
    snapThresholdSeconds: 0,
  });

  assert.ok(Math.abs(lengthened[0].duration - 2.1) < 0.000_001);
  assert.equal(moved[0].startTime, 15);
  assert.equal(moved[0].layer, 4);
});
