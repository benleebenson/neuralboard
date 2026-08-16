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
};

type CameraStop = Omit<TopicCameraKeyframe, "time" | "easing">;

type TopicCameraOptions = {
  clips: TopicCameraClip[];
  topicBounds: TopicCameraBounds[];
  canvasWidth: number;
  canvasHeight: number;
  boardWidth: number;
  imageFocusRatio: number;
};

function stopForRect(
  rect: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  boardWidth: number,
  fillRatio: number,
): CameraStop {
  const scale = fillRatio * Math.min(canvasWidth / Math.max(1, rect.width), canvasHeight / Math.max(1, rect.height));
  return {
    cameraX: rect.x + rect.width / 2,
    cameraY: rect.y + rect.height / 2,
    boardZoom: scale * boardWidth / canvasWidth,
  };
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
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const imageStop = imageStops[index];
    const holdEnd = clip.startTime + clip.duration * (clip.holdFraction ?? 0.6);
    const clipEnd = clip.startTime + clip.duration;
    // The editorial timestamp is an arrival deadline, not the beginning of a camera move.
    // Every image must therefore be the resolved camera stop at its exact narration start.
    events.push({ time: clip.startTime, ...imageStop, easing: "ease-in-out" });
    if (holdEnd > clip.startTime) events.push({ time: holdEnd, ...imageStop, easing: "ease-in-out" });

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
