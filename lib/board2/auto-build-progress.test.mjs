import test from "node:test";
import assert from "node:assert/strict";
import {
  autoBuildPercent,
  autoBuildRemainingMs,
  autoBuildSourceCounts,
  createAutoBuildProgress,
  formatAutoBuildDuration,
  humanizeAutoBuildFailure,
  parseStoredAutoBuildProgress,
} from "./auto-build-progress.ts";

test("weighted finding progress advances for every completed slot", () => {
  const base = {
    ...createAutoBuildProgress("build-1", 1_000),
    phase: "finding",
    detail: "Finding images 1/14",
    phaseTotal: 14,
    slots: Array.from({ length: 14 }, (_, index) => ({ index, query: `query ${index}`, status: "pending" })),
  };
  const percents = Array.from({ length: 15 }, (_, completed) => autoBuildPercent({ ...base, phaseCompleted: completed }));
  assert.equal(percents[0], 30);
  assert.equal(percents.at(-1), 90);
  for (let index = 1; index < percents.length; index++) assert.ok(percents[index] > percents[index - 1]);
});

test("ETA starts after three completed images and uses observed pace", () => {
  const progress = {
    ...createAutoBuildProgress("build-2", 0),
    phase: "finding",
    findingStartedAt: 1_000,
    phaseTotal: 5,
    slots: [
      { index: 0, query: "a", status: "found", source: "google" },
      { index: 1, query: "b", status: "found", source: "bing" },
      { index: 2, query: "c", status: "failed", reason: "no results" },
      { index: 3, query: "d", status: "pending" },
      { index: 4, query: "e", status: "pending" },
    ],
  };
  assert.equal(autoBuildRemainingMs(progress, 31_000), 20_000);
  assert.deepEqual(autoBuildSourceCounts(progress), { google: 1, bing: 1, openverse: 0 });
});

test("formats duration, validates storage, and names likely failures", () => {
  const progress = createAutoBuildProgress("build-3", 1_000);
  assert.equal(formatAutoBuildDuration(134_000), "2m 14s");
  assert.equal(parseStoredAutoBuildProgress(JSON.stringify(progress))?.buildId, "build-3");
  assert.equal(parseStoredAutoBuildProgress("bad"), null);
  assert.equal(humanizeAutoBuildFailure("finding", new TypeError("fetch failed")), "Bridge unreachable — is the Mac mini awake and the tunnel running?");
  assert.equal(humanizeAutoBuildFailure("transcribing", new Error("request failed (413)")), "Transcription failed (413) — request failed (413)");
});
