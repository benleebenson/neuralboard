import type { Pose } from "../characterAnimations.ts";
import { STREAM_CHARACTER_GEOMETRY } from "./geometry.ts";

export const TRENCH_COAT_REVEAL_DURATION = 4.2;

export const TRENCH_COAT_REVEAL_BEATS = [
  { t: 0, label: "Idle in coat", shortLabel: "Idle", reach: 0, open: 0 },
  { t: 0.14, label: "Hands to lapels", shortLabel: "Lapels", reach: 1, open: 0 },
  { t: 0.28, label: "Begins to pull", shortLabel: "Pull", reach: 1, open: 0.12 },
  { t: 0.42, label: "Coat opens a little", shortLabel: "A little", reach: 1, open: 0.3 },
  { t: 0.56, label: "Coat opens wider", shortLabel: "Wider", reach: 1, open: 0.62 },
  { t: 0.7, label: "Full open reveal", shortLabel: "Reveal", reach: 1, open: 1 },
  { t: 1, label: "Hold open pose", shortLabel: "Hold", reach: 1, open: 1 },
] as const;

export type TrenchCoatRevealSample = {
  beatIndex: number;
  beatLabel: string;
  open: number;
  reach: number;
  revealAlpha: number;
};

export type TrenchCoatPoint = { x: number; y: number };
export type RevealRect = { x: number; y: number; width: number; height: number };

export type TrenchCoatJoints = {
  hip: TrenchCoatPoint;
  torsoTop: TrenchCoatPoint;
  leftShoulder: TrenchCoatPoint;
  rightShoulder: TrenchCoatPoint;
  leftElbow: TrenchCoatPoint;
  rightElbow: TrenchCoatPoint;
  leftHand: TrenchCoatPoint;
  rightHand: TrenchCoatPoint;
};

const DEFAULT_REVEAL_RECT: RevealRect = { x: -38, y: -154, width: 76, height: 82 };
const RELAXED_ARMS = {
  leftArmA: 0.45,
  rightArmA: -0.45,
  leftForeA: 0.35,
  rightForeA: -0.35,
} as const;

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => {
  const value = clamp(t);
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
};
const point = (x: number, y: number): TrenchCoatPoint => ({ x, y });

export function sampleTrenchCoatReveal(progress: number): TrenchCoatRevealSample {
  const t = clamp(progress);
  let beatIndex = 0;
  while (beatIndex < TRENCH_COAT_REVEAL_BEATS.length - 1 && t >= TRENCH_COAT_REVEAL_BEATS[beatIndex + 1].t) {
    beatIndex += 1;
  }
  const left = TRENCH_COAT_REVEAL_BEATS[beatIndex];
  const right = TRENCH_COAT_REVEAL_BEATS[Math.min(beatIndex + 1, TRENCH_COAT_REVEAL_BEATS.length - 1)];
  const interval = easeInOut((t - left.t) / Math.max(0.0001, right.t - left.t));
  const open = lerp(left.open, right.open, interval);
  return {
    beatIndex,
    beatLabel: left.label,
    open,
    reach: lerp(left.reach, right.reach, interval),
    revealAlpha: clamp((open - 0.2) / 0.55),
  };
}

function armHand(upperAngle: number, foreAngle: number, side: -1 | 1): TrenchCoatPoint {
  const arm = STREAM_CHARACTER_GEOMETRY.armRaw;
  const shoulderY = -STREAM_CHARACTER_GEOMETRY.torsoRaw * STREAM_CHARACTER_GEOMETRY.shoulderFactor;
  const elbow = point(-Math.sin(upperAngle) * arm, shoulderY + Math.cos(upperAngle) * arm);
  const hand = point(elbow.x - Math.sin(foreAngle) * arm, elbow.y + Math.cos(foreAngle) * arm);
  return point(Math.abs(hand.x) * side, hand.y);
}

