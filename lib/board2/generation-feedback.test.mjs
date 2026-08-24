import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  lipSyncBridgeHttpError,
  lipSyncBridgeRequestError,
} from "./generation-feedback.ts";

const boardSource = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("lip sync bridge network failures include the actionable Mac mini hint", () => {
  const result = lipSyncBridgeRequestError(new TypeError("fetch failed"));
  assert.equal(result.status, 502);
  assert.match(result.message, /bridge unreachable/i);
  assert.match(result.message, /Mac mini awake/i);
});

test("a stopped local bridge maps to a visible actionable failure", async () => {
  let failure;
  try {
    await fetch("http://127.0.0.1:65534/lipsync");
    assert.fail("expected the stopped bridge request to fail");
  } catch (error) {
    failure = lipSyncBridgeRequestError(error);
  }
  assert.equal(failure.status, 502);
  assert.match(failure.message, /Lip sync bridge unreachable/);
  assert.match(failure.message, /Mac mini awake/);
});

test("lip sync bridge HTTP failures name the status and server detail", () => {
  assert.equal(
    lipSyncBridgeHttpError(500, "Internal Server Error", { error: "Rhubarb crashed" }),
    "Bridge returned 500 — Rhubarb crashed",
  );
});

test("long-running board generators expose immediate phases, counts, stale states, and cancellation", () => {
  for (const phase of [
    "Compiling narration…",
    "Uploading to bridge",
    "Analyzing (Rhubarb)",
    "Applying cues…",
    "Generating smart gestures (AI)",
    "Calculating camera path…",
    "Generating annotations...",
    "Choreographing...",
  ]) assert.match(boardSource, new RegExp(phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const cancelHandler of [
    "cancelNarrationLipSync",
    "cancelAutoBuild",
    "cancelNarrationTranscription",
    "cancelAnnotationGeneration",
    "cancelChoreographyGeneration",
    "cancelNeuralSearch",
    "cancelTop5Generation",
    "cancelMobileTop5Generation",
  ]) assert.match(boardSource, new RegExp(`function ${cancelHandler}\\(`));

  assert.match(boardSource, /Lip sync:.*stale \(narration changed — regenerate\)/s);
  assert.match(boardSource, /Gestures:.*stale \(narration changed — regenerate\)/s);
  assert.match(boardSource, /Camera:.*keyframes/s);
  assert.match(boardSource, /Lip sync generated — \$\{cueCount\} mouth cue/);
  assert.match(boardSource, /Choreography generated — \$\{cleaned\.length\} action/);
  assert.match(boardSource, /Annotations generated — \$\{newAnnotations\.length\} annotation/);
});

test("smart gesture and mobile Top 5 fallback failures are no longer silent", () => {
  assert.match(boardSource, /AI gestures failed — \$\{smartGestureFailure\}/);
  assert.match(boardSource, /failedRanks\.push\(\{ rank, reason:/);
  assert.match(boardSource, /built with warnings/);
});
