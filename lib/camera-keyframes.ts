export type CameraState = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

export type CameraKeyframe = CameraState & {
  time: number;
  easing?: "linear" | "ease-in-out" | "smootherstep"; // applied when interpolating TO this keyframe
  autoRole?: "outro";
  shot?: "wide" | "tight";
  broadPan?: boolean;
  beatId?: string;
  scope?: "narrow" | "broad";
};

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Quintic smoothstep. Position, velocity, and acceleration are all continuous
 * when a move meets a hold because the first two derivatives are zero at both
 * ends of the curve.
 */
export function smootherstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateCameraKeyframes(
  keyframes: readonly CameraKeyframe[],
  time: number,
  fallback: CameraState,
): CameraState {
  if (keyframes.length === 0) return fallback;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) {
    const { cameraX, cameraY, boardZoom } = sorted[0];
    return { cameraX, cameraY, boardZoom };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const last = sorted[sorted.length - 1];
    return { cameraX: last.cameraX, cameraY: last.cameraY, boardZoom: last.boardZoom };
  }
  let lo = 0;
  while (lo < sorted.length - 2 && sorted[lo + 1].time <= time) lo += 1;
  const from = sorted[lo];
  const to = sorted[lo + 1];
  const rawT = (time - from.time) / (to.time - from.time);
  const t = to.easing === "linear"
    ? rawT
    : to.easing === "smootherstep"
      ? smootherstep(rawT)
      : easeInOutCubic(rawT);
  return {
    cameraX: lerp(from.cameraX, to.cameraX, t),
    cameraY: lerp(from.cameraY, to.cameraY, t),
    boardZoom: lerp(from.boardZoom, to.boardZoom, t),
  };
}
