import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Snapshot of the clip-schedule derivation after character/follow generation modes were removed.
// Character-focus blocks are runtime overrides and must stay outside this authored base track.
// Board-only media is also excluded by the shared featured-timeline predicate.
const LATEST_GOOD_CLIPS_DERIVATION_SHA256 = "1e01e4f56e770c4a6e6b36cad542df9ddd2b166296d25bef9e7332f08209bff3";

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
