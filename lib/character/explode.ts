import type { Pose } from "../characterAnimations.ts";

export const EXPLODE_SEQUENCE_ID = "explode";
export const EXPLODE_DURATION_SECONDS = 0.95;
export const EXPLODE_ANTICIPATION_SECONDS = 0.3;
export const EXPLODE_DETONATION_PROGRESS = EXPLODE_ANTICIPATION_SECONDS / EXPLODE_DURATION_SECONDS;

export type ExplodeTimelineAction = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  sequenceId?: string;
  sequenceSetupDuration?: number;
  sequenceCenterX?: number;
  sequenceCenterY?: number;
  targetX?: number;
  targetY?: number;
};

export type ExplodeSample = {
  phase: "anticipation" | "detonation" | "aftermath";
  characterVisible: boolean;
  sparkAlpha: number;
  burst: number;
  cloudAlpha: number;
  cloudScale: number;
  debrisAlpha: number;
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smoothstep = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

export function explodeSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function sampleExplode(progress: number): ExplodeSample {
  const p = clamp(progress);
  if (p < EXPLODE_DETONATION_PROGRESS) {
    const anticipation = p / EXPLODE_DETONATION_PROGRESS;
    return {
      phase: "anticipation",
      characterVisible: true,
      sparkAlpha: smoothstep(anticipation),
      burst: 0,
      cloudAlpha: 0,
      cloudScale: 0,
      debrisAlpha: 0,
    };
  }

  const afterDetonation = (p - EXPLODE_DETONATION_PROGRESS) / (1 - EXPLODE_DETONATION_PROGRESS);
  const detonationEnd = 0.22;
  if (afterDetonation < detonationEnd) {
    const t = afterDetonation / detonationEnd;
    return {
      phase: "detonation",
      characterVisible: false,
      sparkAlpha: 0,
      burst: 1 - smoothstep(t),
      cloudAlpha: 1,
      cloudScale: 0.45 + smoothstep(t) * 0.75,
      debrisAlpha: 1 - t * 0.3,
    };
  }

  const aftermath = (afterDetonation - detonationEnd) / (1 - detonationEnd);
  return {
    phase: "aftermath",
    characterVisible: false,
    sparkAlpha: 0,
    burst: 0,
    cloudAlpha: 1 - smoothstep(aftermath),
    cloudScale: 1.2 - smoothstep(aftermath) * 0.55,
    debrisAlpha: Math.max(0, 0.7 - aftermath * 1.4),
  };
}

export function explodeAnticipationPose(progress: number): Partial<Pose> {
  const t = smoothstep(clamp(progress / Math.max(0.0001, EXPLODE_DETONATION_PROGRESS)));
  const jolt = Math.sin(t * Math.PI) * 7;
  return {
    headBob: 7 * t - jolt,
    headTilt: Math.sin(t * Math.PI * 2) * 0.08,
    bodyLean: Math.sin(t * Math.PI) * 0.08,
    leftLegA: 0.12 + t * 0.27,
    rightLegA: -0.12 - t * 0.27,
    leftShinA: 0.12 + t * 0.18,
    rightShinA: -0.12 - t * 0.18,
    leftArmA: 0.25 + t * 2.05,
    rightArmA: -0.25 - t * 2.05,
    leftForeA: 0.18 + t * 1.65,
    rightForeA: -0.18 - t * 1.65,
  };
}

export function explodeDetonationTime(action: ExplodeTimelineAction): number {
  const setup = clamp(action.sequenceSetupDuration ?? 0, 0, Math.max(0, action.duration - 0.001));
  const performanceDuration = Math.max(0.001, action.duration - setup);
  return action.startTime + setup + performanceDuration * EXPLODE_DETONATION_PROGRESS;
}

export function isExplodeAction(action: ExplodeTimelineAction): boolean {
  return action.type === "sequence" && action.sequenceId === EXPLODE_SEQUENCE_ID;
}

/** Timeline-derived visibility: a detonation hides the performer until a later action starts. */
export function characterDespawnedAt(time: number, actions: readonly ExplodeTimelineAction[]): boolean {
  const lastDetonation = actions
    .filter((action) => isExplodeAction(action) && explodeDetonationTime(action) <= time + 1e-9)
    .sort((a, b) => explodeDetonationTime(b) - explodeDetonationTime(a))[0];
  if (!lastDetonation) return false;
  const detonationTime = explodeDetonationTime(lastDetonation);
  const hasRespawnAction = actions.some((action) =>
    action.id !== lastDetonation.id
    && action.startTime >= detonationTime - 1e-9
    && action.startTime <= time + 1e-9
  );
  return !hasRespawnAction;
}

export function explodeActionPoint(action: ExplodeTimelineAction) {
  return {
    x: action.targetX ?? action.sequenceCenterX ?? 0,
    y: action.targetY ?? action.sequenceCenterY ?? 0,
  };
}

/** Deterministic full-frame shake shared by preview, overlay, and offline export. */
export function explodeShakeAt(
  time: number,
  actionGroups: readonly (readonly ExplodeTimelineAction[])[],
): { x: number; y: number } {
  let selected: ExplodeTimelineAction | undefined;
  let selectedAge = Infinity;
  for (const action of actionGroups.flat()) {
    if (!isExplodeAction(action)) continue;
    const age = time - explodeDetonationTime(action);
    if (age >= 0 && age <= 0.28 && age < selectedAge) {
      selected = action;
      selectedAge = age;
    }
  }
  if (!selected) return { x: 0, y: 0 };
  const envelope = Math.pow(1 - selectedAge / 0.28, 1.5);
  const seed = explodeSeed(selected.id);
  return {
    x: Math.sin(seed * 0.013 + selectedAge * 137) * 12 * envelope,
    y: Math.cos(seed * 0.017 + selectedAge * 173) * 9 * envelope,
  };
}

function traceJaggedEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  seed: number,
) {
  const random = seededRandom(seed);
  ctx.beginPath();
  for (let index = 0; index < 22; index += 1) {
    const angle = index / 22 * Math.PI * 2;
    const jitter = 0.9 + random() * 0.2;
    const px = x + Math.cos(angle) * radiusX * jitter;
    const py = y + Math.sin(angle) * radiusY * jitter;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function drawImpactCraterToCanvas(
  ctx: CanvasRenderingContext2D,
  args: { x: number; groundY: number; scale: number; seed: number; alpha?: number; physique?: "slim" | "jacked" },
) {
  const { x, groundY, seed } = args;
  const scale = args.scale * (args.physique === "jacked" ? 1.12 : 1);
  const radiusX = 78 * scale;
  const radiusY = 21 * scale;
  const random = seededRandom(seed + 91);
  ctx.save();
  const inheritedAlpha = ctx.globalAlpha;
  const alpha = args.alpha ?? 1;
  ctx.globalAlpha = inheritedAlpha * alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#2a2a2a";
  ctx.fillStyle = "rgba(42,42,42,0.12)";
  ctx.lineWidth = Math.max(1.2, 2.5 * scale);
  traceJaggedEllipse(ctx, x, groundY + 1 * scale, radiusX, radiusY, seed);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha *= 0.42;
  ctx.lineWidth = Math.max(0.8, 1.25 * scale);
  traceJaggedEllipse(ctx, x + 1.5 * scale, groundY, radiusX * 0.8, radiusY * 0.55, seed + 37);
  ctx.stroke();
  ctx.globalAlpha = inheritedAlpha * alpha;
  for (let index = 0; index < 11; index += 1) {
    const angle = -Math.PI + random() * Math.PI;
    const side = Math.cos(angle) >= 0 ? 1 : -1;
    const startX = x + side * radiusX * (0.62 + random() * 0.28);
    const startY = groundY + Math.sin(angle) * radiusY * 0.4;
    const length = (18 + random() * 36) * scale;
    const endX = startX + side * length;
    const endY = startY + (random() - 0.42) * 14 * scale;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX + side * length * 0.48, startY + (random() - 0.5) * 7 * scale);
    ctx.lineTo(endX, endY);
    ctx.stroke();
  }
  ctx.restore();
}

function traceBurst(ctx: CanvasRenderingContext2D, radius: number, seed: number) {
  const random = seededRandom(seed);
  const points = 26;
  ctx.beginPath();
  for (let index = 0; index < points; index += 1) {
    const angle = index / points * Math.PI * 2 - Math.PI / 2;
    const outer = index % 2 === 0;
    const pointRadius = radius * (outer ? 0.85 + random() * 0.35 : 0.42 + random() * 0.18);
    const x = Math.cos(angle) * pointRadius;
    const y = Math.sin(angle) * pointRadius * 0.9;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function drawExplodeSequenceToCanvas(
  ctx: CanvasRenderingContext2D,
  args: { x: number; groundY: number; progress: number; scale: number; seed: number },
): ExplodeSample {
  const sample = sampleExplode(args.progress);
  const scale = args.scale;
  const centerY = args.groundY - 112 * scale;
  const random = seededRandom(args.seed);
  ctx.save();
  ctx.translate(args.x, centerY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (sample.phase === "anticipation") {
    ctx.globalAlpha *= sample.sparkAlpha;
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = "#ffd34e";
    ctx.lineWidth = Math.max(1.2, 2 * scale);
    for (let index = 0; index < 5; index += 1) {
      const angle = index / 5 * Math.PI * 2 + args.progress * 8;
      const distance = (36 + index * 7) * scale;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance * 0.7;
      ctx.beginPath();
      ctx.moveTo(x - 5 * scale, y);
      ctx.lineTo(x, y - 7 * scale);
      ctx.lineTo(x + 4 * scale, y + 2 * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return sample;
  }

  if (sample.burst > 0.001) {
    ctx.save();
    ctx.globalAlpha *= sample.burst;
    ctx.scale(sample.cloudScale, sample.cloudScale);
    ctx.fillStyle = "#ffd34e";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1.8, 3.3 * scale);
    traceBurst(ctx, 122 * scale, args.seed);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ff7a32";
    traceBurst(ctx, 70 * scale, args.seed + 19);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  if (sample.cloudAlpha > 0.001) {
    ctx.save();
    ctx.globalAlpha *= sample.cloudAlpha;
    ctx.scale(sample.cloudScale, sample.cloudScale);
    ctx.fillStyle = "#d8d2c8";
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1.5, 2.7 * scale);
    const lobes = [
      [-52, 6, 38], [-28, -30, 43], [8, -42, 48], [45, -20, 39],
      [57, 16, 34], [22, 33, 45], [-18, 35, 41],
    ] as const;
    for (const [x, y, radius] of lobes) {
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, radius * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (sample.phase === "aftermath") {
      ctx.globalAlpha *= 0.72;
      for (let index = 0; index < 3; index += 1) {
        const side = index % 2 === 0 ? -1 : 1;
        const y = (-66 - index * 25) * scale;
        ctx.beginPath();
        ctx.arc(side * (10 + index * 8) * scale, y, (13 + index * 3) * scale, Math.PI * 0.25, Math.PI * 1.85);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  if (sample.debrisAlpha > 0.001) {
    ctx.save();
    ctx.globalAlpha *= sample.debrisAlpha;
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = Math.max(1.2, 2.2 * scale);
    for (let index = 0; index < 15; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = (80 + random() * 90) * scale * (1.25 - sample.debrisAlpha * 0.2);
      const length = (7 + random() * 13) * scale;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance * 0.78;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
  return sample;
}
