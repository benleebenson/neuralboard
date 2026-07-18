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
