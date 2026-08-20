export type NarrationPlaybackState = {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  currentTime: number;
  duration: number;
};

export const NARRATION_DRIFT_TOLERANCE_SECONDS = 0.08;

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
