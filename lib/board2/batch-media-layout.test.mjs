import assert from "node:assert/strict";
import test from "node:test";
import { layoutUploadedImageBatch } from "./batch-media-layout.ts";

test("lays out 50 uploaded images without overlap and grows the board", () => {
  const images = Array.from({ length: 50 }, (_, index) => ({ id: `image-${index}`, width: index % 2 ? 500 : 300, height: index % 2 ? 280 : 380 }));
  const result = layoutUploadedImageBatch({ images, boardWidth: 4000, boardHeight: 3000, existingBottom: 0 });
  assert.equal(result.placements.length, 50);
  assert.ok(result.boardHeight > 3000);
  for (let i = 0; i < result.placements.length; i++) {
    const a = result.placements[i];
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= result.boardWidth && a.y + a.height <= result.boardHeight);
    for (let j = i + 1; j < result.placements.length; j++) {
      const b = result.placements[j];
      assert.ok(a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height, `${a.id} overlaps ${b.id}`);
    }
  }
});
