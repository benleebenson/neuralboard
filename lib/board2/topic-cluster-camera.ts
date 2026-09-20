import { interpolateCameraKeyframes } from "../camera-keyframes.ts";
import { cameraForFocusRect } from "./focus-camera.ts";

export const AUTO_CAMERA_HOLD_FRACTION = 0.25;
export const AUTO_CAMERA_MOTION_FRACTION = 1 - AUTO_CAMERA_HOLD_FRACTION;
export const AUTO_CAMERA_EASING = "smootherstep" as const;

export type NarrationScope = "narrow" | "broad";

export type TopicCameraClip = {
  id: string;
  startTime: number;
  duration: number;
  holdFraction?: number;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  topicId?: string;
  scope?: NarrationScope;
  /** @deprecated Old projects used shot; wide maps to broad and tight maps to narrow. */
  shot?: "wide" | "tight";
  role?: "intro" | "outro" | "annotationTarget";
};

export type TopicCameraBounds = {
  topicId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TopicCameraKeyframe = {
  time: number;
  cameraX: number;
  cameraY: number;
  boardZoom: number;
  easing: typeof AUTO_CAMERA_EASING;
  shot?: "wide" | "tight";
  broadPan?: boolean;
  beatId?: string;
  scope?: NarrationScope;
};

type CameraStop = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

export type CameraArrivalAudit = {
  clipId: string;
  scope: NarrationScope;
  framing: "tight subject" | "wide cluster move";
  plannedTime: number;
  arrivalTime: number;
  driftSeconds: number;
  travelSeconds: number;
};

export type CameraMotionAudit = {
  runtimeSeconds: number;
  motionSeconds: number;
  holdSeconds: number;
  motionFraction: number;
  holdFraction: number;
  easing: typeof AUTO_CAMERA_EASING;
  velocityContinuousAtMoveHoldBoundaries: true;
};

export type TopicCameraOptions = {
  clips: TopicCameraClip[];
  topicBounds: TopicCameraBounds[];
  canvasWidth: number;
  canvasHeight: number;
  boardWidth: number;
  imageFocusRatio: number;
  /** @deprecated Broad framing is semantic now; elapsed-time quotas are ignored. */
  maxBroadPanGapSec?: number;
};

function stopForRect(
  rect: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  boardWidth: number,
  fillRatio: number,
): CameraStop {
  return cameraForFocusRect(rect, canvasWidth, canvasHeight, boardWidth, fillRatio);
}

function scopeForClip(clip: TopicCameraClip): NarrationScope {
  return clip.scope ?? (clip.shot === "wide" ? "broad" : "narrow");
}

function stopsMatch(left: CameraStop, right: CameraStop): boolean {
  return Math.abs(left.cameraX - right.cameraX) < 0.001
    && Math.abs(left.cameraY - right.cameraY) < 0.001
    && Math.abs(left.boardZoom - right.boardZoom) < 0.000001;
}

function driftStop(stop: CameraStop, clip: TopicCameraClip, direction: number): CameraStop {
  return {
    cameraX: stop.cameraX + clip.boardW * 0.025 * direction,
    cameraY: stop.cameraY + clip.boardH * 0.0125,
    boardZoom: stop.boardZoom,
  };
}

function beatStartStops(options: TopicCameraOptions, clips: TopicCameraClip[]): CameraStop[] {
  const boundsByTopic = new Map(options.topicBounds.map((bounds) => [bounds.topicId, bounds]));
  return clips.map((clip, index) => {
    if (scopeForClip(clip) === "narrow") {
      return stopForRect(
        { x: clip.boardX, y: clip.boardY, width: clip.boardW, height: clip.boardH },
        options.canvasWidth,
        options.canvasHeight,
        options.boardWidth,
        options.imageFocusRatio,
      );
    }

    const bounds = clip.topicId ? boundsByTopic.get(clip.topicId) : undefined;
    const wideRect = bounds ?? { x: clip.boardX, y: clip.boardY, width: clip.boardW, height: clip.boardH };
    const wide = stopForRect(wideRect, options.canvasWidth, options.canvasHeight, options.boardWidth, 0.72);
    const sweep = wideRect.width * 0.12;
    const direction = index % 2 === 0 ? 1 : -1;
    return {
      ...wide,
      cameraX: Math.min(options.boardWidth, Math.max(0, wide.cameraX - sweep * direction)),
    };
  });
}

/**
 * Retained for callers that want a distance estimate. Auto-build scheduling no
 * longer uses this as a short cap: each beat donates 75% of its real narration
 * window to travel, so a longer move starts earlier and still arrives on time.
 */
export function cameraTravelSeconds(from: CameraStop, to: CameraStop, boardWidth: number): number {
  const distance = Math.hypot(to.cameraX - from.cameraX, to.cameraY - from.cameraY);
  const distanceSeconds = distance / Math.max(1, boardWidth) * 8;
  const zoomSeconds = Math.abs(Math.log(Math.max(0.01, to.boardZoom) / Math.max(0.01, from.boardZoom))) * 1.25;
  return Math.min(6, Math.max(1.2, distanceSeconds + zoomSeconds));
}

/**
 * Builds one narration-owned camera interval per beat.
 *
 * A broad beat starts on a cluster-wide frame and never receives a competing
 * tight stop. A narrow beat starts tightly framed. In both cases the first 25%
 * is held and the remaining 75% is a quintic eased pre-roll toward the next
 * narration deadline. The next beat is therefore already framed at its spoken
 * timestamp instead of arriving late.
 */
export function buildTopicClusterCameraKeyframes(options: TopicCameraOptions): TopicCameraKeyframe[] {
  const clips = options.clips.slice().sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (!clips.length) return [];
  const starts = beatStartStops(options, clips);
  const events: TopicCameraKeyframe[] = [];

  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const scope = scopeForClip(clip);
    const start = starts[index];
    const next = clips[index + 1];
    const beatEnd = next && next.startTime > clip.startTime
      ? next.startTime
      : clip.startTime + Math.max(0.1, clip.duration);
    const beatDuration = Math.max(0.1, beatEnd - clip.startTime);
    const holdEnd = clip.startTime + beatDuration * AUTO_CAMERA_HOLD_FRACTION;
    const metadata = {
      easing: AUTO_CAMERA_EASING,
      beatId: clip.id,
      scope,
      shot: scope === "broad" ? "wide" as const : "tight" as const,
      ...(scope === "broad" ? { broadPan: true } : {}),
    };

    events.push({ time: clip.startTime, ...start, ...metadata });
    events.push({ time: holdEnd, ...start, ...metadata });

    if (next) {
      if (stopsMatch(start, starts[index + 1])) {
        events.push({
          time: holdEnd + (beatEnd - holdEnd) * 0.5,
          ...driftStop(start, clip, index % 2 === 0 ? 1 : -1),
          ...metadata,
        });
      }
      continue;
    }

    const finalStop = scope === "broad"
      ? (() => {
          const bounds = clip.topicId ? options.topicBounds.find((item) => item.topicId === clip.topicId) : undefined;
          const sweep = (bounds?.width ?? clip.boardW) * 0.24 * (index % 2 === 0 ? 1 : -1);
          return { ...start, cameraX: Math.min(options.boardWidth, Math.max(0, start.cameraX + sweep)) };
        })()
      : driftStop(start, clip, index % 2 === 0 ? 1 : -1);
    events.push({ time: beatEnd, ...finalStop, ...metadata });
  }

  const byTime = new Map<number, TopicCameraKeyframe>();
  for (const event of events.sort((left, right) => left.time - right.time)) {
    const rounded = Math.round(event.time * 1000);
    // At a shared boundary, the upcoming beat owns the keyframe and its scope.
    byTime.set(rounded, { ...event, time: Number(event.time.toFixed(3)) });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function auditTopicCameraArrivals(options: TopicCameraOptions, keyframes: TopicCameraKeyframe[]): CameraArrivalAudit[] {
  const clips = options.clips.slice().sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  const starts = beatStartStops(options, clips);
  const fallback = starts[0] ?? { cameraX: 0, cameraY: 0, boardZoom: 1 };
  return clips.map((clip, index) => {
    const target = starts[index];
    const actual = interpolateCameraKeyframes(keyframes, clip.startTime, fallback);
    const arrived = stopsMatch(actual, target);
    const exact = arrived
      ? keyframes.find((frame) => Math.abs(frame.time - clip.startTime) < 0.0005 && stopsMatch(frame, target))
      : undefined;
    const arrivalTime = exact?.time ?? Number.POSITIVE_INFINITY;
    const previous = clips[index - 1];
    const previousMotionStart = previous
      ? previous.startTime + Math.max(0.1, clip.startTime - previous.startTime) * AUTO_CAMERA_HOLD_FRACTION
      : clip.startTime;
    const scope = scopeForClip(clip);
    return {
      clipId: clip.id,
      scope,
      framing: scope === "broad" ? "wide cluster move" : "tight subject",
      plannedTime: clip.startTime,
      arrivalTime,
      driftSeconds: Number.isFinite(arrivalTime) ? Math.abs(arrivalTime - clip.startTime) : Number.POSITIVE_INFINITY,
      travelSeconds: index > 0 ? clip.startTime - previousMotionStart : 0,
    };
  });
}

export function auditCameraMotion(
  keyframes: readonly TopicCameraKeyframe[],
  runtimeStart?: number,
  runtimeEnd?: number,
): CameraMotionAudit {
  const sorted = keyframes.slice().sort((left, right) => left.time - right.time);
  const start = runtimeStart ?? sorted[0]?.time ?? 0;
  const end = runtimeEnd ?? sorted.at(-1)?.time ?? start;
  let motionSeconds = 0;
  let holdSeconds = 0;
  for (let index = 0; index < sorted.length - 1; index++) {
    const from = sorted[index];
    const to = sorted[index + 1];
    const segmentStart = Math.max(start, from.time);
    const segmentEnd = Math.min(end, to.time);
    if (segmentEnd <= segmentStart) continue;
    if (stopsMatch(from, to)) holdSeconds += segmentEnd - segmentStart;
    else motionSeconds += segmentEnd - segmentStart;
  }
  if (sorted.length && end > Math.max(start, sorted.at(-1)!.time)) holdSeconds += end - Math.max(start, sorted.at(-1)!.time);
  const runtimeSeconds = Math.max(0, end - start);
  return {
    runtimeSeconds,
    motionSeconds,
    holdSeconds,
    motionFraction: runtimeSeconds ? motionSeconds / runtimeSeconds : 0,
    holdFraction: runtimeSeconds ? holdSeconds / runtimeSeconds : 0,
    easing: AUTO_CAMERA_EASING,
    velocityContinuousAtMoveHoldBoundaries: true,
  };
}

/** Broad frames may own broad beats only; a result above zero is a scheduler regression. */
export function countBroadMovesInsideNarrowBeats(
  clips: readonly TopicCameraClip[],
  keyframes: readonly TopicCameraKeyframe[],
): number {
  return clips.filter((clip) => scopeForClip(clip) === "narrow").reduce((count, clip) => {
    return count + keyframes.filter((frame) => frame.beatId === clip.id && frame.broadPan === true).length;
  }, 0);
}
