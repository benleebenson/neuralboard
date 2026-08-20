import {
  interpolateCameraKeyframes,
  type CameraState,
} from "./camera-keyframes.ts";
import { FOCUS_FILL_RATIO } from "./board2/focus-camera.ts";

export type CharacterFocusId = "c1" | "c2";

export type CameraLike = CameraState;

export type CharacterFocusBlockLike = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  layer?: number;
  focusCharacterId?: CharacterFocusId;
  focusLeadInSeconds?: number;
  focusLeadOutSeconds?: number;
};

export type CharacterFocusPosition = { x: number; y: number; speechBubble?: boolean };

const CHARACTER_BOARD_HEIGHT = 170;
const PREVIOUS_CHARACTER_FRAME_HEIGHT_RATIO = 0.78;
const PREVIOUS_SPEECH_BUBBLE_FRAME_HEIGHT_RATIO = 0.68;
export const CHARACTER_FRAME_HEIGHT_RATIO = FOCUS_FILL_RATIO;
export const SPEECH_BUBBLE_FRAME_HEIGHT_RATIO = FOCUS_FILL_RATIO
  * PREVIOUS_SPEECH_BUBBLE_FRAME_HEIGHT_RATIO
  / PREVIOUS_CHARACTER_FRAME_HEIGHT_RATIO;
const CHARACTER_CAMERA_Y_OFFSET = 70;
const SPEECH_BUBBLE_CAMERA_Y_OFFSET = 95;

export const DEFAULT_CHARACTER_FOCUS_LEAD_IN_SECONDS = 0.5;
export const DEFAULT_CHARACTER_FOCUS_LEAD_OUT_SECONDS = 0.5;
export const CHARACTER_FOCUS_MIN_TRANSITION_SECONDS = 0.05;
export const CHARACTER_FOCUS_DISTANCE_REFERENCE_PX = 1000;
export const CHARACTER_FOCUS_DISTANCE_MULTIPLIER_FLOOR = 0.6;
export const CHARACTER_FOCUS_DISTANCE_MULTIPLIER_CEILING = 1.8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeCharacterFocusTransitionSeconds(
  value: unknown,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(CHARACTER_FOCUS_MIN_TRANSITION_SECONDS, value)
    : fallback;
}

export function characterFocusDistanceMultiplier(from: CameraLike, to: CameraLike): number {
  const distance = Math.hypot(to.cameraX - from.cameraX, to.cameraY - from.cameraY);
  return clamp(
    distance / CHARACTER_FOCUS_DISTANCE_REFERENCE_PX,
    CHARACTER_FOCUS_DISTANCE_MULTIPLIER_FLOOR,
    CHARACTER_FOCUS_DISTANCE_MULTIPLIER_CEILING,
  );
}

export function resolveCharacterFocusTransitionDurations(
  block: CharacterFocusBlockLike,
  entryCamera: CameraLike,
  entryFocusCamera: CameraLike,
  exitFocusCamera: CameraLike,
  exitCamera: CameraLike,
): { leadIn: number; hold: number; leadOut: number } {
  const duration = Math.max(0, block.duration);
  let leadIn = normalizeCharacterFocusTransitionSeconds(
    block.focusLeadInSeconds,
    DEFAULT_CHARACTER_FOCUS_LEAD_IN_SECONDS,
  ) * characterFocusDistanceMultiplier(entryCamera, entryFocusCamera);
  let leadOut = normalizeCharacterFocusTransitionSeconds(
    block.focusLeadOutSeconds,
    DEFAULT_CHARACTER_FOCUS_LEAD_OUT_SECONDS,
  ) * characterFocusDistanceMultiplier(exitFocusCamera, exitCamera);
  const transitionTotal = leadIn + leadOut;
  if (transitionTotal > duration && transitionTotal > 0) {
    const scale = duration / transitionTotal;
    leadIn *= scale;
    leadOut *= scale;
  }
  return {
    leadIn,
    hold: Math.max(0, duration - leadIn - leadOut),
    leadOut,
  };
}

/** The newest-starting block wins if blocks overlap. */
export function activeCharacterFocusBlock(
  clips: readonly CharacterFocusBlockLike[],
  time: number,
): CharacterFocusBlockLike | undefined {
  return clips
    .filter((clip) => clip.type === "characterFocus" && clip.duration > 0)
    .filter((clip) => time >= clip.startTime && time < clip.startTime + clip.duration)
    .sort((a, b) =>
      b.startTime - a.startTime ||
      (b.layer ?? 0) - (a.layer ?? 0) ||
      a.id.localeCompare(b.id)
    )[0];
}

