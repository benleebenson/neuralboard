import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLoadedCharacterActionRecord,
  normalizeLoadedSchemaVersion,
  normalizeLoadedTimelineRecord,
} from "./loaded-board-normalization.ts";

test("loaded timeline records become mutable fresh-runtime shapes", () => {
  const persisted = Object.freeze({
    id: 42,
    mediaId: "42",
    type: "image",
    name: "Loaded image",
    startTime: "1.5",
    duration: "4",
    layer: "3",
    source: "autoDerived",
    featured: true,
    assetFile: "assets/42.png",
    assetMime: "image/png",
    boardX: 10,
    boardY: 20,
    boardW: 300,
    boardH: 200,
  });

  const loaded = normalizeLoadedTimelineRecord(persisted, "fallback");

  assert.deepEqual(loaded, {
    id: "42",
    type: "image",
    name: "Loaded image",
    sourceUrl: "",
    startTime: 1.5,
    duration: 4,
    layer: 3,
    source: "auto",
    boardX: 10,
    boardY: 20,
    boardW: 300,
    boardH: 200,
  });
  assert.equal(Object.isFrozen(loaded), false);
  assert.equal(Object.isExtensible(loaded), true);
  loaded.startTime = 2;
  assert.equal(loaded.startTime, 2);
});

test("board-only media retains only the explicit timeline opt-out identity", () => {
  const loaded = normalizeLoadedTimelineRecord({
    id: "media-1",
    mediaId: "media-1",
    type: "video",
    featured: false,
    startTime: 0,
    duration: 4,
    layer: 4,
  }, "fallback");

  assert.equal(loaded.id, "media-1");
  assert.equal(loaded.mediaId, "media-1");
  assert.equal(loaded.featured, false);
  assert.equal(typeof loaded.startTime, "number");
  assert.equal(typeof loaded.duration, "number");
  assert.equal(typeof loaded.layer, "number");
});

test("schema versions and character actions are numerically normalized", () => {
  assert.equal(normalizeLoadedSchemaVersion("4"), 4);
  assert.equal(normalizeLoadedSchemaVersion(undefined), 0);

  const action = normalizeLoadedCharacterActionRecord({
    id: 7,
    type: "walkTo",
    startTime: "2.25",
    duration: "1.75",
    targetX: "120",
    targetY: "240",
    source: "autoDerived",
  }, "fallback");

  assert.deepEqual(action, {
    id: "7",
    type: "walkTo",
    startTime: 2.25,
    duration: 1.75,
    targetX: 120,
    targetY: 240,
    source: "auto",
  });
});
