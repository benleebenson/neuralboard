export type CameraMode = "clips" | "character" | "follow";

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
  startTime?: number;
  duration?: number;
  holdFraction?: number;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
};

export type CharacterPosition = { x: number; y: number };
export type OccupancyWindow = { clipId: string; start: number; end: number };

export type FollowFramedSurface = {
  blockId: string;
  clipId?: string;
  start: number;
  end: number;
};

export type FollowCameraNote = {
  blockId: string;
  time: number;
  message: string;
};

export type FollowCameraDerivation = {
  keyframes: CameraKeyframeLike[];
  framedSurfaces: FollowFramedSurface[];
  occupancyWindows: OccupancyWindow[];
  notes: FollowCameraNote[];
};

export const FOLLOW_CAM_SAMPLE_STEP = 0.1;
export const FOLLOW_CAM_STIFFNESS = 18;
export const FOLLOW_CAM_DAMPING = 5;
export const FOLLOW_CAM_VELOCITY_LAG_SECONDS = 0.16;
export const FOLLOW_CAM_MAX_TRAIL_FRAME_FRACTION = 0.38;

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

type FollowSample = CameraStop & { time: number };

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value: number): number {
  const t = clampNumber(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function mergeOccupancyWindows(windows: OccupancyWindow[]): OccupancyWindow[] {
  const merged: OccupancyWindow[] = [];
  for (const window of [...windows].sort((a, b) => a.clipId.localeCompare(b.clipId) || a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous?.clipId === window.clipId && window.start <= previous.end + 0.001) {
      previous.end = Math.max(previous.end, window.end);
    } else if (window.end - window.start > 0.001) {
      merged.push({ ...window });
    }
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end || a.clipId.localeCompare(b.clipId));
}

function dynamicFollowSamples(args: {
  duration: number;
  canvasW: number;
  canvasH: number;
  boardW: number;
  positionAt: (time: number) => CharacterPosition;
  sampleStep: number;
}): FollowSample[] {
  const { duration, canvasW: W, canvasH: H, boardW, positionAt, sampleStep } = args;
  const samples: FollowSample[] = [];
  let previousPosition: CharacterPosition | null = null;
  let previousTime = 0;
  let camera: CharacterPosition | null = null;
  const cameraVelocity: CharacterPosition = { x: 0, y: 0 };

  const sampleTimes: number[] = [];
  for (let time = 0; time < duration; time += sampleStep) sampleTimes.push(Number(time.toFixed(6)));
  if (sampleTimes.length === 0 || Math.abs(sampleTimes[sampleTimes.length - 1] - duration) > 0.000001) {
    sampleTimes.push(duration);
  }

  for (const t of sampleTimes) {
    const position = positionAt(t);
    const desired = characterStop(position, W, H, boardW, 0.4);
    const visibleWidth = boardW / Math.max(0.05, desired.zoom);
    const visibleHeight = visibleWidth * H / W;
    const maxTrailX = visibleWidth * FOLLOW_CAM_MAX_TRAIL_FRAME_FRACTION;
    const maxTrailY = visibleHeight * FOLLOW_CAM_MAX_TRAIL_FRAME_FRACTION;

    if (!camera || !previousPosition) {
      camera = { x: desired.camX, y: desired.camY };
    } else {
      const dt = Math.max(0.000001, t - previousTime);
      const characterVelocity = {
        x: (position.x - previousPosition.x) / dt,
        y: (position.y - previousPosition.y) / dt,
      };
      const lagX = clampNumber(
        characterVelocity.x * FOLLOW_CAM_VELOCITY_LAG_SECONDS,
        -maxTrailX * 0.72,
        maxTrailX * 0.72,
      );
      const lagY = clampNumber(
        characterVelocity.y * FOLLOW_CAM_VELOCITY_LAG_SECONDS,
        -maxTrailY * 0.72,
        maxTrailY * 0.72,
      );
      const laggedTarget = { x: desired.camX - lagX, y: desired.camY - lagY };
      cameraVelocity.x += (
        FOLLOW_CAM_STIFFNESS * (laggedTarget.x - camera.x) - FOLLOW_CAM_DAMPING * cameraVelocity.x
      ) * dt;
      cameraVelocity.y += (
        FOLLOW_CAM_STIFFNESS * (laggedTarget.y - camera.y) - FOLLOW_CAM_DAMPING * cameraVelocity.y
      ) * dt;
      camera.x += cameraVelocity.x * dt;
      camera.y += cameraVelocity.y * dt;

      const offsetX = camera.x - desired.camX;
      const offsetY = camera.y - desired.camY;
      const clampedOffsetX = clampNumber(offsetX, -maxTrailX, maxTrailX);
      const clampedOffsetY = clampNumber(offsetY, -maxTrailY, maxTrailY);
      if (clampedOffsetX !== offsetX && Math.sign(cameraVelocity.x) === Math.sign(offsetX)) cameraVelocity.x = 0;
      if (clampedOffsetY !== offsetY && Math.sign(cameraVelocity.y) === Math.sign(offsetY)) cameraVelocity.y = 0;
      camera.x = desired.camX + clampedOffsetX;
      camera.y = desired.camY + clampedOffsetY;
    }

    samples.push({ time: t, camX: camera.x, camY: camera.y, zoom: desired.zoom });
    previousPosition = position;
    previousTime = t;
  }
  return samples;
}

function followSampleAt(samples: FollowSample[], time: number): CameraStop {
  if (samples.length === 0) return { camX: 0, camY: 0, zoom: 1 };
  if (time <= samples[0].time) return samples[0];
  const last = samples[samples.length - 1];
  if (time >= last.time) return last;
  let high = samples.findIndex((sample) => sample.time >= time);
  if (high <= 0) high = 1;
  const before = samples[high - 1];
  const after = samples[high];
  const progress = (time - before.time) / Math.max(0.000001, after.time - before.time);
  return {
    camX: before.camX + (after.camX - before.camX) * progress,
    camY: before.camY + (after.camY - before.camY) * progress,
    zoom: before.zoom + (after.zoom - before.zoom) * progress,
  };
}

/**
 * Bakes the always-on spring follow camera and any frameSurface overrides into one sampled
 * keyframe track. The frame block's transition budget is split evenly between its zoom-out and
 * return, leaving the configured hold fraction static in the middle of the block.
 */
export function deriveFollowCameraKeyframes(args: {
  actions: ResolvedCharacterActionLike[];
  clips: BoardClipLike[];
  duration: number;
  canvasW: number;
  canvasH: number;
  boardW: number;
  positionAt: (time: number) => CharacterPosition;
  sampleStep?: number;
}): FollowCameraDerivation {
  const {
    actions, clips, duration, canvasW: W, canvasH: H, boardW, positionAt,
  } = args;
  if (duration <= 0) return { keyframes: [], framedSurfaces: [], occupancyWindows: [], notes: [] };
  const sampleStep = Math.max(0.01, args.sampleStep ?? FOLLOW_CAM_SAMPLE_STEP);
  const followSamples = dynamicFollowSamples({ duration, canvasW: W, canvasH: H, boardW, positionAt, sampleStep });
  const notes: FollowCameraNote[] = [];
  const framedSurfaces: FollowFramedSurface[] = [];
  const blocks = clips
    .filter((clip) => clip.type === "frameSurface" && (clip.duration ?? 0) > 0 && (clip.startTime ?? 0) < duration)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0) || a.id.localeCompare(b.id))
    .map((block) => {
      const start = clampNumber(block.startTime ?? 0, 0, duration);
      const end = clampNumber(start + (block.duration ?? 0), start, duration);
      const position = positionAt(start);
      const surface = occupiedClipAtPosition(position, clips);
      const stop = surface
        ? clipStop(surface, W, H, boardW)
        : characterStop(position, W, H, boardW, 0.3);
      const holdFraction = clampNumber(block.holdFraction ?? 0.6, 0.1, 0.95);
      const transitionSide = Math.max(0, (end - start) * (1 - holdFraction) / 2);
      const framed = { blockId: block.id, clipId: surface?.id, start, end };
      framedSurfaces.push(framed);
      if (!surface) {
        notes.push({
          blockId: block.id,
          time: start,
          message: `Frame surface at ${start.toFixed(2)}s found bare parchment; framing Character 1 wide instead.`,
        });
      }
      return {
        start,
        end,
        holdStart: start + transitionSide,
        holdEnd: end - transitionSide,
        stop,
      };
    });

  const times = new Set<number>(followSamples.map((sample) => Math.round(sample.time * 1_000)));
  for (const block of blocks) {
    for (const time of [block.start, block.holdStart, block.holdEnd, block.end]) {
      times.add(Math.round(time * 1_000));
    }
  }

  const keyframes = [...times]
    .map((milliseconds) => milliseconds / 1_000)
    .filter((time) => time >= 0 && time <= duration)
    .sort((a, b) => a - b)
    .map((time): CameraKeyframeLike => {
      const follow = followSampleAt(followSamples, time);
      let active: typeof blocks[number] | undefined;
      for (const block of blocks) {
        if (time >= block.start && time <= block.end) active = block;
      }
      if (!active) {
        return { time: Number(time.toFixed(3)), cameraX: follow.camX, cameraY: follow.camY, boardZoom: follow.zoom, easing: "linear" };
      }
      const blend = time < active.holdStart
        ? smoothstep((time - active.start) / Math.max(0.000001, active.holdStart - active.start))
        : time <= active.holdEnd
          ? 1
          : 1 - smoothstep((time - active.holdEnd) / Math.max(0.000001, active.end - active.holdEnd));
      return {
        time: Number(time.toFixed(3)),
        cameraX: follow.camX + (active.stop.camX - follow.camX) * blend,
        cameraY: follow.camY + (active.stop.camY - follow.camY) * blend,
        boardZoom: follow.zoom + (active.stop.zoom - follow.zoom) * blend,
        easing: "linear",
      };
    });

  const standingWindows = deriveOccupancyWindows({ actions, clips, duration, positionAt });
  const framedWindows = framedSurfaces.flatMap((surface): OccupancyWindow[] =>
    surface.clipId ? [{ clipId: surface.clipId, start: surface.start, end: surface.end }] : []
  );

  return {
    keyframes,
    framedSurfaces,
    occupancyWindows: mergeOccupancyWindows([...standingWindows, ...framedWindows]),
    notes,
  };
}
