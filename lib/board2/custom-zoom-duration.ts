export const MIN_CUSTOM_ZOOM_DURATION = 0.3;
export const MAX_CUSTOM_ZOOM_DURATION = 8;
export const CUSTOM_ZOOM_DURATION_STEP = 0.1;
export const DEFAULT_CUSTOM_ZOOM_DURATION = 1.2;

export function normalizeCustomZoomDuration(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  const duration = Number.isFinite(numeric) ? numeric : DEFAULT_CUSTOM_ZOOM_DURATION;
  const clamped = Math.max(MIN_CUSTOM_ZOOM_DURATION, Math.min(MAX_CUSTOM_ZOOM_DURATION, duration));
  return Math.round(clamped * 10) / 10;
}
