const MIN_TIMELINE_DURATION = 0.1;

export type LoadedTimelineRecord = Record<string, unknown> & {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  layer?: number;
};

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = finiteNumber(value, Number.NaN);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function normalizeLoadedSchemaVersion(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(value, 0)));
}

/**
 * Converts persisted timeline data into the same mutable, numeric runtime shape used by newly
 * created blocks. Persistence-only asset locators are deliberately removed after assets have
 * been restored by the caller.
 */
export function normalizeLoadedTimelineRecord(
  raw: Record<string, unknown>,
  fallbackId: string,
  maxLayer = 4,
): LoadedTimelineRecord {
  const runtime = { ...raw };
  for (const persistenceField of [
    "assetFile", "assetMime", "assetDataUri", "thumbnailDataUri", "videoRef",
  ]) delete runtime[persistenceField];
  const type = typeof raw.type === "string" ? raw.type : "image";
  const persistedId = typeof raw.id === "string" || typeof raw.id === "number"
    ? String(raw.id)
    : "";
  const id = persistedId || fallbackId;
  const startTime = Math.max(0, finiteNumber(raw.startTime, 0));
  const duration = Math.max(MIN_TIMELINE_DURATION, finiteNumber(raw.duration, 4));
  const normalized: LoadedTimelineRecord = {
    ...runtime,
    id,
    type,
    name: typeof raw.name === "string" ? raw.name : type,
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    startTime,
    duration,
  };

  // Recipe provenance uses "autoDerived"; live-created clips use the runtime value "auto".
  if (raw.source === "autoDerived") normalized.source = "auto";

  if (type === "narration") {
    delete normalized.layer;
  } else {
    normalized.layer = Math.min(maxLayer, Math.max(0, Math.trunc(finiteNumber(raw.layer, 1))));
  }

  // `featured` is an opt-out flag. A visible loaded block should have the same absence/default
  // as a newly created block; board-only media keeps the explicit false value.
  if (raw.featured !== false) delete normalized.featured;
  if (raw.featured !== false && String(raw.mediaId ?? "") === id) delete normalized.mediaId;

  return normalized;
}

export function normalizeLoadedCharacterActionRecord(
  raw: Record<string, unknown>,
  fallbackId: string,
): Record<string, unknown> & { id: string; startTime: number; duration: number } {
  const normalized: Record<string, unknown> & { id: string; startTime: number; duration: number } = {
    ...raw,
    id: (typeof raw.id === "string" || typeof raw.id === "number") && String(raw.id)
      ? String(raw.id)
      : fallbackId,
    startTime: Math.max(0, finiteNumber(raw.startTime, 0)),
    duration: Math.max(MIN_TIMELINE_DURATION, finiteNumber(raw.duration, 1)),
  };
  if (raw.source === "autoDerived") normalized.source = "auto";

  for (const field of [
    "targetX", "targetY", "targetLocalX", "targetLocalY", "startX", "startY",
    "narrationGestureCueIndex",
  ]) {
    const numeric = optionalFiniteNumber(raw[field]);
    if (numeric === undefined) delete normalized[field];
    else normalized[field] = numeric;
  }
  if (raw.targetClipId !== undefined) normalized.targetClipId = String(raw.targetClipId);
  if (raw.narrationGestureClipId !== undefined) normalized.narrationGestureClipId = String(raw.narrationGestureClipId);
  return normalized;
}
