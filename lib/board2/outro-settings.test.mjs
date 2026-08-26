import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTO_BUILD_OUTRO_DURATION_SECONDS,
  DEFAULT_OUTRO_TEXT,
  OUTRO_SETTINGS_KEY,
  placeOutroCard,
} from "./outro-settings.ts";

test("uses stable defaults and a versioned dedicated settings key", () => {
  assert.equal(DEFAULT_OUTRO_TEXT, "FULL EPISODE IN BIO");
  assert.equal(AUTO_BUILD_OUTRO_DURATION_SECONDS, 2.5);
  assert.match(OUTRO_SETTINGS_KEY, /^board2:auto-build-outro:v\d+$/);
});

test("places the outro in its own area beyond all content and expands the board", () => {
  const placement = placeOutroCard(
    [
      { x: 400, y: 500, width: 800, height: 500 },
      { x: 3100, y: 1200, width: 700, height: 500 },
    ],
    { width: 1200, height: 1200 },
    { width: 4000, height: 3000 },
  );

  assert.equal(placement.width, 675);
  assert.equal(placement.height, 675);
  assert.ok(placement.x >= 4300, "outro starts beyond the existing board edge");
  assert.ok(placement.x >= 4500, "outro stays at least 700px beyond the furthest content");
  assert.ok(placement.boardWidth >= placement.x + placement.width + 400);
  assert.equal(placement.boardHeight, 3000);
});

test("preserves a small image's intrinsic size", () => {
  const placement = placeOutroCard([], { width: 640, height: 360 }, { width: 4000, height: 3000 });
  assert.deepEqual(
    { width: placement.width, height: placement.height },
    { width: 640, height: 360 },
  );
});

test("auto-build emits a featured outro beat, annotations, camera provenance, and recipe provenance", () => {
  const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
  const autoBuild = source.slice(source.indexOf("async function autoBuildFromNarration"), source.indexOf("function cancelAutoBuild"));
  assert.match(autoBuild, /const buildOutroImage = appendOutro \? outroImageRef\.current : null/);
  assert.match(autoBuild, /duration: AUTO_BUILD_OUTRO_DURATION_SECONDS/);
  assert.match(autoBuild, /holdFraction: 1/);
  assert.match(autoBuild, /featured: true/);
  assert.match(autoBuild, /autoRole: "outro"/);
  assert.match(autoBuild, /fontFamily: "Caveat"/);
  assert.match(autoBuild, /cameraClips = \[\.\.\.autoClips, \.\.\.\(outroClip/);
  assert.match(source, /source: keyframe\.autoRole === "outro" \? "autoDerived"/);
  assert.match(source, /data-append-outro-toggle/);
  assert.match(source, /data-clear-outro-image/);
});
