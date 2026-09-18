import test from "node:test";
import assert from "node:assert/strict";
import { ASSET_SEMANTIC_MATCH_THRESHOLD, bestSemanticAsset, cosineSimilarity } from "./asset-matching.ts";

test("semantic asset matching prefers the highest cosine score above the documented threshold", () => {
  const assets = [
    { id: "unrelated", embedding: [0, 1, 0] },
    { id: "close", embedding: [0.9, 0.1, 0] },
    { id: "best", embedding: [1, 0, 0] },
  ];
  assert.equal(ASSET_SEMANTIC_MATCH_THRESHOLD, 0.78);
  assert.equal(bestSemanticAsset(assets, [1, 0, 0])?.asset.id, "best");
  assert.ok(cosineSimilarity([1, 0], [1, 0]) === 1);
});

test("semantic asset matching rejects weak results", () => {
  assert.equal(bestSemanticAsset([{ embedding: [0, 1] }], [1, 0]), null);
});
