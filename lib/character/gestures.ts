import type { VisemeTrackPoint } from "@/lib/character/lipsync";

export const GESTURE_NAMES = ["neutral", "open", "pointUp", "thinking", "self", "outward", "shrug"] as const;
export type Gesture = (typeof GESTURE_NAMES)[number];
export type GestureTrackPoint = { start: number; end: number; gesture: Gesture };
export type GestureWordTiming = { word: string; start: number; end: number };

export const MIN_GESTURE_DWELL_SEC = 1.5;
export const MAX_GESTURE_DWELL_SEC = 4.0;
export const MIN_NEUTRAL_GAP_SEC = 0.4;
export const PREVENT_CONSECUTIVE_SAME_GESTURE = true;

type TimedTextSpan = { start: number; end: number; text: string };

export type GestureTaggerInput = {
  transcript: string;
  wordTimings?: readonly GestureWordTiming[];
  visemeTrack?: readonly VisemeTrackPoint[];
  transcriptStart?: number;
  transcriptEnd?: number;
  mapGesture?: (gesture: Gesture) => Gesture;
};

const gestureNames = new Set<string>(GESTURE_NAMES);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function transcriptSentences(transcript: string): string[] {
  return (transcript.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function cleanWordTimings(value: readonly GestureWordTiming[] | undefined): GestureWordTiming[] {
  if (!value) return [];
  return value
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.word.trim())
    .map((item) => ({ word: item.word.trim(), start: item.start, end: item.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function sentenceSpansFromWords(transcript: string, words: readonly GestureWordTiming[]): TimedTextSpan[] {
  const sentences = transcriptSentences(transcript);
  if (!sentences.length || !words.length) return [];
  let cursor = 0;
  return sentences.flatMap((text, sentenceIndex) => {
    const remaining = words.length - cursor;
    if (remaining <= 0) return [];
    const requested = Math.max(1, wordCount(text));
    const count = sentenceIndex === sentences.length - 1 ? remaining : Math.min(requested, remaining);
    const first = words[cursor];
    const last = words[cursor + count - 1];
    cursor += count;
    return first && last ? [{ start: first.start, end: last.end, text }] : [];
  });
}

function spokenIntervals(
  track: readonly VisemeTrackPoint[],
  transcriptStart: number,
  transcriptEnd: number,
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < track.length; index++) {
    const point = track[index];
    if (point.viseme === "rest") continue;
    const start = clamp(point.t, transcriptStart, transcriptEnd);
    const end = clamp(track[index + 1]?.t ?? transcriptEnd, transcriptStart, transcriptEnd);
    if (end <= start) continue;
    const previous = intervals[intervals.length - 1];
    if (previous && start - previous.end <= 0.6) previous.end = end;
    else intervals.push({ start, end });
  }
  return intervals;
}

function speechTimeAt(
  offset: number,
  intervals: readonly { start: number; end: number }[],
  boundary: "previous" | "next",
): number {
  let remaining = Math.max(0, offset);
  for (let index = 0; index < intervals.length; index++) {
    const interval = intervals[index];
    const duration = interval.end - interval.start;
    if (remaining < duration || (boundary === "previous" && remaining === duration) || index === intervals.length - 1) {
      return interval.start + Math.min(remaining, duration);
    }
    remaining -= duration;
  }
  return intervals[intervals.length - 1]?.end ?? 0;
}

/**
 * The current Whisper path discards word timings. This fallback splits the transcript into
 * sentences, then projects their word-count proportions over speech regions in the viseme track.
 */
export function sentenceTimingsFromVisemeTrack(
  transcript: string,
  track: readonly VisemeTrackPoint[],
  transcriptStart: number,
  transcriptEnd: number,
): TimedTextSpan[] {
  const sentences = transcriptSentences(transcript);
  if (!sentences.length || transcriptEnd <= transcriptStart) return [];
  const intervals = spokenIntervals(track, transcriptStart, transcriptEnd);
  const usableIntervals = intervals.length ? intervals : [{ start: transcriptStart, end: transcriptEnd }];
  const speechDuration = usableIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
  const weights = sentences.map((sentence) => Math.max(1, wordCount(sentence)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumedWeight = 0;
  return sentences.map((text, index) => {
    const startOffset = speechDuration * consumedWeight / totalWeight;
    consumedWeight += weights[index];
    const endOffset = speechDuration * consumedWeight / totalWeight;
    return {
      start: speechTimeAt(startOffset, usableIntervals, "next"),
      end: speechTimeAt(endOffset, usableIntervals, "previous"),
      text,
    };
  }).filter((span) => span.end > span.start);
}

export function gestureForText(text: string): Gesture | null {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  if (/\b(?:i|me|my|myself)\b/.test(normalized)) return "self";
  if (/[?]/.test(text) || /\b(?:maybe|perhaps|i wonder|not sure)\b/.test(normalized)) return "thinking";
  if (/\b(?:but|however|the thing is|actually)\b/.test(normalized)) return "outward";
  if (/\b(?:the key|most important|remember|the point is)\b/.test(normalized)) return "pointUp";
  if (/\b(?:who knows|whatever|anyway|i guess)\b/.test(normalized)) return "shrug";
  if (/\b(?:first|second|another thing)\b/.test(normalized)) return "open";
  return null;
}

function appendTrackPoint(track: GestureTrackPoint[], point: GestureTrackPoint): void {
  if (point.end <= point.start) return;
  const previous = track[track.length - 1];
  if (previous?.gesture === point.gesture && Math.abs(previous.end - point.start) < 0.001) {
    previous.end = point.end;
  } else {
    track.push(point);
  }
}

/** Applies the dwell, neutral-rest, and repetition constraints to either tagger or AI output. */
export function applyGestureDwellRules(
  input: readonly GestureTrackPoint[],
  transcriptStart: number,
  transcriptEnd: number,
): GestureTrackPoint[] {
  const boundsStart = Number.isFinite(transcriptStart) ? Math.max(0, transcriptStart) : 0;
  const boundsEnd = Number.isFinite(transcriptEnd) ? Math.max(boundsStart, transcriptEnd) : boundsStart;
  if (boundsEnd <= boundsStart) return [];
  const candidates = input
    .filter((point) => isGesture(point.gesture) && Number.isFinite(point.start) && Number.isFinite(point.end) && point.end > point.start)
    .map((point) => ({
      start: clamp(point.start, boundsStart, boundsEnd),
      end: clamp(point.end, boundsStart, boundsEnd),
      gesture: point.gesture,
    }))
    .filter((point) => point.end > point.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const result: GestureTrackPoint[] = [];
  let cursor = boundsStart;
  let lastNonNeutral: Gesture | null = null;
  let lastNonNeutralEnd = -Infinity;
  const addNeutralUntil = (end: number) => {
    const neutralEnd = clamp(end, cursor, boundsEnd);
    if (neutralEnd > cursor) appendTrackPoint(result, { start: cursor, end: neutralEnd, gesture: "neutral" });
    cursor = neutralEnd;
  };

  for (const candidate of candidates) {
    if (candidate.end <= cursor) continue;
    if (candidate.gesture === "neutral") {
      addNeutralUntil(candidate.end);
      // An intentional neutral source span breaks the semantic gesture sequence. This preserves
      // the rule-tagger's open/neutral/open fallback while still dropping self/self, shrug/shrug,
      // etc. when only the mandatory 0.4 second rest separates them.
      lastNonNeutral = null;
      continue;
    }
    if (PREVENT_CONSECUTIVE_SAME_GESTURE && candidate.gesture === lastNonNeutral) continue;

    const start = Math.max(candidate.start, cursor, lastNonNeutralEnd + MIN_NEUTRAL_GAP_SEC);
    const requestedDuration = clamp(candidate.end - candidate.start, MIN_GESTURE_DWELL_SEC, MAX_GESTURE_DWELL_SEC);
    const end = Math.min(boundsEnd, start + requestedDuration);
    if (end - start < MIN_GESTURE_DWELL_SEC) continue;
    addNeutralUntil(start);
    appendTrackPoint(result, { start, end, gesture: candidate.gesture });
    cursor = end;
    lastNonNeutral = candidate.gesture;
    lastNonNeutralEnd = end;
  }
  addNeutralUntil(boundsEnd);
  return result;
}

/** Pure, deterministic transcript tagger. No network calls or ambient state. */
export function tagNarrationGestures(input: GestureTaggerInput): GestureTrackPoint[] {
  const words = cleanWordTimings(input.wordTimings);
  const inferredStart = words[0]?.start ?? input.visemeTrack?.[0]?.t ?? 0;
  const inferredEnd = words[words.length - 1]?.end
    ?? input.transcriptEnd
    ?? input.visemeTrack?.[input.visemeTrack.length - 1]?.t
    ?? inferredStart;
  const transcriptStart = Number.isFinite(input.transcriptStart) ? Math.max(0, input.transcriptStart as number) : Math.max(0, inferredStart);
  const transcriptEnd = Number.isFinite(input.transcriptEnd) ? Math.max(transcriptStart, input.transcriptEnd as number) : Math.max(transcriptStart, inferredEnd);
  const spans = words.length
    ? sentenceSpansFromWords(input.transcript, words)
    : sentenceTimingsFromVisemeTrack(input.transcript, input.visemeTrack ?? [], transcriptStart, transcriptEnd);

  let fallbackOpen = true;
  const tagged = spans.map((span): GestureTrackPoint => {
    const signal = gestureForText(span.text);
    const gesture = signal ?? (fallbackOpen ? "open" : "neutral");
    if (!signal) fallbackOpen = !fallbackOpen;
    return { start: span.start, end: span.end, gesture };
  });
  // Character-specific pose collapsing belongs at tag time: repetition and dwell rules must
  // see the pose that will actually be rendered.
  const mapped = input.mapGesture
    ? tagged.map((point) => ({ ...point, gesture: input.mapGesture!(point.gesture) }))
    : tagged;
  return applyGestureDwellRules(mapped, transcriptStart, transcriptEnd);
}

export function isGesture(value: unknown): value is Gesture {
  return typeof value === "string" && gestureNames.has(value);
}

export function isGestureTrack(value: unknown): value is GestureTrackPoint[] {
  if (!Array.isArray(value)) return false;
  return value.every((point, index) => {
    if (!point || typeof point !== "object") return false;
    const candidate = point as Partial<GestureTrackPoint>;
    return typeof candidate.start === "number" && Number.isFinite(candidate.start) && candidate.start >= 0
      && typeof candidate.end === "number" && Number.isFinite(candidate.end) && candidate.end > candidate.start
      && isGesture(candidate.gesture)
      && (index === 0 || candidate.start >= (value[index - 1] as GestureTrackPoint).end);
  });
}

export function gestureAt(time: number, track: readonly GestureTrackPoint[]): Gesture {
  const index = gestureTrackPointIndexAt(time, track);
  return index >= 0 ? track[index].gesture : "neutral";
}

export function gestureTrackPointIndexAt(time: number, track: readonly GestureTrackPoint[]): number {
  if (!Number.isFinite(time) || !track.length || time < track[0].start) return -1;
  let low = 0;
  let high = track.length - 1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (track[mid].start <= time) low = mid + 1;
    else high = mid - 1;
  }
  const point = high >= 0 ? track[high] : null;
  return point && time < point.end ? high : -1;
}

/** Low-priority narration poses may replace idle/explanation arms, but never authored action poses. */
export function actionAllowsNarrationGesture(actionType: string | undefined): boolean {
  return actionType === undefined || actionType === "idle" || actionType === "explainGesture";
}

/** Gesture tracks are speech-bounded intervals, so silence and uncovered gaps resolve neutral. */
export function speechAwareGestureAt(time: number, track: readonly GestureTrackPoint[]): Gesture {
  return gestureAt(time, track);
}

export function parseGestureTrackResponse(
  responseText: string,
  transcriptStart: number,
  transcriptEnd: number,
): GestureTrackPoint[] {
  const trimmed = responseText.replace(/^\uFEFF/, "").trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const startIndex = withoutFence.indexOf("[");
  const endIndex = withoutFence.lastIndexOf("]");
  const candidate = startIndex >= 0 && endIndex > startIndex
    ? withoutFence.slice(startIndex, endIndex + 1)
    : withoutFence;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const boundsStart = Math.max(0, transcriptStart);
  const boundsEnd = Math.max(boundsStart, transcriptEnd);
  return parsed.flatMap((raw): GestureTrackPoint[] => {
    if (!raw || typeof raw !== "object") return [];
    const point = raw as { start?: unknown; end?: unknown; gesture?: unknown };
    const start = Number(point.start);
    const end = Number(point.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !isGesture(point.gesture)) return [];
    const clampedStart = clamp(start, boundsStart, boundsEnd);
    const clampedEnd = clamp(end, boundsStart, boundsEnd);
    return clampedEnd > clampedStart ? [{ start: clampedStart, end: clampedEnd, gesture: point.gesture }] : [];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}
