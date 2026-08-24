import { clamp, lerp, normalizePose, type Pose } from "../../characterAnimations.ts";
import type {
  SampledSequence,
  SampledSequenceCharacter,
  SampledSequenceEffect,
  SequenceCharacterKeyframe,
  SequenceEasing,
  SequenceEffect,
  SequenceKeyframe,
  PairedCharacterSequence,
  PairedSequenceRole,
  SequenceWorldSetup,
} from "./types.ts";

const ROLES: readonly PairedSequenceRole[] = ["attacker", "victim"];

function ease(value: number, easing: SequenceEasing = "easeInOut"): number {
  const t = clamp(value, 0, 1);
  if (easing === "linear") return t;
  if (easing === "easeIn") return t * t * t;
  if (easing === "easeOut") return 1 - Math.pow(1 - t, 3);
  if (easing === "hold") return 0;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    leftLegA: lerp(a.leftLegA, b.leftLegA, t),
    rightLegA: lerp(a.rightLegA, b.rightLegA, t),
    leftShinA: lerp(a.leftShinA ?? a.leftLegA, b.leftShinA ?? b.leftLegA, t),
    rightShinA: lerp(a.rightShinA ?? a.rightLegA, b.rightShinA ?? b.rightLegA, t),
    leftArmA: lerp(a.leftArmA, b.leftArmA, t),
    rightArmA: lerp(a.rightArmA, b.rightArmA, t),
    leftForeA: lerp(a.leftForeA, b.leftForeA, t),
    rightForeA: lerp(a.rightForeA, b.rightForeA, t),
    bodyLean: lerp(a.bodyLean, b.bodyLean, t),
    headTilt: lerp(a.headTilt, b.headTilt, t),
    headBob: lerp(a.headBob, b.headBob, t),
    poseRotation: lerp(a.poseRotation, b.poseRotation, t),
    airborneY: lerp(a.airborneY, b.airborneY, t),
  };
}

function facingFor(sequence: PairedCharacterSequence, role: PairedSequenceRole, direction: 1 | -1): 1 | -1 {
  if (sequence.setup.facing === "same") return direction;
  if (sequence.setup.facing === "away") return (role === "attacker" ? -direction : direction) as 1 | -1;
  return (role === "attacker" ? direction : -direction) as 1 | -1;
}

function resolveFramePositions(
  frame: SequenceKeyframe,
  sequence: PairedCharacterSequence,
  setup: SequenceWorldSetup,
): Record<PairedSequenceRole, { x: number; y: number }> {
  const result = {} as Record<PairedSequenceRole, { x: number; y: number }>;
  const spacingScale = (setup.distance ?? sequence.setup.distance) / Math.max(1, sequence.setup.distance);
  const resolveAbsolute = (character: SequenceCharacterKeyframe) => ({
    x: setup.centerX + character.position.x * spacingScale * setup.direction,
    y: setup.groundY + character.position.y,
  });

  for (const role of ROLES) {
    const character = frame[role];
    if (character.position.mode === "absolute") result[role] = resolveAbsolute(character);
  }
  for (const role of ROLES) {
    if (result[role]) continue;
    const character = frame[role];
    if (character.position.mode !== "relative") continue;
    const reference = result[character.position.to] ?? {
      x: setup.centerX + (character.position.to === "attacker" ? -1 : 1) * setup.direction * 0.5,
      y: setup.groundY,
    };
    result[role] = {
      x: reference.x + character.position.x * spacingScale * setup.direction,
      y: reference.y + character.position.y,
    };
  }
  return result;
}

function effectPoint(
  effect: SequenceEffect,
  characters: Record<PairedSequenceRole, SampledSequenceCharacter>,
  direction: 1 | -1,
) {
  const anchor = effect.anchor ?? "between";
  const base = anchor === "between"
    ? {
        x: (characters.attacker.position.x + characters.victim.position.x) / 2,
        y: (characters.attacker.position.y + characters.victim.position.y) / 2 - 105,
      }
    : characters[anchor].position;
  return { x: base.x + (effect.x ?? 0) * direction, y: base.y + (effect.y ?? 0) };
}

