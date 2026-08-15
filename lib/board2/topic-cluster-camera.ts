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
  const startStops = clips.map((clip, index) => {
    const topicBounds = clip.topicId ? boundsByTopic.get(clip.topicId) : undefined;
    return firstTopicClip[index] && topicBounds
      ? stopForRect(topicBounds, options.canvasWidth, options.canvasHeight, options.boardWidth, 0.82)
      : imageStops[index];
  });

  const events: TopicCameraKeyframe[] = [];
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const imageStop = imageStops[index];
    const startStop = startStops[index];
    const nextStop = startStops[index + 1] ?? imageStop;
    const holdEnd = clip.startTime + clip.duration * (clip.holdFraction ?? 0.6);
    const clipEnd = clip.startTime + clip.duration;
    events.push({ time: clip.startTime, ...startStop, easing: "ease-in-out" });

    if (firstTopicClip[index] && clip.topicId && boundsByTopic.has(clip.topicId)) {
      // Use at most the first 30% of the image's spoken interval: a short static cluster/title
      // frame, followed by a smooth dive into the first image before its main hold completes.
      const establishingDuration = Math.min(1.2, clip.duration * 0.3);
      const establishingHoldEnd = clip.startTime + establishingDuration * 0.35;
      const establishingEnd = clip.startTime + establishingDuration;
      events.push({ time: establishingHoldEnd, ...startStop, easing: "ease-in-out" });
      events.push({ time: establishingEnd, ...imageStop, easing: "ease-in-out" });
    }
    if (holdEnd > clip.startTime) events.push({ time: holdEnd, ...imageStop, easing: "ease-in-out" });
    events.push({ time: clipEnd, ...nextStop, easing: "ease-in-out" });
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
