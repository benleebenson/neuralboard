import assert from "node:assert/strict";
import test from "node:test";
import { findImportPlacement, importContentBounds } from "./import-board-placement.ts";
import { organicLayoutRectsOverlap } from "./organic-topic-layout.ts";

const GAP = 80;

function assertClear(spot, group, occupied) {
  const rect = { ...spot, ...group };
  for (const other of occupied) assert.ok(!organicLayoutRectsOverlap(rect, other, GAP - 1), `overlaps ${JSON.stringify(other)}`);
}

test("an empty board takes the import at its margin", () => {
  assert.deepEqual(findImportPlacement({ group: { width: 900, height: 600 }, occupied: [], gap: GAP, board: { width: 4000, height: 3000 }, canGrow: false }), { x: GAP, y: GAP });
});

test("lands next to existing content without overlapping any of it", () => {
  const occupied = [
    { x: 100, y: 100, width: 800, height: 500 },
    { x: 1000, y: 120, width: 400, height: 900 },
    { x: 200, y: 1400, width: 2600, height: 300 }, // a wide band below, so "right of the top row" has to clear it
  ];
  const group = { width: 1200, height: 800 };
  const spot = findImportPlacement({ group, occupied, gap: GAP, board: { width: 4000, height: 3000 }, canGrow: true });
  assert.ok(spot);
  assertClear(spot, group, occupied);
});

test("uses a free gap inside a fixed-size board, and reports when there is none", () => {
  const board = { width: 4000, height: 3000 };
  const occupied = [{ x: 0, y: 0, width: 2000, height: 3000 }];
  const group = { width: 1500, height: 1500 };
  const spot = findImportPlacement({ group, occupied, gap: GAP, board, canGrow: false });
  assert.ok(spot);
  assertClear(spot, group, occupied);
  assert.ok(spot.x + group.width <= board.width && spot.y + group.height <= board.height);

  const full = [{ x: 0, y: 0, width: 4000, height: 3000 }];
  assert.equal(findImportPlacement({ group, occupied: full, gap: GAP, board, canGrow: false }), null);
  // The owner's board grows instead.
  const grown = findImportPlacement({ group, occupied: full, gap: GAP, board, canGrow: true });
  assert.ok(grown);
  assertClear(grown, group, full);
});

test("importing twice puts the second copy clear of the first", () => {
  const board = { width: 4000, height: 3000 };
  const occupied = [{ x: 100, y: 100, width: 1000, height: 800 }];
  const group = { width: 1000, height: 800 };
  const first = findImportPlacement({ group, occupied, gap: GAP, board, canGrow: true });
  const afterFirst = [...occupied, { ...first, ...group }];
  const second = findImportPlacement({ group, occupied: afterFirst, gap: GAP, board, canGrow: true });
  assertClear(second, group, afterFirst);
});

test("a board with hundreds of items places quickly and clear", () => {
  const occupied = Array.from({ length: 600 }, (_, index) => ({ x: (index % 30) * 210, y: Math.floor(index / 30) * 160, width: 180, height: 120 }));
  const group = { width: 2400, height: 1600 };
  const started = performance.now();
  const spot = findImportPlacement({ group, occupied, gap: GAP, board: { width: 6500, height: 3500 }, canGrow: true });
  const elapsed = performance.now() - started;
  assertClear(spot, group, occupied);
  assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)}ms`);
});

test("content bounds cover every rect", () => {
  assert.deepEqual(importContentBounds([{ x: 10, y: 20, width: 5, height: 5 }, { x: -5, y: 30, width: 50, height: 10 }]), { x: -5, y: 20, width: 50, height: 20 });
  assert.equal(importContentBounds([]), null);
});
