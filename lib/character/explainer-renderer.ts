import type { Viseme } from "../stream";
import type { Gesture } from "./gestures";
import { STREAM_CHARACTER_GEOMETRY } from "./geometry";
import { drawCharacterMouth } from "./board-renderer";
import manifest from "../../public/characters/explainer/manifest.json";

export type Expression = "neutral" | "disgruntled";

export const EXPLAINER_SOURCE = { width: 1536, height: 2048, artworkTop: 549, artworkBottom: 1422 } as const;
export const EXPLAINER_SCALE = STREAM_CHARACTER_GEOMETRY.characterHeight / (EXPLAINER_SOURCE.artworkBottom - EXPLAINER_SOURCE.artworkTop);
export const EXPLAINER_MOUTH_ANCHOR = { x: 738, y: 781, headRadiusPx: 144 } as const;

type PoseName = "neutral_arms_down" | "self_hand_chest" | "point_up" | "thinking" | "shrug" | "arms_crossed";
const POSE_FILE: Record<Gesture, PoseName> = {
  neutral: "neutral_arms_down", self: "self_hand_chest", pointUp: "point_up",
  thinking: "thinking", shrug: "shrug", open: "shrug", outward: "arms_crossed",
};
const imageCache = new Map<string, HTMLImageElement>();

function image(path: string): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  let value = imageCache.get(path);
  if (!value) {
    value = new Image();
    value.onload = () => window.dispatchEvent(new Event("explainer-assets-loaded"));
    value.src = `/characters/explainer/${path}`;
    imageCache.set(path, value);
  }
  return value.complete && value.naturalWidth > 0 ? value : null;
}

function layer(ctx: CanvasRenderingContext2D, path: string, box: readonly [number, number, number, number]) {
  const source = image(path);
  if (!source) return;
  ctx.drawImage(source, box[0], box[1], box[2] - box[0], box[3] - box[1]);
}

export function drawExplainerCharacter(ctx: CanvasRenderingContext2D, args: {
  screenX: number; screenY: number; scale: number; facing: 1 | -1;
  gesture: Gesture;
  expression: Expression; viseme: Viseme;
}) {
  const poseName = POSE_FILE[args.gesture];
  const poseLayer = manifest.bodies[poseName];
  const faceLayer = manifest.faces[args.expression];
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(args.screenX, args.screenY);
  ctx.scale(args.facing * args.scale * EXPLAINER_SCALE, args.scale * EXPLAINER_SCALE);
  ctx.translate(-EXPLAINER_SOURCE.width / 2, -EXPLAINER_SOURCE.artworkBottom);
  layer(ctx, poseLayer.file, poseLayer.box as [number, number, number, number]);
  layer(ctx, faceLayer.file, faceLayer.box as [number, number, number, number]);
  drawCharacterMouth(ctx, args.viseme, { x: 0, y: 0 }, EXPLAINER_MOUTH_ANCHOR.x, EXPLAINER_MOUTH_ANCHOR.y,
    EXPLAINER_MOUTH_ANCHOR.headRadiusPx, EXPLAINER_MOUTH_ANCHOR.headRadiusPx, 0, 3 / EXPLAINER_SCALE);
  ctx.restore();
}
