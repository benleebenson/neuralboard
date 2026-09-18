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
    const broadPan = !!topicBounds && clip.duration >= 2 && (clip.shot === "wide" ||
      (Number.isFinite(options.maxBroadPanGapSec) && clip.startTime - lastBroadPan >= (options.maxBroadPanGapSec ?? Infinity) - 2));
    if (broadPan && topicBounds) {
      const travel = Math.min(4, Math.max(2, clip.duration * 0.65));
      const wideStop = stopForRect(topicBounds, options.canvasWidth, options.canvasHeight, options.boardWidth, 0.76);
      const sweep = topicBounds.width * 0.15;
      const direction = index % 2 ? -1 : 1;
      events.push({ time: clip.startTime, ...wideStop, cameraX: wideStop.cameraX - sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
      events.push({ time: Math.min(clipEnd, clip.startTime + travel), ...wideStop, cameraX: wideStop.cameraX + sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
      lastBroadPan = clip.startTime;
      for (let panTime = clip.startTime + 16; panTime + 2 <= clipEnd; panTime += 16) {
        events.push({ time: panTime, ...wideStop, cameraX: wideStop.cameraX + sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
        events.push({ time: panTime + 2, ...wideStop, cameraX: wideStop.cameraX - sweep * direction, easing: "ease-in-out", shot: "wide", broadPan: true });
        lastBroadPan = panTime;
      }
      continue;
    }
    // The editorial timestamp is an arrival deadline, not the beginning of a camera move.
    // Every image must therefore be the resolved camera stop at its exact narration start.
    events.push({ time: clip.startTime, ...imageStop, easing: "ease-in-out", shot: "tight" });
    if (holdEnd > clip.startTime) events.push({ time: holdEnd, ...imageStop, easing: "ease-in-out", shot: "tight" });
    if (topicBounds && Number.isFinite(options.maxBroadPanGapSec)) {
      for (let panTime = Math.max(clip.startTime + 2, lastBroadPan + 16); panTime + 2 <= clipEnd; panTime += 16) {
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
