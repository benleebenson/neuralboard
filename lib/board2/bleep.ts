// A "bleep" timeline block censors narration: for its whole duration the narration is silenced and
// a 1 kHz tone plays in its place. Preview, real-time export and deterministic export all derive
// the silenced ranges from these helpers so every output censors exactly the same span.

export const BLEEP_DEFAULT_DURATION = 0.5;
export const BLEEP_FREQUENCY_HZ = 1000;
// Peak level of the generated tone before the block's own volume is applied. A full-scale sine is
// far louder than speech; this keeps the bleep roughly level with typical narration.
export const BLEEP_TONE_AMPLITUDE = 0.3;
// Short linear ramps at each edge so the tone does not click on and off.
const BLEEP_EDGE_FADE_SEC = 0.004;

export type BleepRange = { startTime: number; endTime: number };

type BleepSource = { type: string; startTime: number; duration: number; muted?: boolean };

/** Sorted, merged ranges covered by unmuted bleep blocks. A muted block censors nothing. */
export function bleepRanges(clips: readonly BleepSource[]): BleepRange[] {
  const ranges = clips
    .filter((clip) => clip.type === "bleep" && !clip.muted && Number.isFinite(clip.startTime) && clip.duration > 0)
    .map((clip) => ({ startTime: Math.max(0, clip.startTime), endTime: Math.max(0, clip.startTime) + clip.duration }))
    .sort((a, b) => a.startTime - b.startTime);
  const merged: BleepRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startTime <= previous.endTime) previous.endTime = Math.max(previous.endTime, range.endTime);
    else merged.push({ ...range });
  }
  return merged;
}

export function isBleepedAt(ranges: readonly BleepRange[], time: number): boolean {
  return ranges.some((range) => time >= range.startTime && time < range.endTime);
}

/**
 * Removes every bleeped span from timeline audio segments, splitting a segment around a bleep and
 * advancing `sourceOffsetSec` so the audio after the bleep stays in sync with the timeline.
 */
export function cutSegmentsForBleeps<T extends { startTime: number; duration: number; sourceOffsetSec: number }>(
  segments: readonly T[],
  ranges: readonly BleepRange[],
): T[] {
  if (ranges.length === 0) return [...segments];
  const result: T[] = [];
  for (const segment of segments) {
    let cursor = segment.startTime;
    const end = segment.startTime + segment.duration;
    for (const range of ranges) {
      if (range.endTime <= cursor || range.startTime >= end) continue;
      if (range.startTime > cursor) {
        result.push({ ...segment, startTime: cursor, duration: range.startTime - cursor, sourceOffsetSec: segment.sourceOffsetSec + (cursor - segment.startTime) });
      }
      cursor = Math.max(cursor, range.endTime);
      if (cursor >= end) break;
    }
    if (end - cursor > 1e-9) {
      result.push({ ...segment, startTime: cursor, duration: end - cursor, sourceOffsetSec: segment.sourceOffsetSec + (cursor - segment.startTime) });
    }
  }
  return result;
}

/** A mono sine tone of exactly `duration` seconds with click-free edges. */
export function createBleepToneBuffer(context: BaseAudioContext, duration: number): AudioBuffer {
  const sampleRate = context.sampleRate;
  const length = Math.max(1, Math.round(Math.max(0, duration) * sampleRate));
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const fadeSamples = Math.max(1, Math.min(Math.round(BLEEP_EDGE_FADE_SEC * sampleRate), Math.floor(length / 2)));
  for (let index = 0; index < length; index++) {
    const edge = Math.min(1, index / fadeSamples, (length - 1 - index) / fadeSamples);
    data[index] = BLEEP_TONE_AMPLITUDE * Math.max(0, edge) * Math.sin(2 * Math.PI * BLEEP_FREQUENCY_HZ * index / sampleRate);
  }
  return buffer;
}
