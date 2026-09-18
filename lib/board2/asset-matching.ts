export const ASSET_SEMANTIC_MATCH_THRESHOLD = 0.78;

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function bestSemanticAsset<T extends { embedding?: unknown }>(assets: readonly T[], queryEmbedding: readonly number[], threshold = ASSET_SEMANTIC_MATCH_THRESHOLD): { asset: T; score: number } | null {
  let best: { asset: T; score: number } | null = null;
  for (const asset of assets) {
    if (!Array.isArray(asset.embedding) || !asset.embedding.every((value) => typeof value === "number")) continue;
    const score = cosineSimilarity(asset.embedding, queryEmbedding);
    if (score >= threshold && (!best || score > best.score)) best = { asset, score };
  }
  return best;
}
