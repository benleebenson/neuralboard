export type CameraMode = "clips" | "character";

export type CameraKeyframeLike = {
  time: number;
  cameraX: number;
  cameraY: number;
  boardZoom: number;
  easing?: "linear" | "ease-in-out";
};

export type ResolvedCharacterActionLike = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  fromX: number;
  fromY: number;
  targetX?: number;
  targetY?: number;
};

export type BoardClipLike = {
  id: string;
  type: string;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
};

export type CharacterPosition = { x: number; y: number };
export type OccupancyWindow = { clipId: string; start: number; end: number };

export const CHARACTER_TRAVEL_ACTIONS = new Set([
  "walkTo", "run", "jumpTo", "flip", "grapple", "zipline", "wallClimb", "skateTo",
  "entrance", "exit",
]);

export const CHARACTER_SETTLED_ACTIONS = new Set([
  "idle", "explainGesture", "emote", "pointAt", "sitAndWatch", "dance", "pullUps", "mirrorCheck",
]);

export function classifyCharacterAction(type: string): "travel" | "settled" {
  if (CHARACTER_TRAVEL_ACTIONS.has(type)) return "travel";
  if (CHARACTER_SETTLED_ACTIONS.has(type)) return "settled";
  // Custom/authored stationary actions are safest as scene shots; only explicitly mobile
  // choreography is allowed to drive the sampled follow camera.
  return "settled";
}

export function characterProjectDuration(actions: Array<{ startTime: number; duration: number }>): number {
  if (actions.length === 0) return 0;
  return Math.max(...actions.map((action) => action.startTime + action.duration)) + 1;
}

export function actionAtTime(
  actions: ResolvedCharacterActionLike[],
  time: number,
): ResolvedCharacterActionLike | undefined {
  return actions.find((action) => time >= action.startTime && time < action.startTime + action.duration);
}

export function occupiedClipAtPosition(
  position: CharacterPosition,
  clips: BoardClipLike[],
): BoardClipLike | undefined {
  const SURFACE_TOLERANCE = 16;
  return clips
    .filter((clip) => clip.type === "image" || clip.type === "video")
    .filter((clip) => clip.boardX !== undefined && clip.boardY !== undefined && clip.boardW !== undefined)
    .filter((clip) =>
      position.x >= clip.boardX! && position.x <= clip.boardX! + clip.boardW! &&
      Math.abs(position.y - clip.boardY!) <= SURFACE_TOLERANCE
    )
    .sort((a, b) => Math.abs(position.y - a.boardY!) - Math.abs(position.y - b.boardY!))[0];
}

export function deriveOccupancyWindows(args: {
  actions: ResolvedCharacterActionLike[];
  clips: BoardClipLike[];
  duration: number;
  positionAt: (time: number) => CharacterPosition;
  sampleStep?: number;
}): OccupancyWindow[] {
  const { actions, clips, duration, positionAt } = args;
  const step = args.sampleStep ?? 0.05;
  const windows: OccupancyWindow[] = [];
  let open: OccupancyWindow | null = null;

  for (let time = 0; time <= duration + step / 2; time = Math.min(duration, time + step)) {
    const t = Math.min(duration, Number(time.toFixed(6)));
    const active = actionAtTime(actions, Math.min(t, Math.max(0, duration - 0.000001)));
    const isTravel = !!active && CHARACTER_TRAVEL_ACTIONS.has(active.type);
    const clip = isTravel ? undefined : occupiedClipAtPosition(positionAt(t), clips);
    const clipId = clip?.id;

    if (open && open.clipId !== clipId) {
      open.end = t;
      if (open.end - open.start > 0.001) windows.push(open);
      open = null;
    }
    if (!open && clipId) open = { clipId, start: t, end: duration };
    if (t >= duration) break;
  }

  if (open) {
    open.end = duration;
    if (open.end - open.start > 0.001) windows.push(open);
  }
  return windows;
}

export function occupancyWindowAt(
  windows: OccupancyWindow[],
  clipId: string,
  time: number,
): OccupancyWindow | undefined {
  return windows.find((window) => window.clipId === clipId && time >= window.start && time < window.end);
}

type CameraStop = { camX: number; camY: number; zoom: number };
type Segment = { start: number; end: number; kind: "travel" | "settled" };

function buildSegments(actions: ResolvedCharacterActionLike[], duration: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const action of [...actions].sort((a, b) => a.startTime - b.startTime)) {
    const start = Math.max(0, action.startTime);
    const end = Math.min(duration, action.startTime + action.duration);
    if (start > cursor) segments.push({ start: cursor, end: start, kind: "settled" });
    if (end > start) {
      segments.push({
        start,
        end,
        kind: classifyCharacterAction(action.type),
      });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, kind: "settled" });

  return segments.reduce<Segment[]>((merged, segment) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === segment.kind && Math.abs(previous.end - segment.start) < 0.001) {
      previous.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
    return merged;
  }, []);
}

