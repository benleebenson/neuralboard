import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("offline audio encoding uses dequeue backpressure without mid-stream flushes", () => {
  const source = fs.readFileSync(new URL("./offline-export.ts", import.meta.url), "utf8");
  const encodeStart = source.indexOf("export async function encodeOfflineAudioTrack");
  const encodeEnd = source.indexOf("export async function seekAndDecodeVideoFrame", encodeStart);
  const implementation = source.slice(encodeStart, encodeEnd);

  assert.match(implementation, /waitForAudioEncoderCapacity\(options\.encoder\)/);
  assert.doesNotMatch(implementation, /options\.encoder\.flush\(/);
});
