import type { Pose } from "../../characterAnimations.ts";

export type SequenceRole = "attacker" | "victim";

export type SequenceEasing =
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "hold";

export type SequencePosition =
  | { mode: "absolute"; x: number; y: number }
  | { mode: "relative"; to: SequenceRole; x: number; y: number };

export type SequenceEffect = {
  type: "impactStars" | "motionLines" | "dustPuff" | "screenShake";
  anchor?: SequenceRole | "between";
  x?: number;
  y?: number;
  intensity?: number;
};

export type SequenceCharacterKeyframe = {
  pose: Partial<Pose>;
  position: SequencePosition;
};

export type SequenceKeyframe = {
  /** Fraction of the sequence duration, from 0 to 1. */
  t: number;
  /** Controls the interpolation from this keyframe to the next one. */
  easing?: SequenceEasing;
  attacker: SequenceCharacterKeyframe;
  victim: SequenceCharacterKeyframe;
  effects?: SequenceEffect[];
};

export type CharacterSequence = {
  id: string;
  name: string;
  description: string;
  durationSeconds: number;
  setup: {
    distance: number;
    facing: "toward" | "same" | "away";
  };
  keyframes: SequenceKeyframe[];
};

export type SequenceWorldSetup = {
  centerX: number;
  groundY: number;
  /** Direction the attacker faces in world space. */
  direction: 1 | -1;
  /** Optional spacing override used by the animation harness. */
  distance?: number;
};

export type SampledSequenceCharacter = {
  pose: Pose;
  position: { x: number; y: number };
  facing: 1 | -1;
};

export type SampledSequenceEffect = SequenceEffect & {
  x: number;
  y: number;
  alpha: number;
};

export type SampledSequence = {
  progress: number;
  characters: Record<SequenceRole, SampledSequenceCharacter>;
  effects: SampledSequenceEffect[];
  shake: { x: number; y: number };
};
