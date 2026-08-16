import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

function bodyBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source markers: ${startMarker}`);
  return source.slice(start, end);
}

test("idle character poses consume the generated narration gesture pose", () => {
  const idlePose = bodyBetween("const idlePose =", "const active = resolved.find");
  assert.match(idlePose, /leftArmA: gesturePose\.leftArmA/);
  assert.match(idlePose, /rightForeA: gesturePose\.rightForeA/);
});

test("continuous narration sync never seeks currentTime or restarts ended media", () => {
  const sync = bodyBetween("function syncNarrationAudio", "function stopNarrationAudio");
  assert.doesNotMatch(sync, /currentTime\s*=/);
  assert.match(sync, /shouldResumeNarrationPlayback\(element\)/);
});