function armAnglesForTarget(target: TrenchCoatPoint, side: -1 | 1) {
  const arm = STREAM_CHARACTER_GEOMETRY.armRaw;
  const shoulder = point(0, -STREAM_CHARACTER_GEOMETRY.torsoRaw * STREAM_CHARACTER_GEOMETRY.shoulderFactor);
  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  const rawDistance = Math.max(0.001, Math.hypot(dx, dy));
  const distance = Math.min(rawDistance, arm * 2 * 0.99);
  const end = point(shoulder.x + dx / rawDistance * distance, shoulder.y + dy / rawDistance * distance);
  const mid = point((shoulder.x + end.x) / 2, (shoulder.y + end.y) / 2);
  const bend = Math.sqrt(Math.max(0, arm ** 2 - (distance / 2) ** 2));
  const perpendicular = point(-(end.y - shoulder.y) / distance, (end.x - shoulder.x) / distance);
  const candidates = [
    point(mid.x + perpendicular.x * bend, mid.y + perpendicular.y * bend),
    point(mid.x - perpendicular.x * bend, mid.y - perpendicular.y * bend),
  ];
  const elbow = candidates.sort((a, b) => b.x * side - a.x * side)[0];
  const angle = (from: TrenchCoatPoint, to: TrenchCoatPoint) => Math.atan2(-(to.x - from.x), to.y - from.y);
  return { arm: angle(shoulder, elbow), fore: angle(elbow, end) };
}

/** Uses the shared arm lengths to move the real character's hands from rest to the lapels. */
export function trenchCoatRevealPose(progress: number): Partial<Pose> {
  const sample = sampleTrenchCoatReveal(progress);
  if (sample.reach <= 0.0001) return { ...RELAXED_ARMS };
  const shoulderY = -STREAM_CHARACTER_GEOMETRY.torsoRaw * STREAM_CHARACTER_GEOMETRY.shoulderFactor;
  const openness = easeInOut(sample.open);
  const pose: Partial<Pose> = {};
  for (const side of [-1, 1] as const) {
    const relaxed = side === -1
      ? { arm: RELAXED_ARMS.leftArmA, fore: RELAXED_ARMS.leftForeA }
      : { arm: RELAXED_ARMS.rightArmA, fore: RELAXED_ARMS.rightForeA };
    const relaxedHand = armHand(relaxed.arm, relaxed.fore, side);
    // Keep the hands below the shoulders so the bent sleeves read as coat sleeves
    // instead of folding upward into a cape-like diamond around the neck.
    const openHand = point(side * lerp(10, 52, openness), shoulderY + lerp(25, 30, openness));
    const target = point(lerp(relaxedHand.x, openHand.x, sample.reach), lerp(relaxedHand.y, openHand.y, sample.reach));
    const solved = armAnglesForTarget(target, side);
    const arm = lerp(relaxed.arm, solved.arm, easeInOut(sample.reach));
    const fore = lerp(relaxed.fore, solved.fore, easeInOut(sample.reach));
    if (side === -1) {
      pose.leftArmA = arm;
      pose.leftForeA = fore;
    } else {
      pose.rightArmA = arm;
      pose.rightForeA = fore;
    }
  }
  return pose;
}

