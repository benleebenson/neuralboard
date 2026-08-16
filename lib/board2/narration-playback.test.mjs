import test from "node:test";
import assert from "node:assert/strict";
import { shouldResumeNarrationPlayback } from "./narration-playback.ts";

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
