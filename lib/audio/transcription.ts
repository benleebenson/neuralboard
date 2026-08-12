export type AudioChunkWindow = {
  nominalStart: number;
  nominalEnd: number;
  audioStart: number;
  audioEnd: number;
};

export type TranscriptSegment = { start: number; end: number; text: string };

export type TranscriptionChunk = {
  window: AudioChunkWindow;
  transcript: string;
  segments: readonly Partial<TranscriptSegment>[];
};

export type MergedTranscription = {
  transcript: string;
  durationSec: number;
  segments: TranscriptSegment[];
};

export const TRANSCRIPTION_CHUNK_SECONDS = 60;
export const TRANSCRIPTION_CHUNK_CONTEXT_SECONDS = 0.25;
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;

export function monoPcm16WavSize(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 44;
  return 44 + Math.ceil(durationSeconds * TRANSCRIPTION_SAMPLE_RATE) * 2;
}

export function mergeTranscriptionChunks(
  chunks: readonly TranscriptionChunk[],
  totalDuration: number,
): MergedTranscription {
  const ordered = [...chunks].sort((a, b) => a.window.nominalStart - b.window.nominalStart);
  const segments: TranscriptSegment[] = [];
  const transcriptParts: string[] = [];

  for (const chunk of ordered) {
    const ownsFinalBoundary = chunk.window.nominalEnd >= totalDuration;
    const ownedSegments: TranscriptSegment[] = [];
    for (const raw of chunk.segments) {
      const localStart = Number(raw.start);
      const localEnd = Number(raw.end);
      const text = String(raw.text ?? "").trim();
      if (!Number.isFinite(localStart) || !Number.isFinite(localEnd) || localEnd <= localStart || !text) continue;

      const start = Math.max(0, chunk.window.audioStart + localStart);
      const end = Math.min(totalDuration, chunk.window.audioStart + localEnd);
      const midpoint = (start + end) / 2;
      const owned = midpoint >= chunk.window.nominalStart &&
        (ownsFinalBoundary ? midpoint <= chunk.window.nominalEnd : midpoint < chunk.window.nominalEnd);
      if (owned && end > start) ownedSegments.push({ start, end, text });
    }
    segments.push(...ownedSegments);
    const chunkText = ownedSegments.length
      ? ownedSegments.map((segment) => segment.text).join(" ")
      : chunk.transcript.trim();
    if (chunkText) transcriptParts.push(chunkText);
  }

  return {
    transcript: transcriptParts.join(" ").replace(/\s+/g, " ").trim(),
    durationSec: Math.max(0, totalDuration),
    segments,
  };
}
