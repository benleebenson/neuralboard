import type { CharacterSkin } from "../stream";

export const STREAM_CHARACTER_GEOMETRY = {
  characterHeight: 181,
  hipRaw: 76,
  legRaw: 38,
  torsoRaw: 53,
  neckRaw: 12,
  headRaw: 20,
  armRaw: 32,
  shoulderFactor: 0.85,
  stickStrokeRaw: 3,
  launcherStickWidthRaw: 14,
  launcherStickHeightRaw: 8,
} as const;

export type LegPoint = { x: number; y: number };
export type SolvedLegChain = { knee: LegPoint; foot: LegPoint };

/** Two-bone IK with immutable segment lengths and a slightly bent maximum reach. */
export function solveFixedLegChain(
  hip: LegPoint,
  target: LegPoint,
  side: -1 | 1,
  segmentLength: number = STREAM_CHARACTER_GEOMETRY.legRaw,
): SolvedLegChain {
  const dx = target.x - hip.x;
  const dy = target.y - hip.y;
  const rawDistance = Math.max(0.001, Math.hypot(dx, dy));
  const distance = Math.min(rawDistance, segmentLength * 2 * 0.98);
  const unitX = dx / rawDistance;
  const unitY = dy / rawDistance;
  const foot = { x: hip.x + unitX * distance, y: hip.y + unitY * distance };
  const mid = { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 };
  const bendHeight = Math.sqrt(Math.max(0, segmentLength ** 2 - (distance / 2) ** 2));
  const bendSign = side === -1 ? 1 : -1;
  return {
    knee: {
      x: mid.x - unitY * bendHeight * bendSign,
      y: mid.y + unitX * bendHeight * bendSign,
    },
    foot,
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function characterConstructionParams(
  skin: CharacterSkin,
  sf: number,
  options?: { hasFace?: boolean; faceAspect?: number; jacked?: boolean },
): Record<string, number | string | boolean> {
  const g = STREAM_CHARACTER_GEOMETRY;
  const hasFace = !!options?.hasFace;
  const faceAspect = clamp(options?.faceAspect ?? 1, 0.75, 1.6);
  const headR = g.headRaw * sf * (hasFace ? 1.15 : 1);
  return {
    skin,
    scale: sf,
    characterHeight: g.characterHeight,
    hipY: -g.hipRaw * sf,
    torsoLength: g.torsoRaw * sf,
    neckLength: g.neckRaw * sf * (options?.jacked ? 0.72 : 1),
    armLength: g.armRaw * sf,
    legLength: g.legRaw * sf,
    shoulderY: -g.torsoRaw * g.shoulderFactor * sf,
    headRadius: headR,
    headRadiusX: hasFace ? headR / Math.sqrt(faceAspect) : headR,
    headRadiusY: hasFace ? headR * Math.sqrt(faceAspect) : headR,
    faceAspect,
    strokeWidth: Math.max(1, g.stickStrokeRaw * sf),
    launcherWidth: g.launcherStickWidthRaw * sf,
    launcherHeight: g.launcherStickHeightRaw * sf,
  };
}
