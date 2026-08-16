export type PlannedImageMoment = {
  id: string;
  startTime: number;
};

export type NarrationLockedImageWindow = {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
};

/**
 * Converts narration-relative image moments into absolute timeline windows.
 *
 * This must run after unavailable image-search results have been removed so the
 * timeline blocks and camera are built from the same placed-image sequence.
 */
export function buildNarrationLockedImageWindows(
  moments: readonly PlannedImageMoment[],
  narrationStart: number,
  narrationDuration: number,
): NarrationLockedImageWindow[] {
  const safeNarrationStart = Number.isFinite(narrationStart) ? Math.max(0, narrationStart) : 0;
  const safeNarrationDuration = Number.isFinite(narrationDuration) ? Math.max(0.1, narrationDuration) : 0.1;
  const sorted = moments
    .filter((moment) => moment.id && Number.isFinite(moment.startTime))
    .map((moment) => ({
      id: moment.id,
      relativeStart: Math.min(Math.max(0, moment.startTime), Math.max(0, safeNarrationDuration - 0.1)),
    }))
    .sort((left, right) => left.relativeStart - right.relativeStart || left.id.localeCompare(right.id));

  return sorted.map((moment, index) => {
    const nextRelativeStart = sorted[index + 1]?.relativeStart ?? safeNarrationDuration;
    const relativeEnd = Math.max(moment.relativeStart + 0.1, nextRelativeStart);
    const startTime = safeNarrationStart + moment.relativeStart;
    const endTime = safeNarrationStart + relativeEnd;
    return {
      id: moment.id,
      startTime,
      endTime,
      duration: endTime - startTime,
    };
  });
}