function characterStop(
  position: CharacterPosition,
  W: number,
  H: number,
  boardW: number,
  heightRatio: number,
): CameraStop {
  const CHARACTER_BOARD_HEIGHT = 200;
  const sf = heightRatio * H / CHARACTER_BOARD_HEIGHT;
  return { camX: position.x, camY: position.y - 40, zoom: sf * boardW / W };
}

function clipStop(clip: BoardClipLike, W: number, H: number, boardW: number): CameraStop {
  const width = Math.max(1, clip.boardW ?? 1);
  const height = Math.max(1, clip.boardH ?? 1);
  const sf = 0.7 * Math.min(W / width, H / height);
  return {
    camX: clip.boardX! + width / 2,
    camY: clip.boardY! + height / 2,
    zoom: sf * boardW / W,
  };
}

function widenForSecondCharacter(
  stop: CameraStop,
  first: CharacterPosition,
  second: CharacterPosition | undefined,
  W: number,
  H: number,
  boardW: number,
): CameraStop {
  if (!second) return stop;
  const visibleW = boardW / Math.max(0.05, stop.zoom);
  const visibleH = visibleW * H / W;
  if (
    Math.abs(second.x - stop.camX) > visibleW * 0.65 ||
    Math.abs((second.y - 80) - stop.camY) > visibleH * 0.65
  ) return stop;

  const minX = Math.min(first.x, second.x) - 120;
  const maxX = Math.max(first.x, second.x) + 120;
  const minY = Math.min(first.y, second.y) - 220;
  const maxY = Math.max(first.y, second.y) + 40;
  const sf = 0.85 * Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY));
  const includeBothZoom = sf * boardW / W;
  if (includeBothZoom >= stop.zoom) return stop;
  return {
    camX: (minX + maxX) / 2,
    camY: (minY + maxY) / 2,
    zoom: includeBothZoom,
  };
}

export function deriveCharacterCameraKeyframes(args: {
  actions: ResolvedCharacterActionLike[];
  clips: BoardClipLike[];
  duration: number;
  canvasW: number;
  canvasH: number;
  boardW: number;
  positionAt: (time: number) => CharacterPosition;
  secondPositionAt?: (time: number) => CharacterPosition;
  sampleStep?: number;
  smoothingAlpha?: number;
  transitionDuration?: number;
}): CameraKeyframeLike[] {
  const {
    actions, clips, duration, canvasW: W, canvasH: H, boardW, positionAt, secondPositionAt,
  } = args;
  const sampleStep = args.sampleStep ?? 0.25;
  const smoothingAlpha = args.smoothingAlpha ?? 0.3;
  const transitionDuration = args.transitionDuration ?? 0.6;
  const segments = buildSegments(actions, duration);
  const events: CameraKeyframeLike[] = [];
  let smoothed: CharacterPosition | null = null;

  const emit = (time: number, stop: CameraStop, easing: "linear" | "ease-in-out") => {
    events.push({
      time: Number(time.toFixed(3)),
      cameraX: stop.camX,
      cameraY: stop.camY,
      boardZoom: stop.zoom,
      easing,
    });
  };

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const previousKind = segments[index - 1]?.kind;
    if (segment.kind === "travel") {
      for (let time = segment.start; time < segment.end + sampleStep / 2; time += sampleStep) {
        const t = Math.min(segment.end, time);
        const raw = positionAt(t);
        smoothed = smoothed
          ? {
              x: smoothed.x + (raw.x - smoothed.x) * smoothingAlpha,
              y: smoothed.y + (raw.y - smoothed.y) * smoothingAlpha,
            }
          : raw;
        const stop = characterStop(smoothed, W, H, boardW, 0.4);
        const changingType = previousKind === "settled" && t - segment.start <= transitionDuration;
        emit(t, stop, changingType ? "ease-in-out" : "linear");
        if (t >= segment.end) break;
      }
      continue;
    }

    const settleAt = Math.min(segment.end, segment.start + (previousKind === "travel" ? transitionDuration : 0));
    const first = positionAt(settleAt);
    const occupied = occupiedClipAtPosition(first, clips);
    let stop = occupied
      ? clipStop(occupied, W, H, boardW)
      : characterStop(first, W, H, boardW, 0.3);
    stop = widenForSecondCharacter(stop, first, secondPositionAt?.(settleAt), W, H, boardW);
    emit(settleAt, stop, previousKind === "travel" ? "ease-in-out" : "ease-in-out");
    if (segment.end > settleAt) emit(segment.end, stop, "ease-in-out");
    smoothed = first;
  }

  const byTime = new Map<number, CameraKeyframeLike>();
  for (const event of events.sort((a, b) => a.time - b.time)) byTime.set(Math.round(event.time * 1000), event);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
