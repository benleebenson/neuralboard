import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Snapshot of the clip-schedule derivation after character focus became a bridged camera stop.
// The base track holds the neighboring authored framing while the runtime follows the character,
// and no longer invents a frame-all stop after the final focus block.
const LATEST_GOOD_CLIPS_DERIVATION_SHA256 = "c5ac95d8cccce1c815095c1317429a1083e3b98cfd98d2bda56be3dba2305349";

test("feature-complete clips-mode keyframe derivation remains byte-for-byte unchanged", () => {
  const source = readFileSync(new URL("../app/board2/page.tsx", import.meta.url), "utf8");
  const functionStart = source.indexOf("function generateCameraKeyframes");
  const start = source.indexOf("    const allClipsSorted =", functionStart);
  const end = source.indexOf("  // ─ Divider drag", start);
  assert.ok(functionStart >= 0 && start >= 0 && end > start);

  const derivation = source.slice(start, end);
  const hash = createHash("sha256").update(derivation).digest("hex");
  assert.equal(hash, LATEST_GOOD_CLIPS_DERIVATION_SHA256);
});