export function cameraForCharacterPosition(
  position: CharacterFocusPosition,
  canvasW: number,
  canvasH: number,
  boardW: number,
): CameraLike {
  const frameHeightRatio = position.speechBubble
    ? SPEECH_BUBBLE_FRAME_HEIGHT_RATIO
    : CHARACTER_FRAME_HEIGHT_RATIO;
  const cameraYOffset = position.speechBubble
    ? SPEECH_BUBBLE_CAMERA_Y_OFFSET
    : CHARACTER_CAMERA_Y_OFFSET;
  return {
    cameraX: position.x,
    cameraY: position.y - cameraYOffset,
    boardZoom: clamp(
      frameHeightRatio * canvasH * boardW / (canvasW * CHARACTER_BOARD_HEIGHT),
      1.1,
      64,
    ),
  };
}

/**
 * Character focus is a runtime camera override, but the authored base track
 * still needs a placeholder at that point in the stop sequence. A character
 * placeholder holds the preceding authored stop (or the following stop when
 * first) so surrounding image transitions cannot skip across it.
 */
export function bridgeCharacterFocusStops<T>(
  stops: readonly (T | null)[],
  fallback: T,
): T[] {
  return stops.map((stop, index) => {
    if (stop !== null) return stop;
    for (let previous = index - 1; previous >= 0; previous--) {
      if (stops[previous] !== null) return stops[previous] as T;
    }
    for (let next = index + 1; next < stops.length; next++) {
      if (stops[next] !== null) return stops[next] as T;
    }
    return fallback;
  });
}

/** Resolves the authored camera plus any active character-focus block as one camera track. */
export function applyCharacterFocusCamera(args: {
  time: number;
  clips: readonly CharacterFocusBlockLike[];
  baseCameraAt: (time: number) => CameraLike;
  canvasW: number;
  canvasH: number;
  boardW: number;
  positionAt: (characterId: CharacterFocusId, time: number) => CharacterFocusPosition | null;
}): CameraLike {
  const { time, clips, baseCameraAt, canvasW, canvasH, boardW, positionAt } = args;

  const resolveAt = (sampleTime: number, excluded: ReadonlySet<string>): CameraLike => {
    const block = clips
      .filter((clip) => !excluded.has(clip.id))
      .filter((clip) => clip.type === "characterFocus" && clip.duration > 0)
      .filter((clip) => sampleTime >= clip.startTime && sampleTime < clip.startTime + clip.duration)
      .sort((a, b) =>
        b.startTime - a.startTime ||
        (b.layer ?? 0) - (a.layer ?? 0) ||
        a.id.localeCompare(b.id)
      )[0];
    if (!block) return baseCameraAt(sampleTime);

    const characterId = block.focusCharacterId ?? "c1";
    const position = positionAt(characterId, sampleTime);
    if (!position) return resolveAt(sampleTime, new Set([...excluded, block.id]));

    const blockEnd = block.startTime + block.duration;
    const withoutBlock = new Set([...excluded, block.id]);
    const entryCamera = resolveAt(block.startTime, withoutBlock);
    const exitCamera = resolveAt(blockEnd, withoutBlock);
    const entryPosition = positionAt(characterId, block.startTime) ?? position;
    const exitPosition = positionAt(characterId, blockEnd) ?? position;
    const entryFocusCamera = cameraForCharacterPosition(entryPosition, canvasW, canvasH, boardW);
    const focusCamera = cameraForCharacterPosition(position, canvasW, canvasH, boardW);
    const exitFocusCamera = cameraForCharacterPosition(exitPosition, canvasW, canvasH, boardW);
    const transitions = resolveCharacterFocusTransitionDurations(
      block,
      entryCamera,
      entryFocusCamera,
      exitFocusCamera,
      exitCamera,
    );
    const holdStart = block.startTime + transitions.leadIn;
    const holdEnd = holdStart + transitions.hold;

    if (sampleTime < holdStart) {
      return interpolateCameraKeyframes([
        { time: block.startTime, ...entryCamera },
        { time: holdStart, ...focusCamera, easing: "ease-in-out" },
      ], sampleTime, entryCamera);
    }
    if (sampleTime < holdEnd) return focusCamera;
    return interpolateCameraKeyframes([
      { time: holdEnd, ...focusCamera },
      { time: blockEnd, ...exitCamera, easing: "ease-in-out" },
    ], sampleTime, exitCamera);
  };

  return resolveAt(time, new Set());
}
