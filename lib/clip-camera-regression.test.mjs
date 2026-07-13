import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Snapshot of the feature-complete clips-mode derivation at LATEST_GOOD (fb8d32b). The two
// generated-mode bookkeeping lines are excluded because they do not affect keyframe output.
const LATEST_GOOD_CLIPS_DERIVATION_SHA256 = "0261ad68ee0af98b3bea7ec8f5c26a273c76d4247ea0e303b9bedd76dc21c5fe";

test("feature-complete clips-mode keyframe derivation remains byte-for-byte unchanged", () => {
  const source = readFileSync(new URL("../app/board2/page.tsx", import.meta.url), "utf8");
  const functionStart = source.indexOf("function generateCameraKeyframes");
  const start = source.indexOf("    const allClipsSorted =", functionStart);
  const end = source.indexOf("  // ─ Divider drag", start);
  assert.ok(functionStart >= 0 && start >= 0 && end > start);

  const derivation = source.slice(start, end).replace(
    '    setCameraKeyframeMode("clips");\n    cameraKeyframeModeRef.current = "clips";\n',
    "",
  );
  const hash = createHash("sha256").update(derivation).digest("hex");
  assert.equal(hash, LATEST_GOOD_CLIPS_DERIVATION_SHA256);
});
