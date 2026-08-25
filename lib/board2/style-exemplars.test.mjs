import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAppliedStyle,
  extractBoardStyleSummary,
  selectStyleExemplars,
  stylePacingSeconds,
} from "./style-exemplars.ts";

function exampleManifest(overrides = {}) {
  return {
    schemaVersion: 6,
    meta: {
      id: "board-a",
      title: "Dream Practice",
      modifiedAt: "2026-08-24T10:00:00.000Z",
      aspectRatio: "16:9",
      duration: 18,
      trainingExample: true,
      ...overrides,
    },
    board: {
      media: [
        { id: "m1", type: "image", name: "night train", searchQuery: "woman checking wristwatch late night train photo", imagePlanReason: "A concrete image of waiting introduces the premise.", autoTopicId: "t1", autoTopicTitle: "Waiting Awake" },
        { id: "m2", type: "image", name: "hotel corridor", searchQuery: "long empty hotel corridor repeating doors photograph", imagePlanReason: "The repeated doors become a visual metaphor for dream choices.", autoTopicId: "t1", autoTopicTitle: "Waiting Awake" },
        { id: "m3", type: "image", name: "dream journal", searchQuery: "open dream journal beside alarm clock photograph", imagePlanReason: "Shows the actual practice at the turn.", autoTopicId: "t2", autoTopicTitle: "Reality Checks" },
        { id: "m4", type: "image", name: "museum drawer", searchQuery: "child opening museum specimen drawer photograph", imagePlanReason: "Makes curiosity tangible through an observable action.", autoTopicId: "t2", autoTopicTitle: "Reality Checks" },
      ],
    },
    timeline: {
      blocks: [
        { id: "m1", mediaId: "m1", type: "image", startTime: 0, duration: 3, holdFraction: 0.7 },
        { id: "m2", mediaId: "m2", type: "image", startTime: 3, duration: 6, holdFraction: 0.8 },
        { id: "m3", mediaId: "m3", type: "image", startTime: 9, duration: 4, holdFraction: 0.65 },
        { id: "m4", mediaId: "m4", type: "image", startTime: 13, duration: 5, holdFraction: 0.7 },
        { id: "pan-1", type: "pan", startTime: 0, duration: 18 },
        { id: "focus-1", type: "characterFocus", startTime: 8, duration: 3 },
        { id: "zoom-1", type: "customZoom", startTime: 13, duration: 3 },
      ],
    },
    camera: { mode: "follow" },
    characters: {
      c1: { enabled: true, actions: [{ type: "walkTo", startTime: 1, duration: 2 }, { type: "pointAt", startTime: 10, duration: 2 }] },
      c2: { enabled: false, actions: [] },
    },
    annotations: [
      { type: "text", text: "Waiting Awake" },
      { type: "text", text: "CHECK THE CLOCK!" },
      { type: "arrow" },
    ],
  };
}

test("extracts compact editorial style signals from a complete recipe", () => {
  const summary = extractBoardStyleSummary(exampleManifest());

  assert.equal(summary.pacing.imageCount, 4);
  assert.deepEqual(summary.pacing.secondsPerImage, { min: 3, p25: 3.75, median: 4.5, p75: 5.25, max: 6 });
  assert.equal(summary.imagery.queryCount, 4);
  assert.equal(summary.imagery.metaphoricalCount, 2);
  assert.deepEqual(summary.topics.titles, ["Waiting Awake", "Reality Checks"]);
  assert.deepEqual([summary.camera.panCount, summary.camera.focusCount, summary.camera.customZoomCount], [1, 1, 1]);
  assert.deepEqual(summary.characters.timelinePlacement, { early: 1, middle: 1, late: 0 });
  assert.equal(summary.annotations.textCount, 2);
  assert.ok(summary.approximateTokens > 100 && summary.approximateTokens < 1_500);
  assert.doesNotMatch(JSON.stringify(summary), /thumbnailDataUri|assetDataUri|resolvedTrack/);
});

test("selects newest exemplars within the token budget and derives corpus pacing", () => {
  const oldSummary = extractBoardStyleSummary(exampleManifest({ id: "old", modifiedAt: "2026-01-01T00:00:00.000Z" }));
  const newSummary = extractBoardStyleSummary(exampleManifest({ id: "new", modifiedAt: "2026-08-01T00:00:00.000Z" }));
  const selected = selectStyleExemplars([oldSummary, newSummary], newSummary.approximateTokens + 100);

  assert.equal(selected.selected.length, 1);
  assert.equal(selected.selected[0].board.id, "new");
  assert.equal(stylePacingSeconds(selected.selected, 8), 4.5);
  assert.match(describeAppliedStyle(selected.selected, 4.5) ?? "", /~4\.5s pacing/);
});
