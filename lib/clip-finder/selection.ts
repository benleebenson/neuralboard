import type { TranscriptSegment } from "@/lib/audio/transcription";

export const CLIP_FINDER_MODEL = "gpt-5-mini";
export const CLIP_ANALYSIS_WINDOW_SECONDS = 15 * 60;

export type ClipSuggestion = { startTime: number; endTime: number; title: string; reason: string; transcript: string };
export type ClipAnalysisWindow = { index: number; startTime: number; endTime: number };

export function buildClipAnalysisWindows(durationSec: number): ClipAnalysisWindow[] {
  const count = Math.max(1, Math.ceil(durationSec / CLIP_ANALYSIS_WINDOW_SECONDS));
  return Array.from({ length: count }, (_, index) => ({
    index,
    startTime: index * CLIP_ANALYSIS_WINDOW_SECONDS,
    endTime: Math.min(durationSec, (index + 1) * CLIP_ANALYSIS_WINDOW_SECONDS),
  }));
}

export function buildClipSelectionPrompt(input: { transcript: string; segments: TranscriptSegment[]; durationSec: number; window?: ClipAnalysisWindow }) {
  const window = input.window;
  const timed = input.segments.filter((s) => !window || s.end > window.startTime && s.start < window.endTime)
    .map((s) => `[${s.start.toFixed(2)}s-${s.end.toFixed(2)}s] ${s.text}`).join("\n");
  const scope = window ? `Evaluate candidates whose start time is in ${window.startTime.toFixed(2)}-${window.endTime.toFixed(2)} seconds. Timestamps stay absolute.` : "Evaluate the entire podcast.";
  return {
    system: `You are selecting standalone clips from a podcast transcript for short-form video. Identify the segments most likely to hold attention on their own: a complete thought with a hook, a strong claim, a story, a surprising fact, or a punchline. Each clip must START and END at natural speech boundaries — never mid-sentence. Return however many genuinely good clips you find; do not pad the list with weak ones. There is no target count and no target duration. Use only the supplied transcript and copy the spoken clip text verbatim. Avoid clips that require unseen context. ${scope}\nReturn STRICT JSON ONLY, with no Markdown or prose: [{"startTime":0,"endTime":12.3,"title":"short title","reason":"one-line reason it works","transcript":"verbatim spoken text"}]`,
    user: `FULL PODCAST TRANSCRIPT (${input.durationSec.toFixed(2)} seconds):\n${input.transcript}\n\nTIMESTAMPED TRANSCRIPT FOR THIS ANALYSIS WINDOW:\n${timed}`,
  };
}

function jsonCandidate(text: string): unknown {
  const clean = text.replace(/^\uFEFF/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [clean];
  const start = clean.indexOf("["); const end = clean.lastIndexOf("]");
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1));
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch {} }
  return null;
}

export function parseClipSuggestions(text: string, durationSec: number): ClipSuggestion[] {
  const parsed = jsonCandidate(text);
  const wrapper = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { clips?: unknown } : null;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(wrapper?.clips) ? wrapper.clips : [];
  return rows.flatMap((raw): ClipSuggestion[] => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>; const startTime = Number(row.startTime); const endTime = Number(row.endTime);
    const title = typeof row.title === "string" ? row.title.trim().slice(0, 100) : "";
    const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 500) : "";
    const transcript = typeof row.transcript === "string" ? row.transcript.replace(/\s+/g, " ").trim() : "";
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime > durationSec + 0.5 || endTime <= startTime || !title || !reason || !transcript) return [];
    return [{ startTime, endTime: Math.min(durationSec, endTime), title, reason, transcript }];
  }).sort((a, b) => a.startTime - b.startTime);
}

export function dedupeClipSuggestions(clips: ClipSuggestion[]): ClipSuggestion[] {
  return [...clips].sort((a, b) => a.startTime - b.startTime).filter((clip, index, sorted) => !sorted.slice(0, index).some((prior) => {
    const overlap = Math.max(0, Math.min(prior.endTime, clip.endTime) - Math.max(prior.startTime, clip.startTime));
    return overlap / Math.min(prior.endTime - prior.startTime, clip.endTime - clip.startTime) >= 0.6;
  }));
}
