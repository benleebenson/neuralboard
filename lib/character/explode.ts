export const EXPLODE_SEQUENCE_ID = "explode";
export const EXPLODE_DURATION_SECONDS = 0.3;
export const EXPLODE_BLAST_SECONDS = 0.25;
export const EXPLODE_SHAKE_SECONDS = 0.45;
export const EXPLODE_DETONATION_PROGRESS = 0;
export const SECONDARY_COMBUSTION_DURATION_SECONDS = 1.6;

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

export type ExplosionSurface = {
  id: string;
  type: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
};

export type SecondaryCombustionEvent = {
  id: string;
  detonationTime: number;
  origin: { x: number; y: number };
  victimStart: { x: number; y: number };
};

export type SecondaryCombustionPiece = {
  kind: "head" | "torso" | "limb";
  x: number;
  y: number;
  rotation: number;
  length: number;
};

export type SecondaryCombustionSample = {
  active: boolean;
  age: number;
  alpha: number;
  pieces: SecondaryCombustionPiece[];
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

/** The chain reaction only applies when both characters' feet share the same image top. */
export function sharedExplosionImageSurfaceId(
  first: { x: number; y: number },
  second: { x: number; y: number },
  surfaces: readonly ExplosionSurface[],
): string | null {
  const supporting = (point: { x: number; y: number }) => surfaces
    .filter((surface) => surface.type === "image")
    .filter((surface) => point.x >= surface.boardX && point.x <= surface.boardX + surface.boardW)
    .filter((surface) => Math.abs(point.y - surface.boardY) <= Math.max(36, surface.boardH * 0.12))
    .sort((a, b) => Math.abs(point.y - a.boardY) - Math.abs(point.y - b.boardY))[0]?.id;
  const firstSurface = supporting(first);
  return firstSurface && supporting(second) === firstSurface ? firstSurface : null;
}

/** Deterministic separated body parts launched far enough to leave a focused image frame. */
export function sampleSecondaryCombustion(
  time: number,
  event: SecondaryCombustionEvent,
): SecondaryCombustionSample | null {
  const age = time - event.detonationTime;
  if (age < 0) return null;
  if (age > SECONDARY_COMBUSTION_DURATION_SECONDS) {
    return { active: false, age, alpha: 0, pieces: [] };
  }
  const seed = explodeSeed(event.id);
  const direction: 1 | -1 = Math.abs(event.victimStart.x - event.origin.x) > 2
    ? event.victimStart.x >= event.origin.x ? 1 : -1
    : (seed & 1) === 0 ? 1 : -1;
  const rootVelocityX = direction * (1050 + seed % 280);
  const rootVelocityY = -720;
  const gravity = 560;
  const alpha = 1 - smoothstep((age - 1.05) / 0.55);
  const configs = [
    { kind: "head" as const, x: 0, y: -146, vx: direction * 105, vy: -175, spin: direction * 8.4, length: 30 },
    { kind: "torso" as const, x: 0, y: -91, vx: -direction * 40, vy: -40, spin: -direction * 6.1, length: 58 },
    { kind: "limb" as const, x: -24, y: -105, vx: -240, vy: -135, spin: -9.2, length: 48 },
    { kind: "limb" as const, x: 24, y: -105, vx: 240, vy: -210, spin: 10.1, length: 48 },
    { kind: "limb" as const, x: -15, y: -43, vx: -175, vy: 55, spin: 7.6, length: 55 },
    { kind: "limb" as const, x: 15, y: -43, vx: 185, vy: -15, spin: -8.7, length: 55 },
  ];
  return {
    active: true,
    age,
    alpha,
    pieces: configs.map((piece, index) => ({
      kind: piece.kind,
      x: event.victimStart.x + piece.x + (rootVelocityX + piece.vx) * age,
      y: event.victimStart.y + piece.y + (rootVelocityY + piece.vy) * age + gravity * age * age * 0.5,
      rotation: piece.spin * age + ((seed >>> (index * 3)) & 7) * 0.12,
      length: piece.length,
    })),
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
    if (age >= 0 && age <= EXPLODE_SHAKE_SECONDS && age < selectedAge) {
      selected = action;
      selectedAge = age;
    }
  }
  if (!selected) return { x: 0, y: 0 };
  const envelope = Math.pow(1 - selectedAge / EXPLODE_SHAKE_SECONDS, 1.35);
  const seed = explodeSeed(selected.id);
  return {
    x: Math.sin(seed * 0.013 + selectedAge * 137) * 34 * envelope,
    y: Math.cos(seed * 0.017 + selectedAge * 173) * 26 * envelope,
  };
}

export function drawSecondaryCombustionToCanvas(
  ctx: CanvasRenderingContext2D,
  sample: SecondaryCombustionSample,
  cam: { cameraX: number; cameraY: number },
  scale: number,
  width: number,
  height: number,
) {
  if (!sample.active || sample.alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= sample.alpha;
  ctx.strokeStyle = "#2a2a2a";
  ctx.fillStyle = "#fffdf5";
  ctx.lineWidth = Math.max(1.8, 3 * scale);
  ctx.lineCap = "round";
  for (const piece of sample.pieces) {
    const x = (piece.x - cam.cameraX) * scale + width / 2;
    const y = (piece.y - cam.cameraY) * scale + height / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(piece.rotation);
    if (piece.kind === "head") {
      ctx.beginPath();
      ctx.arc(0, 0, piece.length * scale * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -piece.length * scale * 0.5);
      ctx.lineTo(0, piece.length * scale * 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }
  const sparkOrigin = sample.pieces[1];
  if (sparkOrigin) {
    const sx = (sparkOrigin.x - cam.cameraX) * scale + width / 2;
    const sy = (sparkOrigin.y - cam.cameraY) * scale + height / 2;
    ctx.fillStyle = "#ff5e3a";
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2 + sample.age * 5;
      const distance = (28 + index * 5) * scale * Math.min(1, sample.age * 4);
      ctx.beginPath();
      ctx.arc(sx + Math.cos(angle) * distance, sy + Math.sin(angle) * distance, Math.max(1.5, 3.5 * scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
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
