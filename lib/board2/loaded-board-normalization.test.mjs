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

test("two-character sequence setup numbers survive recipe loading", () => {
  const action = normalizeLoadedCharacterActionRecord({
    id: "fight-a",
    type: "sequence",
    startTime: 3,
    duration: 4,
    sequenceId: "knee-to-face",
    sequenceRole: "attacker",
    sequencePairId: "pair-1",
    sequenceSetupDuration: "0.75",
    sequenceCenterX: "420",
    sequenceCenterY: "720",
    sequenceDirection: "-1",
  }, "fallback");

  assert.equal(action.sequenceSetupDuration, 0.75);
  assert.equal(action.sequenceCenterX, 420);
  assert.equal(action.sequenceCenterY, 720);
  assert.equal(action.sequenceDirection, -1);
  assert.equal(action.sequenceId, "knee-to-face");
  assert.equal(action.sequencePairId, "pair-1");
});

test("single-character reveal media references survive recipe loading", () => {
  const action = normalizeLoadedCharacterActionRecord({
    id: "coat",
    type: "sequence",
    startTime: 2,
    duration: 4.2,
    sequenceId: "trench-coat-reveal",
    sequenceRole: "performer",
    revealMediaId: 42,
    revealStartSeconds: "10",
  }, "fallback");
  assert.equal(action.revealMediaId, "42");
  assert.equal(action.sequenceRole, "performer");
  assert.equal(action.revealStartSeconds, 10);
});

test("explode sequence metadata survives recipe loading", () => {
  const action = normalizeLoadedCharacterActionRecord({
    id: "boom",
    type: "sequence",
    startTime: "4.5",
    duration: "1.35",
    targetX: "420",
    targetY: "720",
    sequenceId: "explode",
    sequenceRole: "performer",
    sequenceSetupDuration: "0.4",
    sequenceCenterX: "420",
    sequenceCenterY: "720",
    sequenceDirection: "1",
  }, "fallback");

  assert.equal(action.sequenceId, "explode");
  assert.equal(action.sequenceRole, "performer");
  assert.equal(action.sequenceSetupDuration, 0.4);
  assert.equal(action.sequenceCenterX, 420);
  assert.equal(action.sequenceCenterY, 720);
});
