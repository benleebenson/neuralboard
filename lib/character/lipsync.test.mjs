import test from "node:test";
import assert from "node:assert/strict";
import {
  RHUBARB_TO_VISEME,
  mergeNarrationCueTracks,
  offsetRhubarbChunkCues,
  planLipSyncChunks,
  visemeAt,
} from "./lipsync.ts";

test("maps every Rhubarb mouth shape to the existing viseme vocabulary", () => {
  assert.deepEqual(RHUBARB_TO_VISEME, {
    A: "closed", B: "slightOpen", C: "open", D: "wide", E: "round",
    F: "pucker", G: "teeth", H: "tongue", X: "rest",
  });
});

test("offsets multiple clips onto the absolute timeline and inserts rest in gaps", () => {
  const track = mergeNarrationCueTracks([
    { clipId: "later", startTime: 8, duration: 2, cues: [{ start: 0.2, end: 0.7, value: "C" }] },
    { clipId: "first", startTime: 2, duration: 2, cues: [{ start: 0.1, end: 0.5, value: "A" }, { start: 0.5, end: 1, value: "D" }] },
  ]);
  assert.deepEqual(track, [
    { t: 2.1, viseme: "closed" },
    { t: 2.5, viseme: "wide" },
    { t: 3, viseme: "rest" },
    { t: 8.2, viseme: "open" },
    { t: 8.7, viseme: "rest" },
  ]);
});

test("binary search is deterministic before, within, and after cues", () => {
  const track = [
    { t: 1, viseme: "open" },
    { t: 1.4, viseme: "wide" },
    { t: 2, viseme: "rest" },
  ];
  assert.equal(visemeAt(0.999, track), "rest");
  assert.equal(visemeAt(1, track), "open");
  assert.equal(visemeAt(1.75, track), "wide");
  assert.equal(visemeAt(10, track), "rest");
});

test("overlapping clips resolve deterministically to the latest starting cue", () => {
  const track = mergeNarrationCueTracks([
    { clipId: "a", startTime: 1, duration: 3, cues: [{ start: 0, end: 3, value: "B" }] },
    { clipId: "b", startTime: 2, duration: 1, cues: [{ start: 0, end: 1, value: "G" }] },
  ]);
  assert.equal(visemeAt(1.5, track), "slightOpen");
  assert.equal(visemeAt(2.5, track), "teeth");
  assert.equal(visemeAt(3.5, track), "slightOpen");
  assert.equal(visemeAt(4, track), "rest");
});

test("plans bounded lip-sync uploads with small context overlaps", () => {
  assert.deepEqual(planLipSyncChunks(125, 60, 0.25), [
    { nominalStart: 0, nominalEnd: 60, audioStart: 0, audioEnd: 60.25 },
    { nominalStart: 60, nominalEnd: 120, audioStart: 59.75, audioEnd: 120.25 },
    { nominalStart: 120, nominalEnd: 125, audioStart: 119.75, audioEnd: 125 },
  ]);
});

test("offsets overlapped chunk cues once onto the clip timeline", () => {
  const first = { nominalStart: 0, nominalEnd: 60, audioStart: 0, audioEnd: 60.25 };
  const second = { nominalStart: 60, nominalEnd: 120, audioStart: 59.75, audioEnd: 120 };
  const overlapCue = [{ start: 0.15, end: 0.45, value: "C" }];
  assert.deepEqual(offsetRhubarbChunkCues(overlapCue, second, 120), [
    { start: 59.9, end: 60.2, value: "C" },
  ]);
  assert.deepEqual(offsetRhubarbChunkCues([{ start: 59.9, end: 60.2, value: "C" }], first, 120), []);
});
