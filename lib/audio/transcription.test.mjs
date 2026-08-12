import test from "node:test";
import assert from "node:assert/strict";
import {
  TRANSCRIPTION_CHUNK_CONTEXT_SECONDS,
  TRANSCRIPTION_CHUNK_SECONDS,
  mergeTranscriptionChunks,
  monoPcm16WavSize,
} from "./transcription.ts";
import { planLipSyncChunks } from "../character/lipsync.ts";

test("a transcription chunk remains well below Vercel's 4.5 MB request limit", () => {
  const longestChunk = TRANSCRIPTION_CHUNK_SECONDS + TRANSCRIPTION_CHUNK_CONTEXT_SECONDS * 2;
  assert.equal(monoPcm16WavSize(longestChunk), 1_936_044);
  assert.ok(monoPcm16WavSize(longestChunk) < 4.5 * 1024 * 1024);
});

test("merges a 2+ minute transcription and owns overlap segments exactly once", () => {
  const windows = planLipSyncChunks(125, TRANSCRIPTION_CHUNK_SECONDS, TRANSCRIPTION_CHUNK_CONTEXT_SECONDS);
  const merged = mergeTranscriptionChunks([
    {
      window: windows[0],
      transcript: "first duplicate",
      segments: [
        { start: 1, end: 2, text: "first" },
        { start: 59.9, end: 60.2, text: "duplicate" },
      ],
    },
    {
      window: windows[1],
      transcript: "boundary second duplicate",
      segments: [
        { start: 0.15, end: 0.45, text: "boundary" },
        { start: 1.25, end: 2.25, text: "second" },
        { start: 60.15, end: 60.45, text: "duplicate" },
      ],
    },
    {
      window: windows[2],
      transcript: "ending",
      segments: [{ start: 1.25, end: 2.25, text: "ending" }],
    },
  ], 125);

  assert.equal(merged.transcript, "first boundary second ending");
  assert.equal(merged.durationSec, 125);
  assert.deepEqual(merged.segments, [
    { start: 1, end: 2, text: "first" },
    { start: 59.9, end: 60.2, text: "boundary" },
    { start: 61, end: 62, text: "second" },
    { start: 121, end: 122, text: "ending" },
  ]);
});
