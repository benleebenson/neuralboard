import type { CharacterSkin, HeadLocalPoint, Viseme } from "../stream";
import { BOARD_SURFACE_COLOR } from "../board-theme";
import { solveFixedLegChain, STREAM_CHARACTER_GEOMETRY } from "./geometry";
import { drawExplainerCharacter, type Expression } from "./explainer-renderer";
import { drawTrenchCoatRevealToCanvas } from "./trench-coat-reveal";

const CHAR_HIP_RAW = STREAM_CHARACTER_GEOMETRY.hipRaw;
const CHAR_TORSO_RAW = STREAM_CHARACTER_GEOMETRY.torsoRaw;
const CHAR_NECK_RAW = STREAM_CHARACTER_GEOMETRY.neckRaw;
const CHAR_HEAD_R_RAW = STREAM_CHARACTER_GEOMETRY.headRaw;
const CHAR_ARM_RAW = STREAM_CHARACTER_GEOMETRY.armRaw;
const CHAR_RELAX_ARM_A = 0.25;
const CHAR_RELAX_FORE_A = 0.18;
const PULLUP_BAR_WIDTH = 180;
const PULLUP_BAR_HEIGHT = 230;
const MIRROR_W = 90;
const MIRROR_H = 260;
const MIRROR_OFFSET = 140;
const LAUNCHER_ALWAYS_VISIBLE = true;
export const DEFAULT_MOUTH_ANCHOR: HeadLocalPoint = { x: 0, y: 0.35 };
export const MOUTH_PALETTE = {
  MOUTH_OUTLINE: "#2a2a2a",
  MOUTH_INTERIOR: "#d94a4a",
  MOUTH_TEETH: "#faf7f0",
  MOUTH_TONGUE: "#e88ba8",
} as const;
export const MOUTH_OUTLINE_WEIGHT_MULTIPLIER = 0.6;

type MouthDrawing = "none" | "line" | "narrow" | "openBean" | "fatCrescent" | "dot" | "teethBand" | "tongueOpen";

export const VISEME_MOUTH: Record<Viseme, {
  drawing: MouthDrawing;
  cx: number;
  cy: number;
  w: number;
  h: number;
  scale?: number;
  forward?: number;
}> = {
  rest: { drawing: "none", cx: 0, cy: 0, w: 0, h: 0 },
  closed: { drawing: "line", cx: 0, cy: 0, w: 0.5, h: 0.12 },
  slightOpen: { drawing: "narrow", cx: 0, cy: 0, w: 0.58, h: 0.24 },
  open: { drawing: "openBean", cx: 0, cy: 0, w: 0.66, h: 0.38, scale: 0.75 },
  wide: { drawing: "openBean", cx: 0, cy: 0, w: 0.66, h: 0.38 },
  round: { drawing: "fatCrescent", cx: 0, cy: 0, w: 0.66, h: 0.38, scale: 0.6 },
  pucker: { drawing: "dot", cx: 0, cy: 0, w: 0.24, h: 0.21, forward: 0.1 },
  teeth: { drawing: "teethBand", cx: 0, cy: 0, w: 0.62, h: 0.24 },
  tongue: { drawing: "tongueOpen", cx: 0, cy: 0, w: 0.66, h: 0.32 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function drawCharacterMouth(
  ctx: CanvasRenderingContext2D,
  viseme: Viseme,
  anchor: HeadLocalPoint | undefined,
  headCX: number,
  headCY: number,
  headRX: number,
  headRY: number,
  headTilt: number,
  limbStrokeWidth: number,
) {
  if (viseme === "rest") return;
  const spec = VISEME_MOUTH[viseme] ?? VISEME_MOUTH.rest;
  const base = anchor ?? DEFAULT_MOUTH_ANCHOR;
  const x = (base.x + spec.cx + (spec.forward ?? 0)) * headRX;
  const y = (base.y + spec.cy) * headRY;
  const scale = spec.scale ?? 1;
  const w = spec.w * headRX * scale;
  const h = spec.h * headRY * scale;
  const outlineWidth = Math.max(1, limbStrokeWidth * MOUTH_OUTLINE_WEIGHT_MULTIPLIER);
  const detailWidth = Math.max(0.75, outlineWidth * 0.32);

  const traceNarrow = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.51, y - h * 0.08);
    ctx.bezierCurveTo(x - w * 0.28, y - h * 0.36, x + w * 0.2, y - h * 0.34, x + w * 0.51, y - h * 0.04);
    ctx.bezierCurveTo(x + w * 0.43, y + h * 0.41, x + w * 0.08, y + h * 0.62, x - w * 0.2, y + h * 0.55);
    ctx.bezierCurveTo(x - w * 0.43, y + h * 0.5, x - w * 0.57, y + h * 0.2, x - w * 0.51, y - h * 0.08);
    ctx.closePath();
  };
  const traceOpenBean = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.53, y - h * 0.08);
    ctx.bezierCurveTo(x - w * 0.46, y - h * 0.4, x - w * 0.1, y - h * 0.54, x + w * 0.23, y - h * 0.43);
    ctx.bezierCurveTo(x + w * 0.5, y - h * 0.34, x + w * 0.56, y - h * 0.05, x + w * 0.47, y + h * 0.19);
    ctx.bezierCurveTo(x + w * 0.37, y + h * 0.49, x + w * 0.06, y + h * 0.62, x - w * 0.22, y + h * 0.49);
    ctx.bezierCurveTo(x - w * 0.49, y + h * 0.38, x - w * 0.61, y + h * 0.13, x - w * 0.53, y - h * 0.08);
    ctx.closePath();
  };
  const traceFatCrescent = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.48, y - h * 0.18);
    ctx.bezierCurveTo(x - w * 0.25, y - h * 0.48, x + w * 0.27, y - h * 0.39, x + w * 0.47, y - h * 0.04);
    ctx.bezierCurveTo(x + w * 0.58, y + h * 0.17, x + w * 0.37, y + h * 0.4, x + w * 0.12, y + h * 0.46);
    ctx.bezierCurveTo(x + w * 0.22, y + h * 0.25, x + w * 0.15, y + h * 0.07, x, y - h * 0.02);
    ctx.bezierCurveTo(x - w * 0.14, y - h * 0.12, x - w * 0.31, y - h * 0.08, x - w * 0.48, y - h * 0.18);
    ctx.closePath();
  };
  const traceDot = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.42, y - h * 0.08);
    ctx.bezierCurveTo(x - w * 0.4, y - h * 0.42, x - w * 0.06, y - h * 0.57, x + w * 0.25, y - h * 0.41);
    ctx.bezierCurveTo(x + w * 0.51, y - h * 0.28, x + w * 0.52, y + h * 0.11, x + w * 0.31, y + h * 0.37);
    ctx.bezierCurveTo(x + w * 0.1, y + h * 0.6, x - w * 0.26, y + h * 0.48, x - w * 0.41, y + h * 0.2);
    ctx.bezierCurveTo(x - w * 0.48, y + h * 0.1, x - w * 0.48, y, x - w * 0.42, y - h * 0.08);
    ctx.closePath();
  };
  const traceTeethBand = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.52, y - h * 0.2);
    ctx.bezierCurveTo(x - w * 0.27, y - h * 0.32, x + w * 0.21, y - h * 0.3, x + w * 0.52, y - h * 0.16);
    ctx.bezierCurveTo(x + w * 0.56, y + h * 0.05, x + w * 0.47, y + h * 0.24, x + w * 0.31, y + h * 0.33);
    ctx.bezierCurveTo(x + w * 0.05, y + h * 0.48, x - w * 0.28, y + h * 0.42, x - w * 0.47, y + h * 0.25);
    ctx.bezierCurveTo(x - w * 0.55, y + h * 0.12, x - w * 0.56, y - h * 0.05, x - w * 0.52, y - h * 0.2);
    ctx.closePath();
  };
  const traceTongueOpen = () => {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.52, y - h * 0.1);
    ctx.bezierCurveTo(x - w * 0.43, y - h * 0.43, x - w * 0.08, y - h * 0.54, x + w * 0.24, y - h * 0.42);
    ctx.bezierCurveTo(x + w * 0.49, y - h * 0.32, x + w * 0.55, y - h * 0.04, x + w * 0.46, y + h * 0.18);
    ctx.bezierCurveTo(x + w * 0.35, y + h * 0.48, x + w * 0.04, y + h * 0.59, x - w * 0.23, y + h * 0.46);
    ctx.bezierCurveTo(x - w * 0.48, y + h * 0.34, x - w * 0.6, y + h * 0.11, x - w * 0.52, y - h * 0.1);
    ctx.closePath();
  };
  const fillAndStroke = (trace: () => void, fill: string) => {
    trace();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.stroke();
  };

  ctx.save();
  ctx.translate(headCX, headCY);
  ctx.rotate(headTilt);
  ctx.strokeStyle = MOUTH_PALETTE.MOUTH_OUTLINE;
  ctx.lineWidth = outlineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (spec.drawing === "line") {
    ctx.beginPath();
    ctx.moveTo(x - w * 0.5, y - h * 0.06);
    ctx.bezierCurveTo(x - w * 0.2, y + h * 0.52, x + w * 0.19, y + h * 0.56, x + w * 0.5, y - h * 0.02);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (spec.drawing === "narrow") {
    fillAndStroke(traceNarrow, MOUTH_PALETTE.MOUTH_INTERIOR);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.4, y - h * 0.05);
    ctx.bezierCurveTo(x - w * 0.2, y - h * 0.24, x + w * 0.19, y - h * 0.23, x + w * 0.4, y - h * 0.03);
    ctx.bezierCurveTo(x + w * 0.32, y + h * 0.24, x + w * 0.06, y + h * 0.38, x - w * 0.18, y + h * 0.33);
    ctx.bezierCurveTo(x - w * 0.34, y + h * 0.29, x - w * 0.43, y + h * 0.12, x - w * 0.4, y - h * 0.05);
    ctx.closePath();
    ctx.fillStyle = MOUTH_PALETTE.MOUTH_TEETH;
    ctx.fill();
    traceNarrow();
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (spec.drawing === "openBean") {
    fillAndStroke(traceOpenBean, MOUTH_PALETTE.MOUTH_INTERIOR);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.4, y - h * 0.09);
    ctx.bezierCurveTo(x - w * 0.24, y - h * 0.29, x + w * 0.1, y - h * 0.36, x + w * 0.36, y - h * 0.24);
    ctx.bezierCurveTo(x + w * 0.33, y - h * 0.11, x + w * 0.21, y - h * 0.02, x + w * 0.05, y + h * 0.02);
    ctx.bezierCurveTo(x - w * 0.14, y + h * 0.07, x - w * 0.31, y + h * 0.02, x - w * 0.4, y - h * 0.09);
    ctx.closePath();
    ctx.fillStyle = MOUTH_PALETTE.MOUTH_TEETH;
    ctx.fill();
    ctx.strokeStyle = MOUTH_PALETTE.MOUTH_OUTLINE;
    ctx.lineWidth = detailWidth;
    ctx.stroke();
    ctx.lineWidth = outlineWidth;
    traceOpenBean();
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (spec.drawing === "fatCrescent") {
    fillAndStroke(traceFatCrescent, MOUTH_PALETTE.MOUTH_INTERIOR);
    ctx.restore();
    return;
  }

  if (spec.drawing === "dot") {
    fillAndStroke(traceDot, MOUTH_PALETTE.MOUTH_INTERIOR);
    ctx.restore();
    return;
  }

  if (spec.drawing === "teethBand") {
    fillAndStroke(traceTeethBand, MOUTH_PALETTE.MOUTH_TEETH);
    ctx.lineWidth = detailWidth;
    for (const tickX of [-0.22, 0.02, 0.25]) {
      ctx.beginPath();
      ctx.moveTo(x + w * tickX, y - h * 0.2);
      ctx.bezierCurveTo(x + w * (tickX - 0.01), y - h * 0.08, x + w * (tickX + 0.01), y + h * 0.04, x + w * tickX, y + h * 0.15);
      ctx.stroke();
    }
    ctx.lineWidth = outlineWidth;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.4, y + h * 0.48);
    ctx.bezierCurveTo(x - w * 0.16, y + h * 0.68, x + w * 0.18, y + h * 0.67, x + w * 0.39, y + h * 0.45);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (spec.drawing === "tongueOpen") {
    fillAndStroke(traceTongueOpen, MOUTH_PALETTE.MOUTH_INTERIOR);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.39, y - h * 0.1);
    ctx.bezierCurveTo(x - w * 0.22, y - h * 0.3, x + w * 0.11, y - h * 0.35, x + w * 0.35, y - h * 0.23);
    ctx.bezierCurveTo(x + w * 0.31, y - h * 0.1, x + w * 0.19, y - h * 0.02, x + w * 0.04, y + h * 0.01);
    ctx.bezierCurveTo(x - w * 0.13, y + h * 0.05, x - w * 0.3, y + h * 0.01, x - w * 0.39, y - h * 0.1);
    ctx.closePath();
    ctx.fillStyle = MOUTH_PALETTE.MOUTH_TEETH;
    ctx.fill();
    ctx.strokeStyle = MOUTH_PALETTE.MOUTH_OUTLINE;
    ctx.lineWidth = detailWidth;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - w * 0.34, y + h * 0.12);
    ctx.bezierCurveTo(x - w * 0.18, y + h * 0.02, x + w * 0.16, y + h * 0.03, x + w * 0.35, y + h * 0.16);
    ctx.bezierCurveTo(x + w * 0.3, y + h * 0.38, x + w * 0.05, y + h * 0.49, x - w * 0.2, y + h * 0.4);
    ctx.bezierCurveTo(x - w * 0.31, y + h * 0.36, x - w * 0.36, y + h * 0.24, x - w * 0.34, y + h * 0.12);
    ctx.closePath();
    ctx.fillStyle = MOUTH_PALETTE.MOUTH_TONGUE;
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = outlineWidth;
    traceTongueOpen();
    ctx.stroke();
  }
  ctx.restore();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type BoardResolvedCharAction = Record<string, any>;