/** Object-fit contain geometry used for both preview and export canvas rendering. */
export function fitRevealImage(sourceWidth: number, sourceHeight: number, bounds: RevealRect = DEFAULT_REVEAL_RECT): RevealRect {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return {
    x: bounds.x + (bounds.width - fittedWidth) / 2,
    y: bounds.y + (bounds.height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

function revealSourceDimensions(source: CanvasImageSource): { width: number; height: number } {
  const candidate = source as CanvasImageSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  };
  return {
    width: candidate.naturalWidth || candidate.videoWidth || candidate.width || 1,
    height: candidate.naturalHeight || candidate.videoHeight || candidate.height || 1,
  };
}

function traceSleeve(ctx: CanvasRenderingContext2D, shoulder: TrenchCoatPoint, elbow: TrenchCoatPoint, hand: TrenchCoatPoint, width: number) {
  const normal = (from: TrenchCoatPoint, to: TrenchCoatPoint) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    return point(-dy / length, dx / length);
  };
  const upperN = normal(shoulder, elbow);
  const lowerN = normal(elbow, hand);
  const elbowN = point((upperN.x + lowerN.x) / 2, (upperN.y + lowerN.y) / 2);
  ctx.beginPath();
  ctx.moveTo(shoulder.x + upperN.x * width, shoulder.y + upperN.y * width);
  ctx.lineTo(elbow.x + elbowN.x * width * 0.72, elbow.y + elbowN.y * width * 0.72);
  ctx.lineTo(hand.x + lowerN.x * width * 0.46, hand.y + lowerN.y * width * 0.46);
  ctx.lineTo(hand.x - lowerN.x * width * 0.46, hand.y - lowerN.y * width * 0.46);
  ctx.lineTo(elbow.x - elbowN.x * width * 0.72, elbow.y - elbowN.y * width * 0.72);
  ctx.lineTo(shoulder.x - upperN.x * width, shoulder.y - upperN.y * width);
  ctx.closePath();
}

function drawRevealContent(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | null | undefined,
  bounds: RevealRect,
  open: number,
  alpha: number,
  ink: string,
) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  const topHalf = lerp(1, bounds.width * 0.38, open);
  const bottomHalf = lerp(2, bounds.width * 0.5, open);
  ctx.beginPath();
  ctx.moveTo(-topHalf, bounds.y);
  ctx.lineTo(topHalf, bounds.y);
  ctx.lineTo(bottomHalf, bounds.y + bounds.height);
  ctx.lineTo(-bottomHalf, bounds.y + bounds.height);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  if (image) {
    const source = revealSourceDimensions(image);
    const fitted = fitRevealImage(source.width, source.height, bounds);
    ctx.drawImage(image, fitted.x, fitted.y, fitted.width, fitted.height);
  } else {
    ctx.fillStyle = "#c8f135";
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.fillStyle = ink;
    ctx.font = `800 ${Math.max(8, bounds.height * 0.18)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("REVEAL", 0, bounds.y + bounds.height / 2);
  }
  ctx.strokeStyle = ink;
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}

/**
 * Draws only the coat prop. The caller has already drawn the live CharacterEntity and supplies
 * its resolved torso/arm joints in the same transformed coordinate space.
 */
export function drawTrenchCoatPropToCanvas(
  ctx: CanvasRenderingContext2D,
  args: {
    progress: number;
    joints: TrenchCoatJoints;
    torsoLength: number;
    strokeWidth: number;
    revealImage?: CanvasImageSource | null;
    physique?: "slim" | "jacked";
  },
) {
  const sample = sampleTrenchCoatReveal(args.progress);
  const { joints } = args;
  const open = easeInOut(sample.open);
  const torso = args.torsoLength;
  const hemY = joints.hip.y + torso * 0.92;
  const coatShoulderX = Math.max(
    Math.abs(joints.leftShoulder.x),
    Math.abs(joints.rightShoulder.x),
    torso * (args.physique === "jacked" ? 0.48 : 0.43),
  );
  const closedOuterX = coatShoulderX + torso * 0.13;
  const revealBounds: RevealRect = {
    x: -torso * 0.36,
    y: joints.torsoTop.y + torso * 0.18,
    width: torso * 0.72,
    height: torso * 0.76,
  };
  const coatBack = "#eeece4";
  const coatFront = "#f7f5ee";
  const ink = "#2a2a2a";

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = args.strokeWidth;
  ctx.strokeStyle = ink;

  // The back gives the closed coat one continuous, long silhouette. It recedes
  // once the two front halves are pulled apart.
  ctx.save();
  ctx.globalAlpha *= lerp(1, 0.2, open);
  ctx.fillStyle = coatBack;
  ctx.beginPath();
  ctx.moveTo(-coatShoulderX, joints.leftShoulder.y - torso * 0.03);
  ctx.quadraticCurveTo(-closedOuterX, joints.hip.y - torso * 0.12, -closedOuterX * 0.96, hemY);
  ctx.quadraticCurveTo(0, hemY + torso * 0.04, closedOuterX * 0.96, hemY);
  ctx.quadraticCurveTo(closedOuterX, joints.hip.y - torso * 0.12, coatShoulderX, joints.rightShoulder.y - torso * 0.03);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawRevealContent(ctx, args.revealImage, revealBounds, open, sample.revealAlpha, ink);

  // Sleeves sit behind the front panels. Their seams begin at the garment's
  // shoulders, not the stick figure's center-line shoulder joints.
  ctx.fillStyle = coatFront;
  for (const [side, jointShoulder, jointElbow, jointHand] of [
    [-1, joints.leftShoulder, joints.leftElbow, joints.leftHand],
    [1, joints.rightShoulder, joints.rightElbow, joints.rightHand],
  ] as const) {
    const sleeveShoulder = point(side * coatShoulderX, jointShoulder.y - torso * 0.01);
    const restingElbow = point(side * closedOuterX, joints.hip.y - torso * 0.22);
    const restingCuff = point(side * closedOuterX * 0.9, joints.hip.y + torso * 0.27);
    const cuffAtHand = point(
      lerp(jointElbow.x, jointHand.x, 0.9),
      lerp(jointElbow.y, jointHand.y, 0.9),
    );
    const sleeveElbow = point(
      lerp(restingElbow.x, jointElbow.x, sample.reach),
      lerp(restingElbow.y, jointElbow.y, sample.reach),
    );
    const sleeveCuff = point(
      lerp(restingCuff.x, cuffAtHand.x, sample.reach),
      lerp(restingCuff.y, cuffAtHand.y, sample.reach),
    );
    traceSleeve(ctx, sleeveShoulder, sleeveElbow, sleeveCuff, torso * (args.physique === "jacked" ? 0.17 : 0.125));
    ctx.fill();
    ctx.stroke();
  }

  for (const side of [-1, 1] as const) {
    const shoulder = side === -1 ? joints.leftShoulder : joints.rightShoulder;
    const hand = side === -1 ? joints.leftHand : joints.rightHand;
    const neck = point(side * torso * 0.075, joints.torsoTop.y + torso * 0.01);
    const garmentShoulder = point(side * coatShoulderX, shoulder.y - torso * 0.03);
    const grip = point(
      lerp(side * torso * 0.055, hand.x, open),
      lerp(joints.torsoTop.y + torso * 0.55, hand.y, open),
    );
    const outerWaist = point(
      side * lerp(closedOuterX, Math.abs(hand.x) + torso * 0.18, open),
      lerp(joints.hip.y - torso * 0.12, joints.hip.y + torso * 0.02, open),
    );
    const outerHemX = side * lerp(
      closedOuterX * 0.96,
      Math.max(torso * 0.9, Math.abs(hand.x) + torso * 0.24),
      open,
    );
    const innerHemX = side * lerp(
      torso * 0.035,
      Math.max(torso * 0.34, Math.abs(hand.x) * 0.42),
      open,
    );
    ctx.fillStyle = coatFront;
    ctx.beginPath();
    ctx.moveTo(neck.x, neck.y);
    ctx.lineTo(garmentShoulder.x, garmentShoulder.y);
    ctx.quadraticCurveTo(side * closedOuterX, joints.hip.y - torso * 0.3, outerWaist.x, outerWaist.y);
    ctx.quadraticCurveTo(outerHemX, joints.hip.y + torso * 0.42, outerHemX, hemY);
    ctx.lineTo(innerHemX, hemY + torso * 0.025);
    ctx.quadraticCurveTo(grip.x * 0.98, joints.hip.y + torso * 0.12, grip.x, grip.y);
    ctx.lineTo(neck.x, neck.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Narrow notched lapels while closed; long pulled edges when fully open.
    const collarOuter = point(side * torso * 0.24, joints.torsoTop.y + torso * 0.1);
    const collarNotch = point(side * torso * 0.17, joints.torsoTop.y + torso * 0.18);
    const lapelPoint = point(
      lerp(side * torso * 0.045, grip.x, open),
      lerp(joints.torsoTop.y + torso * 0.47, grip.y, open),
    );
    ctx.beginPath();
    ctx.moveTo(neck.x, neck.y);
    ctx.lineTo(collarOuter.x, collarOuter.y);
    ctx.lineTo(collarNotch.x, collarNotch.y);
    ctx.lineTo(lapelPoint.x, lapelPoint.y);
    ctx.closePath();
    ctx.stroke();
  }

  // A center closure and buttons make the idle silhouette read immediately as
  // a trench coat, then disappear naturally as the fronts part.
  ctx.save();
  ctx.globalAlpha *= 1 - open;
  ctx.beginPath();
  ctx.moveTo(0, joints.torsoTop.y + torso * 0.5);
  ctx.lineTo(0, hemY);
  ctx.stroke();
  ctx.fillStyle = ink;
  for (const buttonY of [joints.torsoTop.y + torso * 0.58, joints.torsoTop.y + torso * 0.78]) {
    ctx.beginPath();
    ctx.arc(-torso * 0.075, buttonY, Math.max(1, args.strokeWidth * 0.7), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(torso * 0.075, buttonY, Math.max(1, args.strokeWidth * 0.7), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
  return sample;
}
