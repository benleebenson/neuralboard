import { cameraForFocusRect } from "./focus-camera.ts";

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
  easing: "ease-in-out";
  shot?: "wide" | "tight";
  broadPan?: boolean;
};

type CameraStop = Omit<TopicCameraKeyframe, "time" | "easing">;

export type CameraArrivalAudit = {
  clipId: string;
  plannedTime: number;
  arrivalTime: number;
  driftSeconds: number;
  travelSeconds: number;
};

type TopicCameraOptions = {
  clips: TopicCameraClip[];
  topicBounds: TopicCameraBounds[];
  canvasWidth: number;
  canvasHeight: number;
  boardWidth: number;
  imageFocusRatio: number;
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

export function cameraTravelSeconds(from: CameraStop, to: CameraStop, boardWidth: number): number {
  const distance = Math.hypot(to.cameraX - from.cameraX, to.cameraY - from.cameraY);
  const distanceSeconds = distance / Math.max(1, boardWidth) * 5.5;
  const zoomSeconds = Math.abs(Math.log(Math.max(0.01, to.boardZoom) / Math.max(0.01, from.boardZoom))) * 0.55;
  return Math.min(2.5, Math.max(0.35, distanceSeconds + zoomSeconds));
}

export function buildTopicClusterCameraKeyframes(options: TopicCameraOptions): TopicCameraKeyframe[] {
  const clips = options.clips.slice().sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  if (!clips.length) return [];
  const boundsByTopic = new Map(options.topicBounds.map((bounds) => [bounds.topicId, bounds]));
  const imageStops = clips.map((clip) => stopForRect(
    { x: clip.boardX, y: clip.boardY, width: clip.boardW, height: clip.boardH },
    options.canvasWidth,
    options.canvasHeight,
    options.boardWidth,
    options.imageFocusRatio,
  ));
  const firstTopicClip = clips.map((clip, index) => !!clip.topicId && (index === 0 || clips[index - 1].topicId !== clip.topicId));
  const events: TopicCameraKeyframe[] = [];
  let lastBroadPan = clips[0].startTime;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const imageStop = imageStops[index];
    const holdEnd = clip.startTime + clip.duration * (clip.holdFraction ?? 0.6);
    const clipEnd = clip.startTime + clip.duration;
    const topicBounds = clip.topicId ? boundsByTopic.get(clip.topicId) : undefined;
    // The editorial timestamp is an arrival deadline, not the beginning of a camera move.
    // Every image must therefore be the resolved camera stop at its exact narration start.
    const previousStop = index > 0 ? imageStops[index - 1] : imageStop;
    const travelSeconds = index > 0 ? cameraTravelSeconds(previousStop, imageStop, options.boardWidth) : 0;
    const travelStart = Math.max(clips[index - 1]?.startTime ?? 0, clip.startTime - travelSeconds);
    if (index > 0 && travelStart < clip.startTime - 0.001) {
      events.push({ time: travelStart, ...previousStop, easing: "ease-in-out" });
    }
    events.push({ time: clip.startTime, ...imageStop, easing: "ease-in-out", shot: "tight" });
    if (clip.role === "intro" && holdEnd - clip.startTime >= 0.8) {
      const panDistance = clip.boardW * 0.015;
      events.push({ time: clip.startTime + (holdEnd - clip.startTime) * 0.5, ...imageStop, cameraX: imageStop.cameraX - panDistance, easing: "ease-in-out" });
      events.push({ time: holdEnd, ...imageStop, cameraX: imageStop.cameraX + panDistance, easing: "ease-in-out" });
    } else if (holdEnd > clip.startTime) {
      events.push({ time: holdEnd, ...imageStop, easing: "ease-in-out", shot: "tight" });
    }
    if (topicBounds && Number.isFinite(options.maxBroadPanGapSec)) {
      const wantsWide = clip.shot === "wide";
      const firstPanTime = wantsWide ? clip.startTime + Math.min(2, Math.max(0.4, clip.duration * 0.25)) : Math.max(clip.startTime + 2, lastBroadPan + 16);
      for (let panTime = firstPanTime; panTime + 2 <= clipEnd; panTime += 16) {
        const wideStop = stopForRect(topicBounds, options.canvasWidth, options.canvasHeight, options.boardWidth, 0.76);
        const sweep = topicBounds.width * 0.15;
        const direction = (index + Math.floor(panTime)) % 2 ? -1 : 1;
        events.push({ time: panTime, ...wideStop, cameraX: wideStop.cameraX - sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
        events.push({ time: panTime + 2, ...wideStop, cameraX: wideStop.cameraX + sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
        lastBroadPan = panTime;
      }
    }

    const nextClip = clips[index + 1];
    const nextTopicBounds = nextClip && firstTopicClip[index + 1] && nextClip.topicId
      ? boundsByTopic.get(nextClip.topicId)
      : undefined;
    if (nextClip && nextTopicBounds) {
      // Preserve the cluster-wide establishing shot, but schedule it before the next image's
      // narration timestamp so it can never make that image arrive late.
      const availableTransition = Math.max(0, nextClip.startTime - holdEnd);
      const establishingLead = Math.min(1.2, availableTransition * 0.45);
      const establishingTime = nextClip.startTime - establishingLead;
      if (establishingLead >= 0.1 && establishingTime > holdEnd) {
        events.push({
          time: establishingTime,
          ...stopForRect(nextTopicBounds, options.canvasWidth, options.canvasHeight, options.boardWidth, 0.82),
          easing: "ease-in-out",
        });
      }
    }
    if (!nextClip || clipEnd < nextClip.startTime - 0.001) {
      events.push({ time: clipEnd, ...imageStop, easing: "ease-in-out" });
    }
  }

  const seenTimes = new Set<number>();
  return events
    .sort((a, b) => a.time - b.time)
    .filter((keyframe) => {
      const rounded = Math.round(keyframe.time * 1000);
      if (seenTimes.has(rounded)) return false;
      seenTimes.add(rounded);
      return true;
    })
    .map((keyframe) => ({ ...keyframe, time: Number(keyframe.time.toFixed(3)) }));
}


export function auditTopicCameraArrivals(options: TopicCameraOptions, keyframes: TopicCameraKeyframe[]): CameraArrivalAudit[] {
  const sorted = keyframes.slice().sort((a, b) => a.time - b.time);
  return options.clips.slice().sort((a, b) => a.startTime - b.startTime).map((clip, index, clips) => {
    const target = stopForRect(
      { x: clip.boardX, y: clip.boardY, width: clip.boardW, height: clip.boardH },
      options.canvasWidth,
      options.canvasHeight,
      options.boardWidth,
      options.imageFocusRatio,
    );
    const exact = sorted.find((keyframe) => Math.abs(keyframe.time - clip.startTime) < 0.0005 &&
      Math.abs(keyframe.cameraX - target.cameraX) < 0.01 && Math.abs(keyframe.cameraY - target.cameraY) < 0.01);
    const arrivalTime = exact?.time ?? Number.POSITIVE_INFINITY;
    const previous = index > 0 ? stopForRect(
      { x: clips[index - 1].boardX, y: clips[index - 1].boardY, width: clips[index - 1].boardW, height: clips[index - 1].boardH },
      options.canvasWidth, options.canvasHeight, options.boardWidth, options.imageFocusRatio,
    ) : target;
    return {
      clipId: clip.id,
      plannedTime: clip.startTime,
      arrivalTime,
      driftSeconds: Number.isFinite(arrivalTime) ? Math.abs(arrivalTime - clip.startTime) : Number.POSITIVE_INFINITY,
      travelSeconds: index > 0 ? cameraTravelSeconds(previous, target, options.boardWidth) : 0,
    };
  });
}
