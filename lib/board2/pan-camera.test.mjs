import test from "node:test";
import assert from "node:assert/strict";
import { buildSerpentinePanPath } from "./pan-camera.ts";

const largeBoardMedia = [
  { id: "a", x: 600, y: 800, width: 900, height: 600 },
  { id: "b", x: 4200, y: 900, width: 900, height: 600 },
  { id: "c", x: 8900, y: 750, width: 900, height: 600 },
  { id: "d", x: 9800, y: 5100, width: 900, height: 600 },
  { id: "e", x: 5000, y: 5200, width: 900, height: 600 },
  { id: "f", x: 900, y: 5000, width: 900, height: 600 },
  { id: "g", x: 1200, y: 9300, width: 900, height: 600 },
  { id: "h", x: 6500, y: 9200, width: 900, height: 600 },
];

for (const [canvasWidth, canvasHeight, aspect] of [[1920, 1080, "16:9"], [1080, 1920, "9:16"]]) {
  test(`large-board pan uses a readable serpentine route in ${aspect}`, () => {
    const path = buildSerpentinePanPath({
      media: largeBoardMedia,
      canvasWidth,
      canvasHeight,
      boardWidth: 17_500,
      boardHeight: 13_000,
      imageFocusRatio: 0.7,
    });

    assert.deepEqual(path.map((point) => point.mediaId), ["a", "b", "c", "d", "e", "f", "g", "h"]);
    assert.ok(path[0].cameraX < path[2].cameraX, "first row travels left to right");
    assert.ok(path[3].cameraX > path[5].cameraX, "second row travels right to left");
    assert.ok(path[6].cameraY > path[0].cameraY, "route descends through later rows");
    assert.notDeepEqual(
      { x: path[0].cameraX, y: path[0].cameraY },
      { x: path.at(-1).cameraX, y: path.at(-1).cameraY },
    );
    assert.ok(path.every((point, index) => index === 0 || point.progress >= path[index - 1].progress));

    const minX = Math.min(...largeBoardMedia.map((rect) => rect.x));
    const maxX = Math.max(...largeBoardMedia.map((rect) => rect.x + rect.width));
    const minY = Math.min(...largeBoardMedia.map((rect) => rect.y));
    const maxY = Math.max(...largeBoardMedia.map((rect) => rect.y + rect.height));
    const fitEverythingZoom = 0.8 * Math.min(
      canvasWidth / (maxX - minX),
      canvasHeight / (maxY - minY),
    ) * 17_500 / canvasWidth;
    assert.ok(path[0].boardZoom > fitEverythingZoom * 2, "pan stays substantially tighter than fit-all");
  });
}

test("one media item produces one stable readable waypoint", () => {
  const path = buildSerpentinePanPath({
    media: [largeBoardMedia[0]],
    canvasWidth: 1920,
    canvasHeight: 1080,
    boardWidth: 4000,
    boardHeight: 3000,
    imageFocusRatio: 0.7,
  });
  assert.equal(path.length, 1);
  assert.equal(path[0].progress, 0);
  assert.ok(path[0].boardZoom > 0);
});