export type BoardCharSurfaceClip = Record<string, any>;
export type BoardCharPoseResult = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type BoardCharacterDrawEvaluators = {
  evalCharAtTime: (time: number, resolved: BoardResolvedCharAction[], initX: number, initY: number, clips: BoardCharSurfaceClip[], authoredAnimations: Record<string, unknown>, hasFace: boolean, faceAspect: number) => BoardCharPoseResult;
  physiqueAt: (time: number, actions: BoardResolvedCharAction[]) => "slim" | "jacked";
};

export type CharacterDebugEffect = {
  type: "impactStars" | "motionLines" | "dustPuff" | "screenShake";
  x: number;
  y: number;
  alpha: number;
  intensity?: number;
};

export function drawCharacterSequenceEffectsToCanvas(
  ctx: CanvasRenderingContext2D,
  effects: readonly CharacterDebugEffect[],
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number,
) {
  for (const effect of effects) {
    if (effect.type === "screenShake" || effect.alpha <= 0.001) continue;
    const x = (effect.x - cam.cameraX) * sf + W / 2;
    const y = (effect.y - cam.cameraY) * sf + H / 2;
    const strength = (effect.intensity ?? 1) * effect.alpha;
    ctx.save();
    ctx.globalAlpha *= clamp(effect.alpha, 0, 1);
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = "#ffd34e";
    ctx.lineWidth = Math.max(1.5, 2.4 * sf);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (effect.type === "impactStars") {
      for (let i = 0; i < 5; i++) {
        const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        const cx = x + Math.cos(angle) * 30 * sf * strength;
        const cy = y + Math.sin(angle) * 24 * sf * strength;
        const outer = 9 * sf * strength;
        const inner = outer * 0.42;
        ctx.beginPath();
        for (let point = 0; point < 10; point++) {
          const a = -Math.PI / 2 + point * Math.PI / 5;
          const radius = point % 2 === 0 ? outer : inner;
          const px = cx + Math.cos(a) * radius;
          const py = cy + Math.sin(a) * radius;
          if (point === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    } else if (effect.type === "motionLines") {
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(x - 38 * sf * strength, y + i * 13 * sf);
        ctx.quadraticCurveTo(x - 10 * sf, y + i * 10 * sf, x + 18 * sf * strength, y + i * 5 * sf);
        ctx.stroke();
      }
    } else if (effect.type === "dustPuff") {
      ctx.fillStyle = BOARD_SURFACE_COLOR;
      for (const [dx, dy, radius] of [[-22, -3, 13], [-8, -12, 17], [11, -9, 15], [25, -1, 11]] as const) {
        ctx.beginPath();
        ctx.arc(x + dx * sf * strength, y + dy * sf, radius * sf * strength, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

export function drawCharacterSkeletonOverlayToCanvas(
  ctx: CanvasRenderingContext2D,
  pose: BoardCharPoseResult,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number,
) {
  const S = sf;
  const leg = STREAM_CHARACTER_GEOMETRY.legRaw * S;
  const arm = STREAM_CHARACTER_GEOMETRY.armRaw * S;
  const torso = CHAR_TORSO_RAW * S;
  const neck = CHAR_NECK_RAW * S;
  const head = CHAR_HEAD_R_RAW * S;
  const hipY = -CHAR_HIP_RAW * S + (pose.headBob ?? 0) * S * 0.25;
  type Point = { x: number; y: number };
  const rotateAround = (point: Point, origin: Point, angle: number): Point => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
  };
  const hip = { x: 0, y: hipY };
  const legChain = (thighA: number, shinA: number) => {
    const knee = { x: -Math.sin(thighA) * leg, y: hipY + Math.cos(thighA) * leg };
    return { knee, foot: { x: knee.x - Math.sin(shinA) * leg, y: knee.y + Math.cos(shinA) * leg } };
  };
  const leftLeg = legChain(pose.leftLegA, pose.leftShinA ?? pose.leftLegA + pose.leftForeA * 0.5);
  const rightLeg = legChain(pose.rightLegA, pose.rightShinA ?? pose.rightLegA + pose.rightForeA * 0.5);
  const shoulderCenter = rotateAround({ x: 0, y: hipY - torso * 0.85 }, hip, pose.bodyLean ?? 0);
  const torsoTop = rotateAround({ x: 0, y: hipY - torso }, hip, pose.bodyLean ?? 0);
  const headTilt = pose.headTilt ?? 0;
  const neckTop = rotateAround({ x: -Math.sin(headTilt) * neck, y: hipY - torso - Math.cos(headTilt) * neck }, hip, pose.bodyLean ?? 0);
  const headCenter = rotateAround({ x: -Math.sin(headTilt) * (neck + head * 0.35), y: hipY - torso - Math.cos(headTilt) * (neck + head) }, hip, pose.bodyLean ?? 0);
  const armChain = (upperA: number, foreA: number) => {
    const rawElbow = { x: -Math.sin(upperA) * arm, y: hipY - torso * 0.85 + Math.cos(upperA) * arm };
    const rawHand = { x: rawElbow.x - Math.sin(foreA) * arm, y: rawElbow.y + Math.cos(foreA) * arm };
    return { elbow: rotateAround(rawElbow, hip, pose.bodyLean ?? 0), hand: rotateAround(rawHand, hip, pose.bodyLean ?? 0) };
  };
  const leftArm = armChain(pose.leftArmA, pose.leftForeA);
  const rightArm = armChain(pose.rightArmA, pose.rightForeA);
  let points = {
    hip, shoulderCenter, torsoTop, neckTop, headCenter,
    leftKnee: leftLeg.knee, leftFoot: leftLeg.foot,
    rightKnee: rightLeg.knee, rightFoot: rightLeg.foot,
    leftElbow: leftArm.elbow, leftHand: leftArm.hand,
    rightElbow: rightArm.elbow, rightHand: rightArm.hand,
  };
  if (pose.spinAngle) {
    const center = { x: 0, y: hipY - torso / 2 };
    points = Object.fromEntries(Object.entries(points).map(([key, value]) => [key, rotateAround(value, center, pose.spinAngle)])) as typeof points;
  }
  const rootX = (pose.boardX - cam.cameraX) * sf + W / 2 + (pose.sequenceShakeX ?? 0) * sf;
  const rootY = (pose.boardY - cam.cameraY) * sf + H / 2 + (pose.airY ?? 0) * sf + (pose.sequenceShakeY ?? 0) * sf;
  const screen = (point: Point) => ({
    x: rootX + point.x * pose.facing * (pose.momentumScaleX ?? 1),
    y: rootY + point.y * (pose.momentumScaleY ?? 1),
  });
  // Explicit chains keep left/right limbs readable despite the renderer sharing a shoulder origin.
  const chains: Array<[Point, Point, Point]> = [
    [points.hip, points.leftKnee, points.leftFoot], [points.hip, points.rightKnee, points.rightFoot],
    [points.shoulderCenter, points.leftElbow, points.leftHand], [points.shoulderCenter, points.rightElbow, points.rightHand],
  ];
  ctx.save();
  ctx.strokeStyle = "rgba(31, 111, 235, 0.9)";
  ctx.fillStyle = "#ff4d7a";
  ctx.lineWidth = Math.max(1, 1.25 * sf);
  for (const chain of chains) {
    ctx.beginPath();
    chain.map(screen).forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.stroke();
  }
  for (const [a, b] of [[points.hip, points.shoulderCenter], [points.shoulderCenter, points.torsoTop], [points.torsoTop, points.neckTop], [points.neckTop, points.headCenter]] as Array<[Point, Point]>) {
    const from = screen(a); const to = screen(b);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }
  const dots = [points.hip, points.shoulderCenter, points.torsoTop, points.neckTop, points.headCenter, points.leftKnee, points.leftFoot, points.rightKnee, points.rightFoot, points.leftElbow, points.leftHand, points.rightElbow, points.rightHand];
  for (const dot of dots) {
    const point = screen(dot);
    ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(2.5, 3.4 * sf), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

export function drawBoardCharacterToCanvas(
  ctx: CanvasRenderingContext2D,
  time: number,
  resolved: BoardResolvedCharAction[],
  showChar: boolean,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number,
  initX: number,
  initY: number,
  clips: BoardCharSurfaceClip[],
  entranceTime: number,
  authoredAnimations: Record<string, unknown> = {},
  characterFace: { image: HTMLImageElement | null; aspect: number; mouthAnchor?: HeadLocalPoint } | null = null,
  characterSkin: CharacterSkin = "stick",
  characterType: "stickFigure" | "explainer" = "stickFigure",
  expression: Expression = "neutral",
  poseOverride: BoardCharPoseResult | null = null,
  evaluators: BoardCharacterDrawEvaluators
) {
  if (!showChar || time < entranceTime) return;
  const hasFace = !!characterFace?.image;
  const faceAspect = clamp(characterFace?.aspect ?? 1, 0.75, 1.6);
  const p = poseOverride ?? evaluators.evalCharAtTime(time, resolved, initX, initY, clips, authoredAnimations, hasFace, faceAspect);
  const { facing } = p;
  const physique = evaluators.physiqueAt(time, resolved);
  const isJacked = physique === "jacked";
  const effectiveSkin: CharacterSkin = isJacked ? "stick" : characterSkin;

  const sx = (p.boardX - cam.cameraX) * sf + W / 2 + (p.sequenceShakeX ?? 0) * sf;
  const sy = (p.boardY - cam.cameraY) * sf + H / 2 + (p.sequenceShakeY ?? 0) * sf;
  if (Array.isArray(p.sequenceEffects)) {
    drawCharacterSequenceEffectsToCanvas(ctx, p.sequenceEffects, cam, sf, W, H);
  }
  if (p.sequenceRenderer === "trenchCoatReveal") {
    drawTrenchCoatRevealToCanvas(ctx, {
      x: sx,
      groundY: sy,
      progress: p.sequenceProgress ?? 0,
      revealImage: p.sequenceRevealImage ?? null,
      // The coat study is intentionally a touch larger than the standard rig so an inserted
      // reveal stays readable at ordinary generated-camera framing.
      scale: sf * 1.16,
    });
    return;
  }
  if (characterType === "explainer") {
    drawExplainerCharacter(ctx, {
      screenX: sx, screenY: sy, scale: sf, facing,
      gesture: p.actionType === "pointAt" ? "pointUp" : (p.spriteGesture ?? "neutral"),
      expression,
      viseme: p.viseme ?? "rest",
    });
    return;
  }
  const S = sf;
  const lw = Math.max(1, 3 * S);
  const jackedPulse = isJacked ? 1 + (p.physiquePulse ?? 0) * 0.16 : 1;
  const standingish = !p.skateboardVisible && !p.grappleRopeAlpha && !p.pullUpBarAlpha && !p.mirrorAlpha && !p.spinAngle;
  const jackedRestPose = isJacked && standingish && Math.abs(p.airY) < 0.001;

  // Raw (unscaled) body proportions — single source of truth reused below for both the S-scaled
  // draw geometry and the raw board-space magic numbers (grapple hand height, pointAt shoulder
  // height) that need to stay in sync with them.
  const legLen = STREAM_CHARACTER_GEOMETRY.legRaw * S;
  const torsoLen = CHAR_TORSO_RAW * S;
  const neckLen = CHAR_NECK_RAW * S * (isJacked ? 0.72 : 1);
  const armLen = CHAR_ARM_RAW * S;
  const headR = CHAR_HEAD_R_RAW * S * (hasFace ? 1.15 : 1);
  const headRX = hasFace ? headR / Math.sqrt(faceAspect) : headR;
  const headRY = hasFace ? headR * Math.sqrt(faceAspect) : headR;
  const bobS = p.headBob * S;
  const headTilt = p.headTilt ?? 0;
  const hipY = (-CHAR_HIP_RAW + (p.skateboardVisible ? (p.skateCrouch ?? 6) : 0)) * S + bobS * 0.25;
  const getForearmMount = (
    preferFiring: boolean,
    armAngles?: { leftArm: number; leftFore: number; rightArm: number; rightFore: number },
  ): { x: number; y: number; angle: number; localX: number; localY: number; w: number; h: number } => {
    const shoulderY = -torsoLen * 0.85;
    const useRight = preferFiring ? facing >= 0 : facing < 0;
    const sOff = 0;
    const armA = useRight ? (armAngles?.rightArm ?? p.rightArmA) : (armAngles?.leftArm ?? p.leftArmA);
    const foreA = useRight ? (armAngles?.rightFore ?? p.rightForeA) : (armAngles?.leftFore ?? p.leftForeA);
    const shoulderLocalX = sOff;
    const shoulderLocalY = hipY + shoulderY;
    const elbowLocalX = shoulderLocalX - Math.sin(armA) * armLen;
    const elbowLocalY = shoulderLocalY + Math.cos(armA) * armLen;
    const wristLocalX = elbowLocalX - Math.sin(foreA) * armLen;
    const wristLocalY = elbowLocalY + Math.cos(foreA) * armLen;
    const forearmX = wristLocalX - elbowLocalX;
    const forearmY = wristLocalY - elbowLocalY;
    const forearmLen = Math.max(0.001, Math.hypot(forearmX, forearmY));
    const forearmUX = forearmX / forearmLen;
    const forearmUY = forearmY / forearmLen;
    const perpX = -forearmUY;
    const perpY = forearmUX;
    const surfaceSign = useRight ? 1 : -1;
    const muscleL = Math.max(torsoLen, headR * 6) * jackedPulse;
    const launcherW = (isJacked ? 20 : 14) * S;
    const launcherH = (isJacked ? 11 : 8) * S;
    const surfaceOffset = isJacked ? 0.05 * muscleL + 2 * S : 4 * S;
    const mountLocalX = wristLocalX - forearmUX * 10 * S + perpX * surfaceSign * surfaceOffset;
    const mountLocalY = wristLocalY - forearmUY * 10 * S + perpY * surfaceSign * surfaceOffset;
    const tipLocalX = mountLocalX + forearmUX * (launcherW / 2);
    const tipLocalY = mountLocalY + forearmUY * (launcherW / 2);
    const relX = tipLocalX;
    const relY = tipLocalY - hipY;
    const leanCos = Math.cos(p.bodyLean);
    const leanSin = Math.sin(p.bodyLean);
    const leanedX = relX * leanCos - relY * leanSin;
    const leanedY = relX * leanSin + relY * leanCos;
    const angle = Math.atan2(forearmUY, forearmUX);
    return {
      x: sx + leanedX * facing,
      y: sy + p.airY * S + hipY + leanedY,
      angle,
      localX: mountLocalX,
      localY: mountLocalY,
      w: launcherW,
      h: launcherH,
    };
  };
  const launcherMount = getForearmMount(true);

  // ── Grapple / zipline rope (drawn before character transform so coords are screen-space) ──
  if (p.grappleAnchorBX !== undefined && p.grappleRopeAlpha && p.grappleRopeAlpha > 0) {
    const anchorSX = (p.grappleAnchorBX - cam.cameraX) * sf + W / 2;
    const anchorSY = (p.grappleAnchorBY! - cam.cameraY) * sf + H / 2;
    const endT = p.grappleHookT === undefined || p.grappleTaut ? 1 : clamp(p.grappleHookT, 0, 1);
    const endSX = lerp(launcherMount.x, anchorSX, endT);
    const endSY = lerp(launcherMount.y, anchorSY, endT);
    const sag = p.grappleTaut ? 0 : Math.sin(Math.PI * endT) * 12 * S;
    const ctrlSX = (launcherMount.x + endSX) / 2;
    const ctrlSY = (launcherMount.y + endSY) / 2 + sag;
    ctx.save();
    ctx.globalAlpha = p.grappleRopeAlpha;
    ctx.strokeStyle = "#5a3a1a";
    ctx.lineWidth = Math.max(1, 1.8 * S);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(launcherMount.x, launcherMount.y);
    ctx.quadraticCurveTo(ctrlSX, ctrlSY, endSX, endSY);
    ctx.stroke();
    // Hook / anchor claw
    ctx.fillStyle = "#5a3a1a";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 1.3 * S);
    ctx.beginPath();
    ctx.moveTo(endSX, endSY);
    ctx.lineTo(endSX - 7 * S, endSY + 5 * S);
    ctx.moveTo(endSX, endSY);
    ctx.lineTo(endSX + 7 * S, endSY + 5 * S);
    ctx.moveTo(endSX, endSY);
    ctx.lineTo(endSX, endSY - 8 * S);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(anchorSX, anchorSY, 3 * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (p.pullUpBarAlpha && p.pullUpBarAlpha > 0) {
    const baseX = (((p.pullUpBarBX ?? p.boardX) - cam.cameraX) * sf + W / 2);
    const baseY = (((p.pullUpBarBY ?? p.boardY) - cam.cameraY) * sf + H / 2);
    const postHalf = (PULLUP_BAR_WIDTH / 2) * S;
    const topY = baseY - PULLUP_BAR_HEIGHT * S;
    ctx.save();
    ctx.globalAlpha = p.pullUpBarAlpha;
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = BOARD_SURFACE_COLOR;
    ctx.lineWidth = Math.max(1, 2.2 * S);
    ctx.lineCap = "round";
    for (const x of [baseX - postHalf, baseX + postHalf]) {
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, topY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 22 * S, baseY);
      ctx.lineTo(x + 22 * S, baseY);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(baseX - postHalf, topY);
    ctx.lineTo(baseX + postHalf, topY);
    ctx.stroke();
    ctx.restore();
  }

  if (p.mirrorAlpha && p.mirrorAlpha > 0) {
    const mirrorFacing = p.mirrorFacing ?? facing;
    const mirrorBaseBX = p.mirrorBX ?? (p.boardX + mirrorFacing * MIRROR_OFFSET);
    const mirrorBaseSX = (mirrorBaseBX - cam.cameraX) * sf + W / 2;
    const mirrorBaseSY = ((p.mirrorBY ?? p.boardY) - cam.cameraY) * sf + H / 2;
    const mw = MIRROR_W * S;
    const mh = MIRROR_H * S;
    const mx = mirrorBaseSX - mw / 2;
    const my = mirrorBaseSY - mh;
    ctx.save();
    ctx.globalAlpha = p.mirrorAlpha;
    ctx.translate(mirrorBaseSX, mirrorBaseSY);
    ctx.rotate(-0.08 * mirrorFacing);
    ctx.translate(-mirrorBaseSX, -mirrorBaseSY);
    ctx.fillStyle = "#eaf2f4";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 2 * S);
    ctx.beginPath();
    ctx.roundRect(mx, my, mw, mh, 12 * S);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(mx + 6 * S, my + 8 * S, mw - 12 * S, mh - 18 * S, 8 * S);
    ctx.clip();
    ctx.globalAlpha *= 0.42;
    const rx = mirrorBaseSX;
    const ry = mirrorBaseSY - 54 * S;
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = isJacked ? "#e6ddcf" : "transparent";
    ctx.lineWidth = Math.max(1, 1.5 * S);
    ctx.save();
    ctx.translate(rx, ry);
    ctx.scale(-0.85 * mirrorFacing, 0.85);
    ctx.beginPath();
    ctx.arc(0, -118 * S, 15 * S, 0, Math.PI * 2);
    ctx.stroke();
    if (isJacked) {
      ctx.beginPath();
      ctx.moveTo(-24 * S, -95 * S);
      ctx.quadraticCurveTo(-19 * S, -62 * S, -10 * S, -35 * S);
      ctx.lineTo(10 * S, -35 * S);
      ctx.quadraticCurveTo(19 * S, -62 * S, 24 * S, -95 * S);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -100 * S);
      ctx.lineTo(0, -35 * S);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = Math.max(1, 1.2 * S);
    for (const off of [-12, 10, 29]) {
      ctx.beginPath();
      ctx.moveTo(mx + 22 * S, my + (45 + off) * S);
      ctx.lineTo(mx + 58 * S, my + (20 + off) * S);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(mirrorBaseSX, mirrorBaseSY);
    ctx.lineTo(mirrorBaseSX - mirrorFacing * 34 * S, mirrorBaseSY + 36 * S);
    ctx.strokeStyle = "#2a2a2a";
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.translate(sx, sy + p.airY * S);
  ctx.scale(facing * (p.momentumScaleX ?? 1), p.momentumScaleY ?? 1);
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Whole-body spin (flip only): rotates legs + torso group together around the torso midpoint,
  // so a flip reads as the whole character turning over rather than the cartwheel-smear you get
  // rotating just the upper body around the hip. No-op for every other pose (spinAngle undefined).
  if (p.spinAngle) {
    const spinCenterY = hipY - torsoLen / 2;
    ctx.translate(0, spinCenterY);
    ctx.rotate(p.spinAngle);
    ctx.translate(0, -spinCenterY);
  }

  // Legs (two-segment: thigh + shin with independent shin angle). Local-x sign is negated so that
  // a POSITIVE angle always means "outward from body midline" for both legs — the un-negated form
  // (x = +sin(angle)) makes positive-left/negative-right cross at the ankles instead of spreading.
  type LocalPoint = { x: number; y: number };
  const angledLeg = (thighA: number, shinA: number): { knee: LocalPoint; foot: LocalPoint } => {
    const kx = -Math.sin(thighA) * legLen;
    const ky = hipY + Math.cos(thighA) * legLen;
    return {
      knee: { x: kx, y: ky },
      foot: { x: kx - Math.sin(shinA) * legLen, y: ky + Math.cos(shinA) * legLen },
    };
  };
  const plantedLeg = (side: -1 | 1, footX: number, footY: number): { knee: LocalPoint; foot: LocalPoint } => {
    return solveFixedLegChain({x:0,y:hipY},{x:footX,y:footY},side,legLen);
  };
  const drawLegChain = (leg: { knee: LocalPoint; foot: LocalPoint }) => {
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(leg.knee.x, leg.knee.y);
    ctx.lineTo(leg.foot.x, leg.foot.y);
    ctx.stroke();
  };
  const deckTopY = 0;
  const leftDeckFootX = -18 * S;
  const rightDeckFootX = 18 * S;
  const effectiveLeftLegA = jackedRestPose ? Math.max(p.leftLegA, 0.18) : p.leftLegA;
  const effectiveRightLegA = jackedRestPose ? Math.min(p.rightLegA, -0.18) : p.rightLegA;
  let leftLeg = angledLeg(effectiveLeftLegA, p.leftShinA ?? (effectiveLeftLegA + p.leftForeA * 0.5));
  let rightLeg = angledLeg(effectiveRightLegA, p.rightShinA ?? (effectiveRightLegA + p.rightForeA * 0.5));
  if(p.terrainGrounded===true&&!p.skateboardVisible&&(Number.isFinite(p.terrainLeftFootY)||Number.isFinite(p.terrainRightFootY))){leftLeg=plantedLeg(-1,-14*S,(p.terrainLeftFootY??0)*S);rightLeg=plantedLeg(1,14*S,(p.terrainRightFootY??0)*S);}
  if (p.skateboardVisible) {
    if (p.skateFootMode === "left-push") {
      rightLeg = plantedLeg(1, rightDeckFootX, deckTopY);
    } else {
      leftLeg = plantedLeg(-1, leftDeckFootX, deckTopY);
      rightLeg = plantedLeg(1, rightDeckFootX, deckTopY);
    }
  }
  if (p.danceFootPlant) {
    const hipOffset = p.danceHipOffset ?? 0;
    leftLeg = plantedLeg(-1, (-28 - hipOffset) * S, 0);
    rightLeg = plantedLeg(1, (28 - hipOffset) * S, 0);
  }
  if (p.sitSeated) {
    const foldY = hipY + 12 * S;
    leftLeg = plantedLeg(-1, 44 * S, foldY);
    rightLeg = plantedLeg(1, 10 * S, foldY + 2 * S);
  }
  if(process.env.NODE_ENV!=="production")for(const [side,leg] of [["left",leftLeg],["right",rightLeg]] as const){const thigh=Math.hypot(leg.knee.x,leg.knee.y-hipY),shin=Math.hypot(leg.foot.x-leg.knee.x,leg.foot.y-leg.knee.y);if(Math.abs(thigh-legLen)>1||Math.abs(shin-legLen)>1)console.error("[character:bone-length-violation]",{side,expected:legLen,thigh,shin,action:p.actionType??"unknown"});}
  drawLegChain(leftLeg);
  drawLegChain(rightLeg);
  if (p.danceMotionAlpha && p.danceMotionAlpha > 0) {
    const side = (p.danceHipOffset ?? 0) >= 0 ? -1 : 1;
    ctx.save();
    ctx.globalAlpha = p.danceMotionAlpha;
    ctx.strokeStyle = "rgba(42,42,42,0.55)";
    ctx.lineWidth = Math.max(1, 1.2 * S);
    for (const [dx, dy, len] of [[18, -2, 13], [24, 8, 16], [16, 18, 11]] as const) {
      ctx.beginPath();
      ctx.moveTo(side * dx * S, hipY + dy * S);
      ctx.quadraticCurveTo(side * (dx + 8) * S, hipY + (dy - 4) * S, side * (dx + len) * S, hipY + (dy + 2) * S);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (p.chokeMotionAlpha && p.chokeMotionAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = p.chokeMotionAlpha;
    ctx.strokeStyle = "rgba(42,42,42,0.58)";
    ctx.lineWidth = Math.max(1, 1.2 * S);
    ctx.lineCap = "round";
    for (const foot of [leftLeg.foot, rightLeg.foot]) {
      for (const [dx, dy, len] of [[-18, -6, 12], [16, 4, 10]] as const) {
        ctx.beginPath();
        ctx.moveTo(foot.x + dx * S, foot.y + dy * S);
        ctx.quadraticCurveTo(foot.x + (dx * 0.75) * S, foot.y + (dy - 8) * S, foot.x + (dx + Math.sign(dx) * len) * S, foot.y + (dy - 2) * S);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  if (p.sitSeated) {
    const footStroke = 11 * S;
    for (const foot of [leftLeg.foot, rightLeg.foot]) {
      ctx.beginPath();
      ctx.moveTo(foot.x - 2 * S, foot.y);
      ctx.lineTo(foot.x + footStroke, foot.y);
      ctx.stroke();
    }
  }

  if (p.skateboardVisible) {
    const deckCX = 0;
    const deckCY = deckTopY;
    const deckW = 70 * S;
    const deckH = 8 * S;
    const upturn = 5 * S;
    ctx.save();
    ctx.translate(deckCX, deckCY);
    ctx.rotate(p.skateboardTilt ?? 0);
    ctx.fillStyle = BOARD_SURFACE_COLOR;
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 2 * S);
    ctx.beginPath();
    ctx.moveTo(-deckW / 2, 0);
    ctx.quadraticCurveTo(-deckW / 2 + 8 * S, -upturn, -deckW / 2 + 16 * S, 0);
    ctx.lineTo(deckW / 2 - 16 * S, 0);
    ctx.quadraticCurveTo(deckW / 2 - 8 * S, -upturn, deckW / 2, 0);
    ctx.lineTo(deckW / 2 - 5 * S, deckH);
    ctx.lineTo(-deckW / 2 + 5 * S, deckH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#2a2a2a";
    [-22 * S, 22 * S].forEach((wx) => {
      ctx.beginPath();
      ctx.arc(wx, deckH + 5 * S, 4 * S, 0, Math.PI * 2);
      ctx.fill();
    });
    if (p.skateSparkAlpha && p.skateSparkAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = p.skateSparkAlpha;
      ctx.strokeStyle = "#ffbf2f";
      ctx.lineWidth = Math.max(1, 1.6 * S);
      for (const [dx, dy] of [[-42, 8], [-48, 1], [-38, 16]] as const) {
        ctx.beginPath();
        ctx.moveTo(-deckW / 2 - 2 * S, deckH + 4 * S);
        ctx.lineTo(-deckW / 2 + dx * S * 0.32, deckH + dy * S * 0.65);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (p.skateMotionAlpha && p.skateMotionAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = p.skateMotionAlpha;
      ctx.strokeStyle = "rgba(42,42,42,0.45)";
      ctx.lineWidth = Math.max(1, 1.2 * S);
      for (const y of [-14, 16]) {
        ctx.beginPath();
        ctx.moveTo(-28 * S, y * S);
        ctx.lineTo(-48 * S, (y + 4) * S);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // Torso + neck + head all rotate together with bodyLean (e.g. the flip's full-rotation spin)
  ctx.save();
  ctx.translate(0, hipY);
  ctx.rotate(p.bodyLean);

  const torsoTopY = -torsoLen;
  const shoulderY = -torsoLen * 0.85;
  let lArmA = p.leftArmA, rArmA = p.rightArmA;
  let lForeA = p.leftForeA, rForeA = p.rightForeA;

  // Override pointing arm; other arm hangs relaxed (not tucked inward)
  if (p.pointTargetBX !== undefined && p.pointTargetBY !== undefined) {
    const shoulderBY = p.boardY - (CHAR_HIP_RAW - (p.skateCrouch ?? 0) + CHAR_TORSO_RAW * 0.85);
    const tdxLocal = (p.pointTargetBX - p.boardX) * facing;
    const tdyCanvas = p.pointTargetBY - shoulderBY;
    const mag = Math.hypot(tdxLocal, tdyCanvas);
    if (mag > 0) {
      // Negated to match drawArm's negated sin() below (same outward-positive convention as legs)
      const pointAngle = -Math.atan2(tdxLocal, tdyCanvas);
      if (tdxLocal >= 0) {
        rArmA = pointAngle; rForeA = pointAngle;
        lArmA = CHAR_RELAX_ARM_A;  lForeA = CHAR_RELAX_FORE_A;
      } else {
        lArmA = pointAngle; lForeA = pointAngle;
        rArmA = -CHAR_RELAX_ARM_A;  rForeA = -CHAR_RELAX_FORE_A;
      }
    }
  }
  if (jackedRestPose && p.pointTargetBX === undefined) {
    lArmA = Math.max(lArmA, 0.35);
    rArmA = Math.min(rArmA, -0.35);
  }
  const jackedTorsoClearance = 0.28;
  if (isJacked) {
    if (lArmA > 0 && lArmA < jackedTorsoClearance) lArmA = jackedTorsoClearance;
    if (rArmA < 0 && rArmA > -jackedTorsoClearance) rArmA = -jackedTorsoClearance;
  }

  const drawArm = (armA: number, foreA: number) => {
    const sOff = 0;
    const ex = sOff - Math.sin(armA) * armLen;
    const ey = shoulderY + Math.cos(armA) * armLen;
    const hx = ex - Math.sin(foreA) * armLen;
    const hy = ey + Math.cos(foreA) * armLen;
    ctx.beginPath();
    ctx.moveTo(sOff, shoulderY);
    ctx.lineTo(ex, ey);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  };
  const handPointForArm = (armA: number, foreA: number): LocalPoint => {
    const ex = -Math.sin(armA) * armLen;
    const ey = shoulderY + Math.cos(armA) * armLen;
    return {
      x: ex - Math.sin(foreA) * armLen,
      y: ey + Math.cos(foreA) * armLen,
    };
  };
  const drawOpenHand = (armA: number, foreA: number) => {
    const hand = handPointForArm(armA, foreA);
    const angle = Math.atan2(-Math.sin(foreA), Math.cos(foreA)) - Math.PI / 2;
    ctx.save();
    ctx.translate(hand.x, hand.y);
    ctx.rotate(angle);
    ctx.lineWidth = Math.max(1, 1.2 * S);
    for (const spread of [-0.38, 0, 0.38]) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(spread) * 11 * S, Math.sin(spread) * 11 * S);
      ctx.stroke();
    }
    ctx.restore();
  };

  const addP = (a: LocalPoint, b: LocalPoint): LocalPoint => ({ x: a.x + b.x, y: a.y + b.y });
  const subP = (a: LocalPoint, b: LocalPoint): LocalPoint => ({ x: a.x - b.x, y: a.y - b.y });
  const mulP = (a: LocalPoint, n: number): LocalPoint => ({ x: a.x * n, y: a.y * n });
  const armVector = (angle: number, len: number): LocalPoint => ({ x: -Math.sin(angle) * len, y: Math.cos(angle) * len });
  const normalOf = (start: LocalPoint, end: LocalPoint): LocalPoint => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.max(0.001, Math.hypot(dx, dy));
    return { x: -dy / len, y: dx / len };
  };
  const unitP = (pnt: LocalPoint): LocalPoint => {
    const len = Math.max(0.001, Math.hypot(pnt.x, pnt.y));
    return { x: pnt.x / len, y: pnt.y / len };
  };
  const dotP = (a: LocalPoint, b: LocalPoint) => a.x * b.x + a.y * b.y;
  const buildJackedJoints = () => {
    const hipP: LocalPoint = { x: 0, y: 0 };
    const neckP: LocalPoint = { x: 0, y: torsoTopY };
    const axis = subP(neckP, hipP);
    const axisLen = Math.max(0.001, Math.hypot(axis.x, axis.y));
    const axisUnit = { x: axis.x / axisLen, y: axis.y / axisLen };
    const U = { x: -axisUnit.y, y: axisUnit.x };
    const L = Math.max(axisLen, headR * 6) * jackedPulse;
    const at = (t: number) => addP(hipP, mulP(axis, t));
    const shoulderCenter = at(0.88);
    const shoulderL = addP(shoulderCenter, mulP(U, -0.28 * L));
    const shoulderR = addP(shoulderCenter, mulP(U, 0.28 * L));
    const elbowL = addP(shoulderL, armVector(lArmA, armLen));
    const handL = addP(elbowL, armVector(lForeA, armLen));
    const elbowR = addP(shoulderR, armVector(rArmA, armLen));
    const handR = addP(elbowR, armVector(rForeA, armLen));
    return { hipP, neckP, axis, axisUnit, U, L, at, shoulderL, shoulderR, elbowL, elbowR, handL, handR };
  };
  const drawJackedArmWorld = (side: "left" | "right", joints: ReturnType<typeof buildJackedJoints>) => {
    const shoulder = side === "left" ? joints.shoulderL : joints.shoulderR;
    const elbow = side === "left" ? joints.elbowL : joints.elbowR;
    const hand = side === "left" ? joints.handL : joints.handR;
    const armA = side === "left" ? lArmA : rArmA;
    const foreA = side === "left" ? lForeA : rForeA;
    const away = unitP(subP(shoulder, joints.at(0.82)));
    const upperN0 = normalOf(shoulder, elbow);
    const foreN0 = normalOf(elbow, hand);
    const upperN = dotP(upperN0, away) >= 0 ? upperN0 : mulP(upperN0, -1);
    const foreN = dotP(foreN0, away) >= 0 ? foreN0 : mulP(foreN0, -1);
    const shoulderW = 0.2 * joints.L;
    const elbowW = 0.13 * joints.L;
    const wristW = 0.05 * joints.L;
    const bend = Math.abs(foreA - armA);
    const peak = bend > 0.7 ? clamp((bend - 0.7) / 1.0, 0, 1) * 0.04 * joints.L : 0;
    const elbowNotch = 0.025 * joints.L;
    const shoulderOuter = addP(shoulder, mulP(upperN, shoulderW / 2));
    const elbowOuter = addP(elbow, mulP(upperN, elbowW / 2 - elbowNotch));
    const wristOuter = addP(hand, mulP(foreN, wristW / 2));
    const wristInner = addP(hand, mulP(foreN, -wristW / 2));
    const elbowInner = addP(elbow, mulP(upperN, -elbowW * 0.43 - elbowNotch));
    const shoulderInner = addP(shoulder, mulP(upperN, -shoulderW / 2));
    const upperMid = addP(mulP(shoulderOuter, 0.5), mulP(elbowOuter, 0.5));
    const bicepPeak = addP(upperMid, mulP(upperN, peak));
    const foreOuterCtrl = addP(mulP(elbowOuter, 0.52), mulP(wristOuter, 0.48));
    const foreInnerCtrl = addP(mulP(elbowInner, 0.52), mulP(wristInner, 0.48));
    const upperInnerCtrl = addP(mulP(shoulderInner, 0.5), mulP(elbowInner, 0.5));
    ctx.beginPath();
    ctx.moveTo(shoulderOuter.x, shoulderOuter.y);
    ctx.quadraticCurveTo(bicepPeak.x, bicepPeak.y, elbowOuter.x, elbowOuter.y);
    ctx.quadraticCurveTo(foreOuterCtrl.x, foreOuterCtrl.y, wristOuter.x, wristOuter.y);
    ctx.quadraticCurveTo(hand.x, hand.y, wristInner.x, wristInner.y);
    ctx.quadraticCurveTo(foreInnerCtrl.x, foreInnerCtrl.y, elbowInner.x, elbowInner.y);
    ctx.quadraticCurveTo(upperInnerCtrl.x, upperInnerCtrl.y, shoulderInner.x, shoulderInner.y);
    ctx.quadraticCurveTo(shoulder.x, shoulder.y, shoulderOuter.x, shoulderOuter.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.strokeStyle = "rgba(42,42,42,0.72)";
    ctx.lineWidth = Math.max(1, 1.15 * S);
    const notchStart = addP(addP(shoulder, mulP(upperN, shoulderW * 0.34)), mulP(unitP(subP(elbow, shoulder)), 0.03 * joints.L));
    const notchMid = addP(addP(shoulder, mulP(upperN, shoulderW * 0.22)), mulP(unitP(subP(elbow, shoulder)), 0.095 * joints.L));
    const notchEnd = addP(addP(shoulder, mulP(upperN, shoulderW * 0.37)), mulP(unitP(subP(elbow, shoulder)), 0.16 * joints.L));
    ctx.beginPath();
    ctx.moveTo(notchStart.x, notchStart.y);
    ctx.quadraticCurveTo(notchMid.x, notchMid.y, notchEnd.x, notchEnd.y);
    ctx.stroke();
    ctx.restore();
  };
  const drawJackedTorsoWorld = (joints: ReturnType<typeof buildJackedJoints>) => {
    const { hipP, neckP, axis, axisUnit, U, L, at } = joints;
    const waistL = addP(hipP, mulP(U, 0.13 * L));
    const waistR = addP(hipP, mulP(U, -0.13 * L));
    const cutL = addP(at(0.35), mulP(U, 0.19 * L));
    const cutR = addP(at(0.35), mulP(U, -0.19 * L));
    const latL = addP(at(0.72), mulP(U, 0.36 * L));
    const latR = addP(at(0.72), mulP(U, -0.36 * L));
    const trapDrop = mulP(axisUnit, -0.04 * L);
    const trapL = addP(addP(neckP, mulP(U, 0.18 * L)), trapDrop);
    const trapR = addP(addP(neckP, mulP(U, -0.18 * L)), trapDrop);
    const top = addP(neckP, trapDrop);
    const trapPeakL = addP(addP(neckP, mulP(U, 0.08 * L)), mulP(axisUnit, 0.02 * L));
    const trapPeakR = addP(addP(neckP, mulP(U, -0.08 * L)), mulP(axisUnit, 0.02 * L));
    const lBow1 = addP(at(0.2), mulP(U, 0.18 * L));
    const lBow2 = addP(at(0.55), mulP(U, 0.34 * L));
    const lTrap1 = addP(at(0.9), mulP(U, 0.3 * L));
    const lTrap2 = addP(neckP, mulP(U, 0.24 * L));
    const rTrap2 = addP(neckP, mulP(U, -0.24 * L));
    const rTrap1 = addP(at(0.9), mulP(U, -0.3 * L));
    const rBow2 = addP(at(0.55), mulP(U, -0.34 * L));
    const rBow1 = addP(at(0.2), mulP(U, -0.18 * L));
    const waistCtrl = addP(hipP, mulP(axis, -0.03));
    ctx.fillStyle = "#e4d6c4";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(waistL.x, waistL.y);
    ctx.quadraticCurveTo(lBow1.x, lBow1.y, cutL.x, cutL.y);
    ctx.bezierCurveTo(lBow2.x, lBow2.y, addP(at(0.66), mulP(U, 0.38 * L)).x, addP(at(0.66), mulP(U, 0.38 * L)).y, latL.x, latL.y);
    ctx.bezierCurveTo(lTrap1.x, lTrap1.y, lTrap2.x, lTrap2.y, trapL.x, trapL.y);
    ctx.lineTo(trapPeakL.x, trapPeakL.y);
    ctx.quadraticCurveTo(top.x, top.y, trapPeakR.x, trapPeakR.y);
    ctx.lineTo(trapR.x, trapR.y);
    ctx.bezierCurveTo(rTrap2.x, rTrap2.y, rTrap1.x, rTrap1.y, latR.x, latR.y);
    ctx.bezierCurveTo(addP(at(0.66), mulP(U, -0.38 * L)).x, addP(at(0.66), mulP(U, -0.38 * L)).y, rBow2.x, rBow2.y, cutR.x, cutR.y);
    ctx.quadraticCurveTo(rBow1.x, rBow1.y, waistR.x, waistR.y);
    ctx.quadraticCurveTo(waistCtrl.x, waistCtrl.y, waistL.x, waistL.y);
    ctx.closePath();
    ctx.stroke();
    ctx.save();
    ctx.strokeStyle = "rgba(42,42,42,0.58)";
    ctx.lineWidth = Math.max(1, 1.45 * S);
    const pecGapTop = at(0.88);
    const pecGapBottom = at(0.72);
    ctx.beginPath();
    ctx.moveTo(pecGapTop.x, pecGapTop.y);
    ctx.lineTo(pecGapBottom.x, pecGapBottom.y);
    ctx.stroke();
    for (const side of [1, -1] as const) {
      const topInner = addP(at(0.9), mulP(U, side * 0.08 * L));
      const topOuter = addP(at(0.86), mulP(U, side * 0.3 * L));
      const bottomOuter = addP(at(0.7), mulP(U, side * 0.3 * L));
      const bottomInner = addP(at(0.7), mulP(U, side * 0.07 * L));
      const outerBow = addP(at(0.78), mulP(U, side * 0.34 * L));
      const bottomCtrl = addP(at(0.69), mulP(U, side * 0.18 * L));
      ctx.beginPath();
      ctx.moveTo(topInner.x, topInner.y);
      ctx.quadraticCurveTo(topOuter.x, topOuter.y, outerBow.x, outerBow.y);
      ctx.quadraticCurveTo(bottomOuter.x, bottomOuter.y, bottomOuter.x, bottomOuter.y);
      ctx.quadraticCurveTo(bottomCtrl.x, bottomCtrl.y, bottomInner.x, bottomInner.y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(42,42,42,0.42)";
    ctx.lineWidth = Math.max(1, 1.05 * S);
    const sternumTop = pecGapBottom;
    const sternumBottom = at(0.58);
    ctx.beginPath();
    ctx.moveTo(sternumTop.x, sternumTop.y);
    ctx.lineTo(sternumBottom.x, sternumBottom.y);
    ctx.stroke();
    const absYs = [0.52, 0.42, 0.32];
    for (const t of absYs) {
      const center = at(t);
      const left = addP(center, mulP(U, -0.08 * L));
      const right = addP(center, mulP(U, 0.08 * L));
      const sag = addP(center, mulP(axisUnit, -0.018 * L));
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.quadraticCurveTo(sag.x, sag.y, right.x, right.y);
      ctx.stroke();
    }
    const midlineTop = at(0.6);
    const midlineBottom = at(0.24);
    ctx.beginPath();
    ctx.moveTo(midlineTop.x, midlineTop.y);
    ctx.lineTo(midlineBottom.x, midlineBottom.y);
    ctx.stroke();
    ctx.restore();
  };
  const drawJackedShoulderCapsWorld = (joints: ReturnType<typeof buildJackedJoints>) => {
    ctx.fillStyle = "#e4d6c4";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = lw;
    for (const shoulder of [joints.shoulderL, joints.shoulderR]) {
      ctx.beginPath();
      ctx.arc(shoulder.x, shoulder.y, 0.1 * joints.L, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  };

  if (isJacked) {
    ctx.fillStyle = "#e4d6c4";
    ctx.strokeStyle = "#2a2a2a";
    const frontIsRight = facing >= 0;
    const joints = buildJackedJoints();
    if (!p.hideArms) {
      if (frontIsRight) drawJackedArmWorld("left", joints);
      else drawJackedArmWorld("right", joints);
    }
    drawJackedTorsoWorld(joints);
    drawJackedShoulderCapsWorld(joints);
    if (!p.hideArms) {
      if (frontIsRight) drawJackedArmWorld("right", joints);
      else drawJackedArmWorld("left", joints);
    }
  } else if (effectiveSkin === "styled") {
    const shoulderHalf = 19 * S;
    const waistHalf = 9 * S;
    ctx.save();
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = "#fff3dc";
    ctx.lineWidth = Math.max(1.5, 2.4 * S);
    ctx.beginPath();
    ctx.moveTo(-shoulderHalf, shoulderY);
    ctx.quadraticCurveTo(-16 * S, -torsoLen * 0.48, -waistHalf, 0);
    ctx.lineTo(waistHalf, 0);
    ctx.quadraticCurveTo(16 * S, -torsoLen * 0.48, shoulderHalf, shoulderY);
    ctx.quadraticCurveTo(0, -torsoLen * 1.08, -shoulderHalf, shoulderY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (!p.hideArms) {
      ctx.save();
      ctx.lineWidth = Math.max(lw * 1.28, 4 * S);
      drawArm(lArmA, lForeA);
      drawArm(rArmA, rForeA);
      ctx.restore();
    }
  } else {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -torsoLen); ctx.stroke();
    if (!p.hideArms) {
      drawArm(lArmA, lForeA);
      drawArm(rArmA, rForeA);
    }
  }
  if (!p.hideArms && p.forceHandOpen && p.pointTargetBX !== undefined) {
    const tdxLocal = (p.pointTargetBX - p.boardX) * facing;
    if (tdxLocal >= 0) drawOpenHand(rArmA, rForeA);
    else drawOpenHand(lArmA, lForeA);
  } else if (!p.hideArms && p.forceHandOpen && p.actionType === "explainGesture") {
    drawOpenHand(lArmA, lForeA);
    drawOpenHand(rArmA, rForeA);
  }

  if (p.popcornAlpha && p.popcornAlpha > 0) {
    const bucketX = (p.popcornX ?? 18) * S;
    const bucketY = (p.popcornY ?? -18) * S;
    ctx.save();
    ctx.globalAlpha = p.popcornAlpha;
    ctx.translate(bucketX, bucketY);
    ctx.fillStyle = "#fff4c2";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 1.6 * S);
    ctx.beginPath();
    ctx.moveTo(-12 * S, -10 * S);
    ctx.lineTo(12 * S, -10 * S);
    ctx.lineTo(8 * S, 15 * S);
    ctx.lineTo(-8 * S, 15 * S);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ff5e3a";
    for (const x of [-5, 5]) {
      ctx.beginPath();
      ctx.rect(x * S - 2 * S, -8 * S, 4 * S, 20 * S);
      ctx.fill();
    }
    ctx.fillStyle = "#fffdf5";
    for (const [x, y, r] of [[-9, -14, 4], [-2, -16, 5], [5, -15, 4], [11, -13, 3]] as const) {
      ctx.beginPath();
      ctx.arc(x * S, y * S, r * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // Permanent wrist launcher: the same forearm endpoint used by the rope anchor drives this prop.
  if (!p.hideArms && (LAUNCHER_ALWAYS_VISIBLE || (p.grappleRopeAlpha && p.grappleRopeAlpha > 0))) {
    // Pointing and force-choke poses resolve their final arm angles inside the renderer. Mount
    // against those resolved angles so the launcher remains strapped to the moving forearm.
    const resolvedLauncherMount = getForearmMount(true, {
      leftArm: lArmA,
      leftFore: lForeA,
      rightArm: rArmA,
      rightFore: rForeA,
    });
    ctx.save();
    ctx.translate(resolvedLauncherMount.localX, resolvedLauncherMount.localY - hipY);
    ctx.rotate(resolvedLauncherMount.angle);
    ctx.fillStyle = "#8B5A2B";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 1.3 * S);
    ctx.beginPath();
    ctx.roundRect(-resolvedLauncherMount.w * 0.78, -resolvedLauncherMount.h / 2, resolvedLauncherMount.w, resolvedLauncherMount.h, 2 * S);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Neck/head chain. Positive headTilt angles the head back/up from the neck joint; the head
  // remains a plain circle, but the neck/head center shifts so the upward-thinking pose reads.
  const neckTopX = -Math.sin(headTilt) * neckLen;
  const neckTopY = torsoTopY - Math.cos(headTilt) * neckLen;
  ctx.save();
  if (isJacked) ctx.lineWidth = Math.max(lw * 1.6, 5 * S);
  ctx.beginPath(); ctx.moveTo(0, torsoTopY); ctx.lineTo(neckTopX, neckTopY); ctx.stroke();
  ctx.restore();

  // Head — blank circle by default; optional cropped face image clips into the same tilted head,
  // adopting the crop oval's aspect ratio (headRX/headRY) instead of staying perfectly round.
  const headCX = neckTopX - Math.sin(headTilt) * headRY * 0.35;
  const headCY = neckTopY - Math.cos(headTilt) * headRY;
  const drawMouth = () => drawCharacterMouth(ctx, p.viseme ?? "rest", characterFace?.mouthAnchor, headCX, headCY, headRX, headRY, headTilt, lw);
  if (hasFace && characterFace?.image) {
    ctx.save();
    ctx.translate(headCX, headCY);
    ctx.rotate(headTilt);
    ctx.beginPath();
    ctx.ellipse(0, 0, headRX, headRY, 0, 0, Math.PI * 2);
    ctx.clip();
    if (facing < 0) ctx.scale(-1, 1);
    ctx.drawImage(characterFace.image, -headRX, -headRY, headRX * 2, headRY * 2);
    ctx.restore();
    drawMouth();
  } else {
    // Blank default head keeps its outline; a custom face's clipped image edge IS the head edge.
    ctx.beginPath(); ctx.ellipse(headCX, headCY, headRX, headRY, 0, 0, Math.PI * 2); ctx.stroke();
    drawMouth();
  }

  // Emoji emote
  if (p.emojiText && p.emojiAlpha && p.emojiAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = p.emojiAlpha;
    ctx.font = `${Math.max(12, 80 * S)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.scale(1 / facing, 1);
    ctx.fillText(p.emojiText, headCX * facing, headCY - headRY - 12 * S);
    ctx.restore();
  }

  if (p.surpriseAlpha && p.surpriseAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = p.surpriseAlpha;
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1, 1.5 * S);
    for (const [x, y] of [[-22, -12], [0, -22], [22, -12]] as const) {
      ctx.beginPath();
      ctx.moveTo(headCX + x * S * 0.6, headCY - headRY + y * S);
      ctx.lineTo(headCX + x * S, headCY - headRY + (y - 16) * S);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (p.sparkleAlpha && p.sparkleAlpha > 0) {
    const drawStar = (x: number, y: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
      ctx.moveTo(x - r * 0.65, y - r * 0.65); ctx.lineTo(x + r * 0.65, y + r * 0.65);
      ctx.moveTo(x - r * 0.65, y + r * 0.65); ctx.lineTo(x + r * 0.65, y - r * 0.65);
      ctx.stroke();
    };
    ctx.save();
    ctx.globalAlpha = p.sparkleAlpha;
    ctx.strokeStyle = "#c8a200";
    ctx.lineWidth = Math.max(1, 1.4 * S);
    drawStar(-34 * S, shoulderY - 10 * S, 6 * S);
    drawStar(34 * S, shoulderY - 16 * S, 7 * S);
    drawStar(18 * S, shoulderY - 42 * S, 5 * S);
    ctx.restore();
  }

  ctx.restore(); // un-lean (torso/neck/head/arms)

  if (p.grappleImpact && p.grappleImpact > 0) {
    ctx.save();
    ctx.globalAlpha = p.grappleImpact;
    ctx.strokeStyle = "#8B5A2B";
    ctx.lineWidth = Math.max(1, 1.5 * S);
    for (const x of [-12, 0, 12]) {
      ctx.beginPath();
      ctx.moveTo(x * S, 2 * S);
      ctx.lineTo((x + Math.sign(x || 1) * 6) * S, 14 * S);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore(); // top-level
}
