export type CharacterFocusId = "c1" | "c2";

export type CameraLike = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

export type CharacterFocusBlockLike = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  layer?: number;
  focusCharacterId?: CharacterFocusId;
};

export type CharacterFocusPosition = { x: number; y: number };

const CHARACTER_BOARD_HEIGHT = 170;
const CHARACTER_FRAME_HEIGHT_RATIO = 0.55;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

/**
 * Temporarily replaces the authored camera with a moving character shot. While the block is
 * active, its camera is absolute: image transitions, pans, and other authored camera moves cannot
 * leak into the shot. The authored camera keeps progressing separately and resumes after the block.
 */
export function applyCharacterFocusCamera(args: {
  time: number;
  clips: readonly CharacterFocusBlockLike[];
  baseCamera: CameraLike;
  canvasW: number;
  canvasH: number;
  boardW: number;
  positionAt: (characterId: CharacterFocusId, time: number) => CharacterFocusPosition | null;
}): CameraLike {
  const { time, clips, baseCamera, canvasW, canvasH, boardW, positionAt } = args;
  const block = activeCharacterFocusBlock(clips, time);
  if (!block) return baseCamera;

  const position = positionAt(block.focusCharacterId ?? "c1", time);
  if (!position) return baseCamera;

  return {
    cameraX: position.x,
    cameraY: position.y - 70,
    boardZoom: clamp(
      CHARACTER_FRAME_HEIGHT_RATIO * canvasH * boardW / (canvasW * CHARACTER_BOARD_HEIGHT),
      1.1,
      8,
    ),
  };
}
