export type NarrationPlaybackState = {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  currentTime: number;
  duration: number;
};

export const NARRATION_DRIFT_TOLERANCE_SECONDS = 0.08;

export type NarrationTimelineSource = {
  id: string;
  startTime: number;
  duration: number;
  sourceOffsetSec?: number;
};

export type NarrationPlaybackSegment = {
  clipId: string;
  startTime: number;
  duration: number;
  sourceOffsetSec: number;
};

/**
 * Continuous narration is positioned once when playback starts. During that uninterrupted run,
 * only resume a genuinely paused source; replaying an ended element restarts it from zero.
 */
export function shouldResumeNarrationPlayback(state: NarrationPlaybackState): boolean {
  if (!state.paused || state.ended || state.seeking || state.readyState < 2) return false;
  return !Number.isFinite(state.duration) || state.currentTime < state.duration - 0.02;
}

/** Returns the exact media time to seek to, or null when the clocks are already locked. */
export function narrationResyncTarget(
  mediaTime: number,
  timelineMediaTime: number,
  force = false,
  tolerance = NARRATION_DRIFT_TOLERANCE_SECONDS,
): number | null {
  if (!Number.isFinite(timelineMediaTime)) return null;
  if (force || !Number.isFinite(mediaTime) || Math.abs(mediaTime - timelineMediaTime) > tolerance) {
    return Math.max(0, timelineMediaTime);
  }
  return null;
}

/**
 * Preview and export deliberately share this ownership rule: when narration clips overlap, the
 * earliest clip in timeline order owns the overlap. Splitting at every clip boundary preserves the
 * non-overlapping tails without ever allowing two copies of narration to play at once.
 */
export function exclusiveNarrationSegments(
  clips: readonly NarrationTimelineSource[],
): NarrationPlaybackSegment[] {
  const valid = clips
    .map((clip, inputIndex) => ({ clip, inputIndex }))
    .filter(({ clip }) => Number.isFinite(clip.startTime) && Number.isFinite(clip.duration) && clip.duration > 0)
    .sort((a, b) => a.clip.startTime - b.clip.startTime || a.inputIndex - b.inputIndex)
    .map(({ clip }) => clip);
  const boundaries = [...new Set(valid.flatMap((clip) => [
    Math.max(0, clip.startTime),
    Math.max(0, clip.startTime) + clip.duration,
  ]))].sort((a, b) => a - b);
  const segments: NarrationPlaybackSegment[] = [];

  for (let index = 0; index < boundaries.length - 1; index++) {
    const startTime = boundaries[index];
    const endTime = boundaries[index + 1];
    if (endTime <= startTime) continue;
    const midpoint = startTime + (endTime - startTime) / 2;
    const owner = valid.find((clip) => midpoint >= Math.max(0, clip.startTime) && midpoint < Math.max(0, clip.startTime) + clip.duration);
    if (!owner) continue;
    const sourceOffsetSec = Math.max(0, owner.sourceOffsetSec ?? 0) + Math.max(0, startTime - owner.startTime);
    const previous = segments.at(-1);
    if (
      previous?.clipId === owner.id &&
      Math.abs(previous.startTime + previous.duration - startTime) < 1e-9 &&
      Math.abs(previous.sourceOffsetSec + previous.duration - sourceOffsetSec) < 1e-9
    ) {
      previous.duration += endTime - startTime;
    } else {
      segments.push({ clipId: owner.id, startTime, duration: endTime - startTime, sourceOffsetSec });
    }
  }

  return segments;
}

export function activeNarrationClipIdAtTime(
  clips: readonly NarrationTimelineSource[],
  timelineTime: number,
): string | null {
  if (!Number.isFinite(timelineTime)) return null;
  return clips
    .map((clip, inputIndex) => ({ clip, inputIndex }))
    .filter(({ clip }) => clip.duration > 0 && timelineTime >= Math.max(0, clip.startTime) && timelineTime < Math.max(0, clip.startTime) + clip.duration)
    .sort((a, b) => a.clip.startTime - b.clip.startTime || a.inputIndex - b.inputIndex)[0]?.clip.id ?? null;
}

export function assertSingleActiveNarrationSource(
  sourceIds: readonly string[],
  context: string,
): void {
  if (sourceIds.length <= 1) return;
  throw new Error(`[narration] ${context} has ${sourceIds.length} active sources: ${sourceIds.join(", ")}`);
}
