import test from "node:test";
import assert from "node:assert/strict";
import {
  activeNarrationClipIdAtTime,
  assertSingleActiveNarrationSource,
  exclusiveNarrationSegments,
  narrationResyncTarget,
  shouldResumeNarrationPlayback,
} from "./narration-playback.ts";

const playablePause = {
  paused: true,
  ended: false,
  seeking: false,
  readyState: 4,
  currentTime: 12,
  duration: 60,
};

test("resumes a narration element that paused before its source ended", () => {
  assert.equal(shouldResumeNarrationPlayback(playablePause), true);
});

test("never restarts ended narration from the beginning", () => {
  assert.equal(shouldResumeNarrationPlayback({ ...playablePause, ended: true, currentTime: 60 }), false);
  assert.equal(shouldResumeNarrationPlayback({ ...playablePause, currentTime: 59.99 }), false);
});

test("leaves actively playing, seeking, and not-yet-ready narration alone", () => {
  assert.equal(shouldResumeNarrationPlayback({ ...playablePause, paused: false }), false);
  assert.equal(shouldResumeNarrationPlayback({ ...playablePause, seeking: true }), false);
  assert.equal(shouldResumeNarrationPlayback({ ...playablePause, readyState: 1 }), false);
});

test("explicit playback boundaries force an exact seek while the helper ignores tiny clock deltas", () => {
  assert.equal(narrationResyncTarget(15, 12, true), 12);
  assert.equal(narrationResyncTarget(12.03, 12), null);
  assert.equal(narrationResyncTarget(12.2, 12), 12);
});

test("overlapping copies resolve to one narration owner in preview and export", () => {
  const clips = [
    { id: "original", startTime: 0, duration: 10, sourceOffsetSec: 2 },
    { id: "duplicate", startTime: 4, duration: 10, sourceOffsetSec: 2 },
  ];

  assert.equal(activeNarrationClipIdAtTime(clips, 6), "original");
  assert.deepEqual(exclusiveNarrationSegments(clips), [
    { clipId: "original", startTime: 0, duration: 10, sourceOffsetSec: 2 },
    { clipId: "duplicate", startTime: 10, duration: 4, sourceOffsetSec: 8 },
  ]);
});

test("the playback assertion rejects more than one active narration source", () => {
  assert.doesNotThrow(() => assertSingleActiveNarrationSource(["html:original"], "preview"));
  assert.throws(
    () => assertSingleActiveNarrationSource(["html:original", "buffer:duplicate"], "preview"),
    /2 active sources/,
  );
});
