import test from "node:test";
import assert from "node:assert/strict";
import {
  boardEntitiesForDisplay,
  boardEntityRepresentativesAtTime,
  boardEntityId,
  isCanonicalBoardEntity,
} from "./board-entities.ts";

test("five pasted timeline appearances retain one canonical board image", () => {
  const original = { id: "image-1", type: "image", startTime: 0, duration: 4, boardX: 10, boardY: 20, boardW: 300, boardH: 200 };
  const pasted = Array.from({ length: 5 }, (_, index) => ({
    ...original,
    id: `appearance-${index + 1}`,
    mediaId: original.id,
    startTime: 10 + index * 5,
  }));
  const clips = [original, ...pasted];

  assert.equal(boardEntitiesForDisplay(clips).length, 1);
  assert.equal(clips.filter((clip) => clip.featured !== false).length, 6);
  assert.ok(pasted.every((clip) => boardEntityId(clip) === original.id));
});

test("removing one pasted block leaves the board entity and other appearances", () => {
  const clips = [
    { id: "area-1", type: "customZoom", startTime: 0, duration: 3, boardX: 0, boardY: 0, boardW: 200, boardH: 100 },
    { id: "area-block-2", mediaId: "area-1", type: "customZoom", startTime: 8, duration: 3, boardX: 0, boardY: 0, boardW: 200, boardH: 100 },
    { id: "area-block-3", mediaId: "area-1", type: "customZoom", startTime: 16, duration: 3, boardX: 0, boardY: 0, boardW: 200, boardH: 100 },
  ];
  const remaining = clips.filter((clip) => clip.id !== "area-block-2");

  assert.equal(boardEntitiesForDisplay(remaining).length, 1);
  assert.equal(remaining.length, 2);
  assert.equal(isCanonicalBoardEntity(remaining[0]), true);
});

test("canvas representative follows the active appearance while focus areas sort below media", () => {
  const clips = [
    { id: "image-1", type: "image", startTime: 0, duration: 2, boardX: 0, boardY: 0, boardW: 100, boardH: 100 },
    { id: "later", mediaId: "image-1", type: "image", startTime: 10, duration: 2, boardX: 0, boardY: 0, boardW: 100, boardH: 100 },
    { id: "area-1", type: "customZoom", startTime: 0, duration: 2, boardX: 0, boardY: 0, boardW: 100, boardH: 100 },
  ];

  assert.equal(boardEntityRepresentativesAtTime(clips, 10.5).find((clip) => clip.type === "image")?.id, "later");
  assert.deepEqual(boardEntitiesForDisplay(clips).map((clip) => clip.type), ["customZoom", "image"]);
});
