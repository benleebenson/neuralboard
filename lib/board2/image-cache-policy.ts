export type PreviewCachePolicy = {
  hotEntries: number;
  warmEntries: number;
  preloadViewportMargin: number;
  decodedBudgetBytes: number;
};

const MIB = 1024 * 1024;

export function previewCachePolicy(options: {
  deviceMemoryGb?: number;
  boardImageCount: number;
  estimatedDecodedBytesPerImage?: number;
}): PreviewCachePolicy {
  const deviceMemoryGb = Math.max(1, options.deviceMemoryGb ?? 4);
  const imageCount = Math.max(0, options.boardImageCount);
  const perImage = Math.max(256 * 1024, options.estimatedDecodedBytesPerImage ?? 1.25 * MIB);
  const decodedBudgetBytes = Math.round(Math.min(128, Math.max(32, deviceMemoryGb * 12)) * MIB);
  const budgetEntries = Math.max(12, Math.floor(decodedBudgetBytes / perImage));
  const boardPressure = imageCount > 240 ? 0.55 : imageCount > 120 ? 0.7 : imageCount > 60 ? 0.85 : 1;
  const totalEntries = Math.max(12, Math.min(96, imageCount || 24, Math.floor(budgetEntries * boardPressure)));
  const warmEntries = Math.max(4, Math.min(20, Math.round(totalEntries * 0.25)));
  const hotEntries = Math.max(8, totalEntries - warmEntries);
  return {
    hotEntries,
    warmEntries,
    preloadViewportMargin: imageCount > 120 ? 0.25 : 0.4,
    decodedBudgetBytes,
  };
}

export function decodedImageBytes(images: Iterable<{ complete: boolean; naturalWidth: number; naturalHeight: number }>): number {
  let bytes = 0;
  for (const image of images) {
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      bytes += image.naturalWidth * image.naturalHeight * 4;
    }
  }
  return bytes;
}

// Recently drawn images are the on-screen working set. Evicting one of them only makes the next
// draw miss, refetch and decode it, and that load's own trim evicts the next — the loop seen in
// production as hundreds of consecutive "trim" logs. So the budget is soft for anything used
// within this window: the cache may run over it while that many images are actually on screen.
export const PREVIEW_CACHE_PROTECT_MS = 1500;

export type TieredCacheLimits = Pick<PreviewCachePolicy, "hotEntries" | "warmEntries" | "decodedBudgetBytes">;

// LRU over two tiers (Map insertion order = recency): overflow from `hot` is demoted to `warm`;
// `warm` is evicted by count and by total decoded bytes. Protected keys are never moved or dropped.
export function trimTieredCache<T>(
  hot: Map<string, T>,
  warm: Map<string, T>,
  limits: TieredCacheLimits,
  options: { bytes: (values: T[]) => number; isProtected: (key: string) => boolean },
): { demoted: number; evicted: string[] } {
  let demoted = 0;
  const evicted: string[] = [];
  const oldestUnprotected = (map: Map<string, T>) => {
    for (const key of map.keys()) if (!options.isProtected(key)) return key;
    return undefined;
  };
  while (hot.size > limits.hotEntries) {
    const key = oldestUnprotected(hot);
    if (key === undefined) break;
    const value = hot.get(key)!;
    hot.delete(key);
    warm.delete(key);
    warm.set(key, value);
    demoted++;
  }
  while (warm.size > limits.warmEntries || options.bytes([...hot.values(), ...warm.values()]) > limits.decodedBudgetBytes) {
    const key = oldestUnprotected(warm);
    if (key === undefined) break;
    warm.delete(key);
    evicted.push(key);
  }
  return { demoted, evicted };
}

// Remembers sources that failed to load so draw loops don't request them on every frame. A blob:
// URL that fails has been revoked and can never load again in this tab; other URLs back off
// exponentially (a flaky network or an expiring signed URL may recover).
export function createFailedSourceMemo(options: { baseMs?: number; maxMs?: number; now?: () => number } = {}) {
  const baseMs = options.baseMs ?? 30_000;
  const maxMs = options.maxMs ?? 10 * 60_000;
  const now = options.now ?? (() => Date.now());
  const failures = new Map<string, { count: number; retryAt: number }>();
  return {
    shouldSkip(url: string): boolean {
      const entry = failures.get(url);
      return !!entry && now() < entry.retryAt;
    },
    // Returns the ms until the next attempt is allowed (Infinity for a dead blob: URL).
    recordFailure(url: string): number {
      const count = (failures.get(url)?.count ?? 0) + 1;
      const wait = url.startsWith("blob:") ? Number.POSITIVE_INFINITY : Math.min(maxMs, baseMs * 2 ** (count - 1));
      failures.set(url, { count, retryAt: now() + wait });
      return wait;
    },
    recordSuccess(url: string) {
      failures.delete(url);
    },
    failureCount(url: string): number {
      return failures.get(url)?.count ?? 0;
    },
  };
}
