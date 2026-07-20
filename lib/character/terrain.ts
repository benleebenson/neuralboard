export type TerrainPoint = { x: number; y: number };
export type TerrainCrater = { clipId: string; cx: number; cy: number; r: number; seed?: number };
export type TerrainClip = {
  id: string;
  type?: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
};
export type TerrainHit = { point: TerrainPoint; imageId: string; normalHint: TerrainPoint };
export type GroundProfile = { y: number; imageId: string; slope: number };

const RAY_STEP_PX = 6;
const STANDABLE_MARGIN_PX = 40;

function imageClips(clips: readonly TerrainClip[]) {
  return clips.filter((clip) => clip.type === undefined || clip.type === "image");
}

function cratersFor(craters: readonly TerrainCrater[], imageId: string) {
  return craters.filter((crater) => crater.clipId === imageId);
}

function pointIsSolidInClip(clip: TerrainClip, craters: readonly TerrainCrater[], point: TerrainPoint) {
  if (point.x < clip.boardX || point.x > clip.boardX + clip.boardW || point.y < clip.boardY || point.y > clip.boardY + clip.boardH) return false;
  const localX = point.x - clip.boardX;
  const localY = point.y - clip.boardY;
  return !cratersFor(craters, clip.id).some((crater) => (localX - crater.cx) ** 2 + (localY - crater.cy) ** 2 <= crater.r ** 2);
}

/** Returns the topmost image containing analytic solid material at a world point. */
export function solidAt(clips: readonly TerrainClip[], craters: readonly TerrainCrater[], worldPoint: TerrainPoint): string | null {
  const images = imageClips(clips);
  for (let index = images.length - 1; index >= 0; index -= 1) {
    if (pointIsSolidInClip(images[index], craters, worldPoint)) return images[index].id;
  }
  return null;
}

/** Marches a segment in samples no farther than 6px apart and returns its first solid hit. */
export function raycastSolid(clips: readonly TerrainClip[], craters: readonly TerrainCrater[], from: TerrainPoint, to: TerrainPoint): TerrainHit | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    const imageId = solidAt(clips, craters, from);
    return imageId ? { point: { ...from }, imageId, normalHint: { x: 0, y: -1 } } : null;
  }
  const sampleCount = Math.max(1, Math.ceil(distance / RAY_STEP_PX));
  const normalHint = { x: -dx / distance, y: -dy / distance };
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    const t = sample / sampleCount;
    const point = { x: from.x + dx * t, y: from.y + dy * t };
    const imageId = solidAt(clips, craters, point);
    if (imageId) return { point, imageId, normalHint };
  }
  return null;
}

function surfaceYForClip(clip: TerrainClip, craters: readonly TerrainCrater[], x: number): number | null {
  const localX = x - clip.boardX;
  if (localX < STANDABLE_MARGIN_PX || localX > clip.boardW - STANDABLE_MARGIN_PX) return null;
  const removed = cratersFor(craters, clip.id)
    .flatMap((crater) => {
      const dx = localX - crater.cx;
      if (Math.abs(dx) > crater.r) return [];
      const halfHeight = Math.sqrt(Math.max(0, crater.r ** 2 - dx ** 2));
      return [{ start: Math.max(0, crater.cy - halfHeight), end: Math.min(clip.boardH, crater.cy + halfHeight) }];
    })
    .filter((interval) => interval.end >= 0 && interval.start <= clip.boardH)
    .sort((a, b) => a.start - b.start);

  let localY = 0;
  for (const interval of removed) {
    if (interval.start > localY) break;
    if (interval.end >= localY) localY = interval.end;
  }
  return localY >= clip.boardH ? null : clip.boardY + localY;
}

/** Returns the highest standable image surface at x, including crater bowls and punch-through fallthrough. */
export function groundProfileY(clips: readonly TerrainClip[], craters: readonly TerrainCrater[], x: number): GroundProfile | null {
  let best: GroundProfile | null = null;
  for (const clip of imageClips(clips)) {
    const y = surfaceYForClip(clip, craters, x);
    if (y === null || (best && y >= best.y)) continue;
    const left = surfaceYForClip(clip, craters, x - 1);
    const right = surfaceYForClip(clip, craters, x + 1);
    const slope = left === null || right === null ? 0 : (right - left) / 2;
    best = { y, imageId: clip.id, slope };
  }
  return best;
}
