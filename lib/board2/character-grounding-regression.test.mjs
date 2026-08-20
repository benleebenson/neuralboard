import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveTerrainFootIK } from "./editor-character-physics.ts";

const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("standard editor poses never run all-media terrain foot IK", () => {
  let sampledOverheadMedia = false;
  const editorIK = resolveTerrainFootIK("cinematic", true, () => {
    sampledOverheadMedia = true;
    return [-800, -800];
  });
  assert.equal(sampledOverheadMedia, false);
  assert.deepEqual(editorIK, { terrainGrounded: false, leftFootY: 0, rightFootY: 0 });

  const start = source.indexOf("function evalCharAtTime");
  const end = source.indexOf("function liveRuntimeSeconds", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /resolveTerrainFootIK\(traversalMode, terrainGrounded/);
  assert.match(body, /terrainGrounded: terrainFootIK\.terrainGrounded/);
  assert.match(source, /return action\.traversalMode === "cinematic" \? desiredY : resolveGroundY/);
  assert.match(source, /traversalMode !== "cinematic"&&!profile/);
});

test("Play Mode retains its explicit terrain foot planting", () => {
  assert.deepEqual(resolveTerrainFootIK("solid", true, () => [7, 11]), {
    terrainGrounded: true,
    leftFootY: 7,
    rightFootY: 11,
  });
});
