export const EXPLODE_SEQUENCE_ID = "explode";
export const EXPLODE_DURATION_SECONDS = 0.3;
export const EXPLODE_BLAST_SECONDS = 0.25;
export const EXPLODE_DETONATION_PROGRESS = 0;

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
  phase: "detonation" | "aftermath";
  characterVisible: false;
  burst: number;
  burstScale: number;
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

export function sampleExplode(progress: number): ExplodeSample {
  const elapsed = clamp(progress) * EXPLODE_DURATION_SECONDS;
  if (elapsed >= EXPLODE_BLAST_SECONDS) {
    return { phase: "aftermath", characterVisible: false, burst: 0, burstScale: 1 };
  }
  const blastProgress = elapsed / EXPLODE_BLAST_SECONDS;
  return {
    phase: "detonation",
    characterVisible: false,
    burst: 1 - smoothstep(blastProgress),
    burstScale: 0.72 + smoothstep(blastProgress) * 0.38,
  };
}

export function explodeDetonationTime(action: ExplodeTimelineAction): number {
  const setup = clamp(action.sequenceSetupDuration ?? 0, 0, Math.max(0, action.duration - 0.001));
  return action.startTime + setup;
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
    if (age >= 0 && age <= EXPLODE_BLAST_SECONDS && age < selectedAge) {
      selected = action;
      selectedAge = age;
    }
  }
  if (!selected) return { x: 0, y: 0 };
  const envelope = Math.pow(1 - selectedAge / EXPLODE_BLAST_SECONDS, 1.5);
  const seed = explodeSeed(selected.id);
  return {
    x: Math.sin(seed * 0.013 + selectedAge * 137) * 12 * envelope,
    y: Math.cos(seed * 0.017 + selectedAge * 173) * 9 * envelope,
  };
}

function traceBurst(ctx: CanvasRenderingContext2D, radius: number, seed: number) {
  const points = 22;
  ctx.beginPath();
  for (let index = 0; index < points; index += 1) {
    const angle = index / points * Math.PI * 2 - Math.PI / 2;
    const outer = index % 2 === 0;
    const jitter = ((seed >>> (index % 16)) & 3) / 20;
    const pointRadius = radius * (outer ? 0.9 + jitter : 0.4 + jitter * 0.5);
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
  if (sample.burst <= 0.001) return sample;
  const centerY = args.groundY - 92 * args.scale;
  ctx.save();
  ctx.translate(args.x, centerY);
  ctx.scale(sample.burstScale, sample.burstScale);
  ctx.globalAlpha *= sample.burst;
  ctx.fillStyle = "#ffd34e";
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = Math.max(1.8, 3.3 * args.scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  traceBurst(ctx, 112 * args.scale, args.seed);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  return sample;
}