export function sequenceSetupMarks(sequence: PairedCharacterSequence, setup: SequenceWorldSetup) {
  const half = (setup.distance ?? sequence.setup.distance) / 2;
  return {
    attacker: { x: setup.centerX - half * setup.direction, y: setup.groundY },
    victim: { x: setup.centerX + half * setup.direction, y: setup.groundY },
  } satisfies Record<PairedSequenceRole, { x: number; y: number }>;
}

export function sampleSequence(
  sequence: PairedCharacterSequence,
  progress: number,
  setup: SequenceWorldSetup,
): SampledSequence {
  const frames = sequence.keyframes;
  const t = clamp(progress, 0, 1);
  let leftIndex = 0;
  while (leftIndex < frames.length - 2 && t > frames[leftIndex + 1].t) leftIndex++;
  const left = frames[leftIndex];
  const right = frames[Math.min(frames.length - 1, leftIndex + 1)];
  const span = Math.max(0.0001, right.t - left.t);
  const intervalT = ease((t - left.t) / span, left.easing);
  const leftPositions = resolveFramePositions(left, sequence, setup);
  const rightPositions = resolveFramePositions(right, sequence, setup);
  const characters = {} as Record<PairedSequenceRole, SampledSequenceCharacter>;

  for (const role of ROLES) {
    characters[role] = {
      pose: lerpPose(normalizePose(left[role].pose), normalizePose(right[role].pose), intervalT),
      position: {
        x: lerp(leftPositions[role].x, rightPositions[role].x, intervalT),
        y: lerp(leftPositions[role].y, rightPositions[role].y, intervalT),
      },
      facing: facingFor(sequence, role, setup.direction),
    };
  }

  const effectEnvelope = left.easing === "hold" ? 1 : 1 - ease(intervalT, "easeIn");
  const effects: SampledSequenceEffect[] = (left.effects ?? []).map((effect) => ({
    ...effect,
    ...effectPoint(effect, characters, setup.direction),
    alpha: clamp(effectEnvelope * (effect.intensity ?? 1), 0, 1),
  }));
  const shakeEffect = effects.find((effect) => effect.type === "screenShake");
  const shakeStrength = (shakeEffect?.intensity ?? 0) * (shakeEffect?.alpha ?? 0);
  const shake = {
    x: Math.sin(t * 997) * 8 * shakeStrength,
    y: Math.cos(t * 853) * 6 * shakeStrength,
  };
  return { progress: t, characters, effects, shake };
}

/** Deterministic preview version of the board's momentum response for sequence root motion. */
export function sampleSequenceWithMomentum(
  sequence: PairedCharacterSequence,
  progress: number,
  setup: SequenceWorldSetup,
): SampledSequence {
  const sample = sampleSequence(sequence, progress, setup);
  const dt = 1 / Math.max(1, sequence.durationSeconds * 60);
  const prior = sampleSequence(sequence, Math.max(0, progress - dt), setup);
  const prior2 = sampleSequence(sequence, Math.max(0, progress - dt * 2), setup);
  for (const role of ROLES) {
    const current = sample.characters[role];
    const vx = (current.position.x - prior.characters[role].position.x) / (dt * sequence.durationSeconds);
    const priorVx = (prior.characters[role].position.x - prior2.characters[role].position.x) / (dt * sequence.durationSeconds);
    const acceleration = (vx - priorVx) / (dt * sequence.durationSeconds);
    const localDirection = current.facing;
    const limbOffset = clamp(-acceleration * 0.000012 * localDirection, -0.14, 0.14);
    current.pose = {
      ...current.pose,
      bodyLean: current.pose.bodyLean + clamp(vx * 0.00028, -0.16, 0.16),
      leftArmA: current.pose.leftArmA + limbOffset,
      rightArmA: current.pose.rightArmA - limbOffset,
      leftLegA: current.pose.leftLegA + limbOffset * 0.82,
      rightLegA: current.pose.rightLegA - limbOffset * 0.82,
    };
  }
  return sample;
}
