export type TimelineLayerInterval = {
  startTime: number;
  duration: number;
  layer?: number;
  type?: string;
  featured?: boolean;
};

export type TimelineInsertionPlacement = {
  startTime: number;
  layer: number;
  resolution: "requested-layer" | "alternate-layer" | "shifted";
};

function firstFreeStartOnLayer(
  intervals: readonly TimelineLayerInterval[],
  requestedStart: number,
  duration: number,
  layer: number,
): number {
  let candidate = requestedStart;
  const ordered = intervals
    .filter((interval) => (interval.layer ?? 1) === layer && interval.duration > 0)
    .sort((left, right) => left.startTime - right.startTime);

  for (const interval of ordered) {
    const intervalStart = Math.max(0, interval.startTime);
    const intervalEnd = intervalStart + interval.duration;
    if (intervalEnd <= candidate) continue;
    if (candidate + duration <= intervalStart) break;
    candidate = intervalEnd;
  }

  return candidate;
}

/**
 * Places a newly-created visual timeline block as close as possible to the requested time.
 * The preferred layer wins ties; otherwise another free layer at the requested time is used
 * before the block is shifted to the earliest complete gap at or after that time.
 */
export function resolveTimelineInsertion(
  intervals: readonly TimelineLayerInterval[],
  requestedStart: number,
  duration: number,
  preferredLayer: number,
  layerCount: number,
): TimelineInsertionPlacement {
  const safeStart = Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safeLayerCount = Math.max(1, Math.floor(layerCount));
  const safePreferredLayer = Math.min(safeLayerCount - 1, Math.max(0, Math.floor(preferredLayer)));
  const layers = [
    ...Array.from({ length: safeLayerCount - safePreferredLayer }, (_, offset) => safePreferredLayer + offset),
    ...Array.from({ length: safePreferredLayer }, (_, layer) => layer),
  ];

  const candidates = layers.map((layer, preferenceIndex) => ({
    layer,
    preferenceIndex,
    startTime: firstFreeStartOnLayer(intervals, safeStart, safeDuration, layer),
  }));
  candidates.sort((left, right) =>
    left.startTime - right.startTime || left.preferenceIndex - right.preferenceIndex,
  );

  const selected = candidates[0];
  return {
    startTime: selected.startTime,
    layer: selected.layer,
    resolution: selected.startTime > safeStart
      ? "shifted"
      : selected.layer === safePreferredLayer
        ? "requested-layer"
        : "alternate-layer",
  };
}

/**
 * Continues the custom-zoom sequence from the timeline appearance whose end is latest.
 * Its layer becomes the preferred layer for the next block. Board-only custom zoom
 * entities do not establish or extend the sequence.
 */
export function resolveCustomZoomInsertion(
  intervals: readonly TimelineLayerInterval[],
  playhead: number,
  duration: number,
  preferredLayer: number,
  layerCount: number,
): TimelineInsertionPlacement {
  const lastCustomZoom = intervals.reduce<TimelineLayerInterval | undefined>((latest, interval) => {
    if (interval.type !== "customZoom" || interval.featured === false) return latest;
    if (!latest) return interval;
    const latestEnd = latest.startTime + latest.duration;
    const intervalEnd = interval.startTime + interval.duration;
    return intervalEnd >= latestEnd ? interval : latest;
  }, undefined);
  const requestedStart = lastCustomZoom
    ? Math.round((lastCustomZoom.startTime + lastCustomZoom.duration) * 1_000_000) / 1_000_000
    : playhead;
  const chainLayer = lastCustomZoom?.layer ?? preferredLayer;

  return resolveTimelineInsertion(
    intervals.filter((interval) => interval.featured !== false),
    requestedStart,
    duration,
    chainLayer,
    layerCount,
  );
}
