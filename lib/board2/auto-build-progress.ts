import type { ImageSearchSource } from "./auto-build-images";

export const AUTO_BUILD_PROGRESS_STORAGE_KEY = "neuralboard:auto-build-progress:v1";

export type AutoBuildPhase = "preparing" | "transcribing" | "planning" | "finding" | "placing" | "camera";
export type AutoBuildTerminalStatus = "running" | "success" | "partial" | "failure" | "cancelled";
export type AutoBuildSlotStatus = "pending" | "searching" | "found" | "retrying" | "failed";

export type AutoBuildProgressSlot = {
  index: number;
  query: string;
  status: AutoBuildSlotStatus;
  source?: ImageSearchSource;
  reason?: string;
  attempt?: number;
  startedAt?: number;
  completedAt?: number;
};

export type AutoBuildProgress = {
  schemaVersion: 1;
  buildId: string;
  status: AutoBuildTerminalStatus;
  phase: AutoBuildPhase;
  detail: string;
  phaseCompleted: number;
  phaseTotal: number;
  startedAt: number;
  updatedAt: number;
  findingStartedAt?: number;
  completedAt?: number;
  slots: AutoBuildProgressSlot[];
  warnings: string[];
  summary?: string;
  error?: string;
};

const PHASE_RANGES: Record<AutoBuildPhase, { start: number; end: number }> = {
  preparing: { start: 0, end: 8 },
  transcribing: { start: 8, end: 22 },
  planning: { start: 22, end: 30 },
  finding: { start: 30, end: 90 },
  placing: { start: 90, end: 96 },
  camera: { start: 96, end: 100 },
};

export function createAutoBuildProgress(buildId: string, now = Date.now()): AutoBuildProgress {
  return {
    schemaVersion: 1,
    buildId,
    status: "running",
    phase: "preparing",
    detail: "Preparing auto-build…",
    phaseCompleted: 0,
    phaseTotal: 1,
    startedAt: now,
    updatedAt: now,
    slots: [],
    warnings: [],
  };
}

export function autoBuildPercent(progress: AutoBuildProgress): number {
  if (progress.status === "success" || progress.status === "partial") return 100;
  const range = PHASE_RANGES[progress.phase];
  const within = progress.phaseTotal > 0
    ? Math.min(1, Math.max(0, progress.phaseCompleted / progress.phaseTotal))
    : 0;
  return Math.round((range.start + (range.end - range.start) * within) * 10) / 10;
}

export function completedAutoBuildSlots(progress: AutoBuildProgress): number {
  return progress.slots.filter((slot) => slot.status === "found" || slot.status === "failed").length;
}

export function autoBuildSourceCounts(progress: AutoBuildProgress): Record<ImageSearchSource, number> {
  return {
    google: progress.slots.filter((slot) => slot.status === "found" && slot.source === "google").length,
    bing: progress.slots.filter((slot) => slot.status === "found" && slot.source === "bing").length,
    openverse: progress.slots.filter((slot) => slot.status === "found" && slot.source === "openverse").length,
  };
}

export function autoBuildRemainingMs(progress: AutoBuildProgress, now = Date.now()): number | null {
  if (progress.status !== "running" || progress.phase !== "finding" || !progress.findingStartedAt) return null;
  const completed = completedAutoBuildSlots(progress);
  if (completed < 3 || completed >= progress.slots.length) return null;
  const averageMs = Math.max(1, now - progress.findingStartedAt) / completed;
  return Math.round(averageMs * (progress.slots.length - completed));
}

export function formatAutoBuildDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function parseStoredAutoBuildProgress(raw: string | null): AutoBuildProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const progress = value as Partial<AutoBuildProgress>;
    if (progress.schemaVersion !== 1 || typeof progress.buildId !== "string" || typeof progress.startedAt !== "number" ||
      typeof progress.updatedAt !== "number" || !Array.isArray(progress.slots) || !Array.isArray(progress.warnings)) return null;
    if (!progress.status || !progress.phase || typeof progress.detail !== "string") return null;
    return progress as AutoBuildProgress;
  } catch {
    return null;
  }
}

export function humanizeAutoBuildFailure(phase: AutoBuildPhase, error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown auto-build error";
  if (/bridge unreachable|could not reach|bridge_unreachable|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return "Bridge unreachable — is the Mac mini awake and the tunnel running?";
  }
  if (phase === "transcribing") {
    if (/^Transcription failed\b/i.test(message)) return message;
    const status = /\b(4\d\d|5\d\d)\b/.exec(message)?.[1];
    return `Transcription failed${status ? ` (${status})` : ""} — ${message}`;
  }
  if (phase === "planning") return /^Planning failed\b/i.test(message) ? message : `Planning failed — ${message}`;
  if (phase === "placing") return /^Placing images failed\b/i.test(message) ? message : `Placing images failed — ${message}`;
  if (phase === "camera") return /^Camera generation failed\b/i.test(message) ? message : `Camera generation failed — ${message}`;
  if (phase === "preparing") return `Preparing narration failed — ${message}`;
  return `Auto-build failed — ${message}`;
}
