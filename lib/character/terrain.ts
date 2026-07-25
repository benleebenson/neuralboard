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
export type CharacterSolidMotion = { x: number; y: number; hitX: boolean; hitCeiling: boolean };

const RAY_STEP_PX = 1;
const RAY_REFINE_PX = 0.5;
const CHARACTER_COLLISION_SAMPLES = 7;

function solidClips(clips: readonly TerrainClip[]) {
  return clips.filter((clip) => clip.type === undefined || clip.type === "image" || clip.type === "video");
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
  const images = solidClips(clips);
  for (let index = images.length - 1; index >= 0; index -= 1) {
    if (pointIsSolidInClip(images[index], craters, worldPoint)) return images[index].id;
  }
  return null;
}

/** Marches in samples no farther than 1px apart, then refines the entry boundary to within 0.5px. */
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
  let previousT = 0;
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    const t = sample / sampleCount;
    const point = { x: from.x + dx * t, y: from.y + dy * t };
    const imageId = solidAt(clips, craters, point);
    if (imageId) {
      let outsideT = previousT;
      let insideT = t;
      while ((insideT - outsideT) * distance > RAY_REFINE_PX) {
        const midT = (outsideT + insideT) / 2;
        const mid = { x: from.x + dx * midT, y: from.y + dy * midT };
        if (solidAt(clips, craters, mid)) insideT = midT;
        else outsideT = midT;
      }
      const refined = { x: from.x + dx * insideT, y: from.y + dy * insideT };
      return { point: refined, imageId: solidAt(clips, craters, refined) ?? imageId, normalHint };
    }
    previousT = t;
  }
  return null;
}

function surfaceYForClip(clip: TerrainClip, craters: readonly TerrainCrater[], x: number): number | null {
  const localX = x - clip.boardX;
  if (localX < 0 || localX > clip.boardW) return null;
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
  for (const clip of solidClips(clips)) {
    const y = surfaceYForClip(clip, craters, x);
    if (y === null || (best && y >= best.y)) continue;
    const left = surfaceYForClip(clip, craters, x - 1);
    const right = surfaceYForClip(clip, craters, x + 1);
    const slope = left === null || right === null ? 0 : (right - left) / 2;
    best = { y, imageId: clip.id, slope };
  }
  return best;
}

function characterBodyIntersectsSolid(
  clips: readonly TerrainClip[],
  craters: readonly TerrainCrater[],
  x: number,
  feetY: number,
  halfWidth: number,
  height: number,
): boolean {
  for (let xi = 0; xi < 3; xi += 1) {
    const sampleX = x + (xi - 1) * halfWidth;
    for (let yi = 0; yi < CHARACTER_COLLISION_SAMPLES; yi += 1) {
      const sampleY = feetY - 6 - (height - 12) * (yi / (CHARACTER_COLLISION_SAMPLES - 1));
      if (solidAt(clips, craters, { x: sampleX, y: sampleY })) return true;
    }
  }
  return false;
}

/**
 * Sweeps a standing character body against the solid interior of image/video boxes.
 * Ground landing is still handled by groundProfileY; this catches side walls, crater
 * walls, and image undersides without allowing a fast frame to tunnel through them.
 */
export function resolveCharacterSolidMotion(
  clips: readonly TerrainClip[],
  craters: readonly TerrainCrater[],
  from: TerrainPoint,
  to: TerrainPoint,
  options: { halfWidth?: number; height?: number } = {},
): CharacterSolidMotion {
  const halfWidth = options.halfWidth ?? 22;
  const height = options.height ?? 205;
  let x = to.x;
  let y = to.y;
  let hitX = false;
  let hitCeiling = false;

  if (to.x !== from.x && characterBodyIntersectsSolid(clips, craters, to.x, from.y, halfWidth, height)) {
    let safe = from.x;
    let blocked = to.x;
    for (let step = 0; step < 10; step += 1) {
      const mid = (safe + blocked) / 2;
      if (characterBodyIntersectsSolid(clips, craters, mid, from.y, halfWidth, height)) blocked = mid;
      else safe = mid;
    }
    x = safe;
    hitX = true;
  }

  if (to.y < from.y && characterBodyIntersectsSolid(clips, craters, x, to.y, halfWidth, height)) {
    let safe = from.y;
    let blocked = to.y;
    for (let step = 0; step < 10; step += 1) {
      const mid = (safe + blocked) / 2;
      if (characterBodyIntersectsSolid(clips, craters, x, mid, halfWidth, height)) blocked = mid;
      else safe = mid;
    }
    y = safe;
    hitCeiling = true;
  }

  return { x, y, hitX, hitCeiling };
}

/**
 * Lets a grounded character follow the crater profile of its current image without
 * treating that same curved floor as a side wall. Other image/video boxes remain
 * solid, so this cannot walk through an adjacent prop or stacked image.
 */
export function resolveGroundedCharacterMotion(
  clips: readonly TerrainClip[],
  craters: readonly TerrainCrater[],
  from: TerrainPoint,
  targetX: number,
  supportImageId: string | null,
  options: { halfWidth?: number; height?: number; maxStepUp?: number; maxStepDown?: number } = {},
): CharacterSolidMotion {
  if (!supportImageId) {
    return resolveCharacterSolidMotion(clips, craters, from, { x: targetX, y: from.y }, options);
  }
  const supportClip = solidClips(clips).find((clip) => clip.id === supportImageId);
  const support = supportClip ? groundProfileY([supportClip], craters, targetX) : null;
  const rise = support ? from.y - support.y : Infinity;
  const drop = support ? support.y - from.y : Infinity;
  if (
    !support ||
    rise > (options.maxStepUp ?? 96) ||
    drop > (options.maxStepDown ?? 96)
  ) {
    return resolveCharacterSolidMotion(clips, craters, from, { x: targetX, y: from.y }, options);
  }

  const blockers = clips.filter((clip) => clip.id !== supportImageId);
  const motion = resolveCharacterSolidMotion(
    blockers,
    craters,
    from,
    { x: targetX, y: support.y },
    options,
  );
  return motion.hitX || motion.hitCeiling
    ? motion
    : { ...motion, y: support.y };
}
