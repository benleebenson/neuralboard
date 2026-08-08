import type { Viseme } from "@/lib/stream";

export type RhubarbMouthShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";
export type RhubarbCue = { start: number; end: number; value: RhubarbMouthShape };
export type VisemeTrackPoint = { t: number; viseme: Viseme };

export const RHUBARB_TO_VISEME: Readonly<Record<RhubarbMouthShape, Viseme>> = {
  A: "closed",
  B: "slightOpen",
  C: "open",
  D: "wide",
  E: "round",
  F: "pucker",
  G: "teeth",
  H: "tongue",
  X: "rest",
};

type NarrationTrackInput = {
  clipId: string;
  startTime: number;
  duration: number;
  cues: readonly RhubarbCue[];
};

type CueInterval = {
  clipId: string;
  start: number;
  end: number;
  viseme: Viseme;
};

export function isRhubarbCue(value: unknown): value is RhubarbCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Partial<RhubarbCue>;
  return typeof cue.start === "number" && Number.isFinite(cue.start) && cue.start >= 0 &&
    typeof cue.end === "number" && Number.isFinite(cue.end) && cue.end > cue.start &&
    typeof cue.value === "string" && Object.prototype.hasOwnProperty.call(RHUBARB_TO_VISEME, cue.value);
}

export function mergeNarrationCueTracks(inputs: readonly NarrationTrackInput[]): VisemeTrackPoint[] {
  const intervals: CueInterval[] = [];
  for (const input of inputs) {
    const clipEnd = input.startTime + Math.max(0, input.duration);
    for (const cue of input.cues) {
      if (!isRhubarbCue(cue)) continue;
      const start = Math.max(input.startTime, input.startTime + cue.start);
      const end = Math.min(clipEnd, input.startTime + cue.end);
      if (end <= start) continue;
      intervals.push({ clipId: input.clipId, start, end, viseme: RHUBARB_TO_VISEME[cue.value] });
    }
  }
  if (!intervals.length) return [];

  const boundaries = [...new Set(intervals.flatMap((cue) => [cue.start, cue.end]))].sort((a, b) => a - b);
  const track: VisemeTrackPoint[] = [];
  for (const t of boundaries) {
    const active = intervals
      .filter((cue) => cue.start <= t && t < cue.end)
      .sort((a, b) => Number(a.viseme === "rest") - Number(b.viseme === "rest") || b.start - a.start || a.clipId.localeCompare(b.clipId))[0];
    const viseme = active?.viseme ?? "rest";
    if (track[track.length - 1]?.viseme !== viseme) track.push({ t, viseme });
  }
  return track;
}

export function visemeAt(time: number, track: readonly VisemeTrackPoint[]): Viseme {
  if (!Number.isFinite(time) || track.length === 0 || time < track[0].t) return "rest";
  let low = 0;
  let high = track.length - 1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (track[mid].t <= time) low = mid + 1;
    else high = mid - 1;
  }
  return high >= 0 ? track[high].viseme : "rest";
}

export function isVisemeTrack(value: unknown): value is VisemeTrackPoint[] {
  if (!Array.isArray(value)) return false;
  const visemes = new Set<Viseme>(["rest", "closed", "slightOpen", "open", "wide", "round", "pucker", "teeth", "tongue"]);
  return value.every((point, index) =>
    !!point && typeof point === "object" &&
    typeof point.t === "number" && Number.isFinite(point.t) && point.t >= 0 &&
    typeof point.viseme === "string" && visemes.has(point.viseme as Viseme) &&
    (index === 0 || point.t >= value[index - 1].t)
  );
}
