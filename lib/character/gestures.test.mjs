import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GESTURE_DWELL_SEC,
  MIN_GESTURE_DWELL_SEC,
  MIN_NEUTRAL_GAP_SEC,
  PREVENT_CONSECUTIVE_SAME_GESTURE,
  actionAllowsNarrationGesture,
  applyGestureDwellRules,
  gestureAt,
  gestureForText,
  gestureTrackPointIndexAt,
  isGestureTrack,
  parseGestureTrackResponse,
  sentenceTimingsFromVisemeTrack,
  tagNarrationGestures,
} from "./gestures.ts";

test("exports the four tunable dwell and repetition rules", () => {
  assert.equal(MIN_GESTURE_DWELL_SEC, 1.5);
  assert.equal(MAX_GESTURE_DWELL_SEC, 4);
  assert.equal(MIN_NEUTRAL_GAP_SEC, 0.4);
  assert.equal(PREVENT_CONSECUTIVE_SAME_GESTURE, true);
});

test("classifies transcript signals in declared priority order", () => {
  assert.equal(gestureForText("Maybe I should explain this?"), "self");
  assert.equal(gestureForText("Could this work?"), "thinking");
  assert.equal(gestureForText("However, this changes everything."), "outward");
  assert.equal(gestureForText("Remember, the key is timing."), "pointUp");
  assert.equal(gestureForText("Anyway, who knows."), "shrug");
  assert.equal(gestureForText("First, set the baseline."), "open");
  assert.equal(gestureForText("A plain sentence."), null);
});

test("uses word timings when they are present", () => {
  const track = tagNarrationGestures({
    transcript: "Remember the key. However this changes.",
    wordTimings: [
      { word: "Remember", start: 1, end: 1.4 },
      { word: "the", start: 1.4, end: 1.7 },
      { word: "key", start: 1.7, end: 2.2 },
      { word: "However", start: 4, end: 4.5 },
      { word: "this", start: 4.5, end: 4.8 },
      { word: "changes", start: 4.8, end: 5.4 },
    ],
    transcriptStart: 1,
    transcriptEnd: 7,
  });
  assert.equal(gestureAt(1.2, track), "pointUp");
  assert.equal(gestureAt(3, track), "neutral");
  assert.equal(gestureAt(4.2, track), "outward");
});

test("identifies the exact gesture span consumed by the render loop", () => {
  const track = [
    { start: 1, end: 2.5, gesture: "open" },
    { start: 2.5, end: 3, gesture: "neutral" },
    { start: 3, end: 5, gesture: "pointUp" },
  ];
  assert.equal(gestureTrackPointIndexAt(0.5, track), -1);
  assert.equal(gestureTrackPointIndexAt(1.5, track), 0);
  assert.equal(gestureTrackPointIndexAt(2.75, track), 1);
  assert.equal(gestureTrackPointIndexAt(4, track), 2);
  assert.equal(gestureTrackPointIndexAt(5, track), -1);
});

test("renders narration gestures over idle poses without replacing authored action poses", () => {
  assert.equal(actionAllowsNarrationGesture(undefined), true);
  assert.equal(actionAllowsNarrationGesture("idle"), true);
  assert.equal(actionAllowsNarrationGesture("explainGesture"), true);
  assert.equal(actionAllowsNarrationGesture("walkTo"), false);
  assert.equal(actionAllowsNarrationGesture("pointAt"), false);
});

test("derives sentence timing from viseme speech regions when words were discarded", () => {
  const spans = sentenceTimingsFromVisemeTrack(
    "First sentence. Second sentence.",
    [
      { t: 2, viseme: "open" },
      { t: 4, viseme: "rest" },
      { t: 8, viseme: "wide" },
      { t: 10, viseme: "rest" },
    ],
    0,
    10,
  );
  assert.deepEqual(spans, [
    { start: 2, end: 4, text: "First sentence." },
    { start: 8, end: 10, text: "Second sentence." },
  ]);
});

test("enforces minimum and maximum dwell, neutral rests, and no repeated emphatic pose", () => {
  const track = applyGestureDwellRules([
    { start: 0, end: 0.25, gesture: "open" },
    { start: 1.6, end: 3.6, gesture: "pointUp" },
    { start: 4, end: 6, gesture: "pointUp" },
    { start: 6, end: 14, gesture: "shrug" },
  ], 0, 15);
  const emphatic = track.filter((point) => point.gesture !== "neutral");
  assert.deepEqual(emphatic.map((point) => point.gesture), ["open", "pointUp", "shrug"]);
  assert.ok(emphatic.every((point) => point.end - point.start >= MIN_GESTURE_DWELL_SEC));
  assert.ok(emphatic.every((point) => point.end - point.start <= MAX_GESTURE_DWELL_SEC));
  for (let index = 1; index < emphatic.length; index++) {
    assert.ok(emphatic[index].start - emphatic[index - 1].end >= MIN_NEUTRAL_GAP_SEC - 1e-9);
  }
  assert.equal(gestureAt(12, track), "neutral");
});

test("no-signal narration alternates open and intentional neutral spans", () => {
  const track = tagNarrationGestures({
    transcript: "Plain words here. More plain words. Still plain words.",
    wordTimings: [
      { word: "Plain", start: 0, end: 0.5 }, { word: "words", start: 0.5, end: 1 }, { word: "here", start: 1, end: 2 },
      { word: "More", start: 2, end: 2.5 }, { word: "plain", start: 2.5, end: 3 }, { word: "words", start: 3, end: 4 },
      { word: "Still", start: 4, end: 4.5 }, { word: "plain", start: 4.5, end: 5 }, { word: "words", start: 5, end: 6 },
    ],
    transcriptStart: 0,
    transcriptEnd: 6,
  });
  assert.equal(gestureAt(0.5, track), "open");
  assert.equal(gestureAt(3, track), "neutral");
  assert.equal(gestureAt(4.5, track), "open");
});

test("validates AI JSON, drops unknown gestures, and clamps transcript bounds", () => {
  const parsed = parseGestureTrackResponse(`\`\`\`json
    [{"start":-2,"end":3,"gesture":"thinking"},{"start":3,"end":4,"gesture":"wave"},{"start":9,"end":20,"gesture":"outward"}]
  \`\`\``, 1, 10);
  assert.deepEqual(parsed, [
    { start: 1, end: 3, gesture: "thinking" },
    { start: 9, end: 10, gesture: "outward" },
  ]);
  assert.deepEqual(parseGestureTrackResponse("not json", 0, 10), []);
});

test("missing gesture fields from an older project normalize to an empty track", () => {
  assert.equal(isGestureTrack(undefined), false);
  const oldNarration = { visemeTrack: [] };
  const loaded = isGestureTrack(oldNarration.gestureTrack) ? oldNarration.gestureTrack : [];
  assert.deepEqual(loaded, []);
});

test("character pose mapping happens before repetition and dwell rules", () => {
  const track = tagNarrationGestures({
    transcript: "First, consider this. Who knows?",
    wordTimings: [
      { word: "First", start: 0, end: 0.5 }, { word: "consider", start: 0.5, end: 1.1 },
      { word: "this", start: 1.1, end: 2 }, { word: "Who", start: 2.5, end: 3.2 },
      { word: "knows", start: 3.2, end: 4.5 },
    ],
    transcriptStart: 0,
    transcriptEnd: 5,
    mapGesture: (gesture) => gesture === "open" ? "shrug" : gesture,
  });
  assert.equal(track.filter((point) => point.gesture === "shrug").length, 1);
  assert.equal(track.some((point) => point.gesture === "open"), false);
});
