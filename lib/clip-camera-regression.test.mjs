import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Snapshot of the clip-schedule derivation after character/follow generation modes were removed.
// Character-focus blocks are runtime overrides and must stay outside this authored base track.
const LATEST_GOOD_CLIPS_DERIVATION_SHA256 = "9e5e3d88c4eb8d94a1e729d4a9b821263d01ba8789856f75dc9c96ed7e4f4b3e";

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
