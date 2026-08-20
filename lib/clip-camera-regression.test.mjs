import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Snapshot of the clip-schedule derivation after focused stops became aspect-aware 94% fits.
// Pan traversal retains its intentionally wider historical scale, while character placeholders
// still bridge the neighboring authored stops without inventing a final frame-all stop.
const LATEST_GOOD_CLIPS_DERIVATION_SHA256 = "688e9532b609c507b9e4e18776b817bd4ea24a2dc78a32ad9b237c2077befa0a";

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
