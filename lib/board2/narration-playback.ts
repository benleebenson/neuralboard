export type NarrationPlaybackState = {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  currentTime: number;
  duration: number;
};

/**
 * Continuous narration is positioned once when playback starts. During that uninterrupted run,
 * only resume a genuinely paused source; replaying an ended element restarts it from zero.
 */
export function shouldResumeNarrationPlayback(state: NarrationPlaybackState): boolean {
  if (!state.paused || state.ended || state.seeking || state.readyState < 2) return false;
  return !Number.isFinite(state.duration) || state.currentTime < state.duration - 0.02;
}
