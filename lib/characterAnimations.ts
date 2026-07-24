export type Pose = {
  leftLegA: number;
  rightLegA: number;
  leftShinA?: number;
  rightShinA?: number;
  leftArmA: number;
  rightArmA: number;
  leftForeA: number;
  rightForeA: number;
  bodyLean: number;
  headTilt: number;
  headBob: number;
  poseRotation: number;
  airborneY: number;
};

export type PoseKeyframe = {
  t: number;
  pose: Pose;
};

export type AuthoredAnimation = {
  id: string;
  name: string;
  keyframes: PoseKeyframe[];
  loop: boolean;
  createdAt: string;
  updatedAt?: string;
};

export const RESERVED_ANIMATION_NAMES = [
  "walk",
  "run",
  "jump",
  "flip",
  "idle",
  "explain",
  "emote-thinking",
  "pullups-rep",
  "mirror-flex",
  "dance",
  "sit",
  "climb",
  "skate-pedal",
  "skate-olly",
  "grapple-zip",
  "zipline-hang",
  "grapple-swing",
] as const;

export const DEFAULT_POSE: Pose = {
  leftLegA: 0.12,
  rightLegA: -0.12,
  leftArmA: 0.08,
  rightArmA: -0.08,
  leftForeA: 0.13,
  rightForeA: -0.13,
  bodyLean: 0,
  headTilt: 0,
  headBob: 0,
  poseRotation: 0,
  airborneY: 0,
};

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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

export function normalizePose(input: Partial<Pose> | undefined): Pose {
  return { ...DEFAULT_POSE, ...(input ?? {}) };
}

export function normalizeAnimation(input: unknown): AuthoredAnimation | null {
  const value = input as Partial<AuthoredAnimation> | null;
  if (!value || typeof value.name !== "string" || !Array.isArray(value.keyframes)) return null;
  const keyframes = value.keyframes
    .map((kf) => {
      const maybe = kf as Partial<PoseKeyframe>;
      return {
        t: clamp(Number(maybe.t ?? 0), 0, 1),
        pose: normalizePose(maybe.pose),
      };
    })
    .sort((a, b) => a.t - b.t);
  if (keyframes.length < 2) return null;
  return {
    id: typeof value.id === "string" ? value.id : `anim_${Date.now()}`,
    name: value.name.trim(),
    keyframes,
    loop: !!value.loop,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

export function animationMap(animations: AuthoredAnimation[]): Record<string, AuthoredAnimation> {
  const map: Record<string, AuthoredAnimation> = {};
  for (const anim of animations) map[anim.name] = anim;
  return map;
}

export function sampleAnimation(animation: AuthoredAnimation | undefined, progress: number): Pose | null {
  if (!animation || animation.keyframes.length < 2) return null;
  const sorted = animation.keyframes;
  let t = progress;
  if (animation.loop) t = ((t % 1) + 1) % 1;
  else t = clamp(t, 0, 1);
  if (t <= sorted[0].t) return sorted[0].pose;
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return last.pose;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(0.0001, b.t - a.t);
      return lerpPose(a.pose, b.pose, (t - a.t) / span);
    }
  }
  return last.pose;
}

function pose(patch: Partial<Pose>): Pose {
  return normalizePose(patch);
}

export const FORWARD_TUCK_FLIP_KEYFRAMES: PoseKeyframe[] = [
  {
    t: 0,
    pose: pose({
      leftLegA: -0.62, rightLegA: -0.54,
      leftArmA: 0.7, rightArmA: 0.7,
      leftForeA: 1.0, rightForeA: 0.95,
      bodyLean: -0.2,
      poseRotation: 0,
      airborneY: 0,
    }),
  },
  {
    t: 0.15,
    pose: pose({
      leftLegA: -0.08, rightLegA: 0.02,
      leftArmA: -2.6, rightArmA: -2.45,
      leftForeA: -0.05, rightForeA: -0.08,
      bodyLean: -0.08,
      poseRotation: 0.15 * Math.PI * 2,
      airborneY: -22,
    }),
  },
  {
    t: 0.35,
    pose: pose({
      leftLegA: -2.05, rightLegA: -1.88,
      leftArmA: -1.8, rightArmA: -1.65,
      leftForeA: 2.2, rightForeA: 2.05,
      bodyLean: -0.12,
      headBob: -3,
      poseRotation: 0.35 * Math.PI * 2,
      airborneY: -110,
    }),
  },
  {
    t: 0.5,
    pose: pose({
      leftLegA: -2.18, rightLegA: -2.0,
      leftArmA: -1.95, rightArmA: -1.78,
      leftForeA: 2.35, rightForeA: 2.2,
      bodyLean: -0.18,
      headBob: -5,
      poseRotation: Math.PI,
      airborneY: -170,
    }),
  },
  {
    t: 0.7,
    pose: pose({
      leftLegA: -1.05, rightLegA: -0.9,
      leftArmA: -1.0, rightArmA: 1.0,
      leftForeA: 0.9, rightForeA: 0.82,
      bodyLean: -0.06,
      poseRotation: 0.75 * Math.PI * 2,
      airborneY: -115,
    }),
  },
  {
    t: 0.88,
    pose: pose({
      leftLegA: -0.22, rightLegA: -0.08,
      leftArmA: -0.9, rightArmA: 0.9,
      leftForeA: 0.18, rightForeA: 0.12,
      bodyLean: -0.04,
      poseRotation: 0.97 * Math.PI * 2,
      airborneY: -35,
    }),
  },
  {
    t: 1,
    pose: pose({
      leftLegA: -0.52, rightLegA: -0.44,
      leftArmA: 0.35, rightArmA: 0.3,
      leftForeA: 1.15, rightForeA: 1.05,
      bodyLean: -0.12,
      poseRotation: Math.PI * 2,
      airborneY: 0,
    }),
  },
];

export const GRAPPLE_ZIP_KEYFRAMES: PoseKeyframe[] = [
  {
    t: 0,
    pose: pose({
      leftLegA: 0.12, rightLegA: -0.12,
      leftArmA: 0.55, rightArmA: 0.55,
      leftForeA: 0.25, rightForeA: 0.25,
      bodyLean: 0.08,
    }),
  },
  {
    t: 0.12,
    pose: pose({
      leftLegA: 0.1, rightLegA: -0.12,
      leftArmA: -1.05, rightArmA: -1.05,
      leftForeA: -0.15, rightForeA: -0.15,
      bodyLean: -0.08,
      headBob: -1,
    }),
  },
  {
    t: 0.3,
    pose: pose({
      leftLegA: -0.05, rightLegA: 0.04,
      leftArmA: -1.15, rightArmA: -1.15,
      leftForeA: -0.12, rightForeA: -0.12,
      bodyLean: -0.16,
      headBob: -2,
    }),
  },
  {
    t: 0.45,
    pose: pose({
      leftLegA: 0.62, rightLegA: 0.46,
      leftArmA: -1.35, rightArmA: -1.35,
      leftForeA: 0.35, rightForeA: 0.3,
      bodyLean: -0.92,
      airborneY: -18,
    }),
  },
  {
    t: 0.7,
    pose: pose({
      leftLegA: -0.4, rightLegA: 0.72,
      leftArmA: -1.15, rightArmA: -1.15,
      leftForeA: 0.55, rightForeA: 0.48,
      bodyLean: -0.45,
      airborneY: -12,
    }),
  },
  {
    t: 0.85,
    pose: pose({
      leftLegA: -0.85, rightLegA: -0.55,
      leftArmA: -0.8, rightArmA: 0.7,
      leftForeA: 0.9, rightForeA: 0.85,
      bodyLean: -0.22,
      airborneY: -4,
    }),
  },
  {
    t: 0.93,
    pose: pose({
      leftLegA: -1.0, rightLegA: -0.9,
      leftArmA: -0.25, rightArmA: 0.9,
      leftForeA: 1.15, rightForeA: 1.1,
      bodyLean: -0.42,
      airborneY: 0,
    }),
  },
  {
    t: 1,
    pose: pose({
      leftLegA: 0.12, rightLegA: -0.12,
      leftArmA: 0.08, rightArmA: -0.08,
      leftForeA: 0.13, rightForeA: -0.13,
      bodyLean: 0,
      airborneY: 0,
    }),
  },
];

export const SKATE_PEDAL_KEYFRAMES: PoseKeyframe[] = [
  { t: 0, pose: pose({ leftLegA: 0.18, rightLegA: -0.16, leftArmA: 0.14, rightArmA: -0.14, leftForeA: 0.08, rightForeA: -0.08, bodyLean: 0.14 }) },
  { t: 0.16, pose: pose({ leftLegA: 1.08, rightLegA: -0.16, leftArmA: 0.2, rightArmA: -0.16, leftForeA: 0.16, rightForeA: -0.08, bodyLean: 0.2, headBob: 1 }) },
  { t: 0.32, pose: pose({ leftLegA: 0.92, rightLegA: -0.16, leftArmA: 0.18, rightArmA: -0.18, leftForeA: 0.12, rightForeA: -0.1, bodyLean: 0.18 }) },
  { t: 0.5, pose: pose({ leftLegA: 0.08, rightLegA: -0.16, leftArmA: 0.12, rightArmA: -0.12, leftForeA: 0.04, rightForeA: -0.04, bodyLean: 0.14, headBob: -1 }) },
  { t: 0.66, pose: pose({ leftLegA: 0.16, rightLegA: -0.16, leftArmA: 0.16, rightArmA: -0.16, leftForeA: 0.08, rightForeA: -0.08, bodyLean: 0.12 }) },
  { t: 0.82, pose: pose({ leftLegA: 0.12, rightLegA: -0.16, leftArmA: 0.1, rightArmA: -0.1, leftForeA: 0.04, rightForeA: -0.04, bodyLean: 0.12 }) },
  { t: 1, pose: pose({ leftLegA: 0.18, rightLegA: -0.16, leftArmA: 0.14, rightArmA: -0.14, leftForeA: 0.08, rightForeA: -0.08, bodyLean: 0.14 }) },
];

export const SKATE_OLLY_KEYFRAMES: PoseKeyframe[] = [
  { t: 0, pose: pose({ leftLegA: 0.2, rightLegA: -0.18, leftArmA: 0.12, rightArmA: -0.12, leftForeA: 0.06, rightForeA: -0.06, bodyLean: 0.12 }) },
  { t: 0.18, pose: pose({ leftLegA: 0.8, rightLegA: -0.8, leftArmA: 0.22, rightArmA: -0.22, leftForeA: 0.12, rightForeA: -0.12, bodyLean: 0.24, headBob: 2 }) },
  { t: 0.34, pose: pose({ leftLegA: 0.45, rightLegA: -0.45, leftArmA: 0.32, rightArmA: -0.32, leftForeA: 0.18, rightForeA: -0.18, bodyLean: 0.08 }) },
  { t: 0.52, pose: pose({ leftLegA: 0.34, rightLegA: -0.34, leftArmA: 0.36, rightArmA: -0.36, leftForeA: 0.2, rightForeA: -0.2, bodyLean: 0.02 }) },
  { t: 0.68, pose: pose({ leftLegA: 0.34, rightLegA: -0.34, leftArmA: 0.34, rightArmA: -0.34, leftForeA: 0.18, rightForeA: -0.18, bodyLean: 0.04 }) },
  { t: 0.84, pose: pose({ leftLegA: 0.62, rightLegA: -0.62, leftArmA: 0.28, rightArmA: -0.28, leftForeA: 0.14, rightForeA: -0.14, bodyLean: 0.14 }) },
  { t: 1, pose: pose({ leftLegA: 0.5, rightLegA: -0.5, leftArmA: 0.18, rightArmA: -0.18, leftForeA: 0.1, rightForeA: -0.1, bodyLean: 0.16 }) },
];

export const THINKING_EMOTE_KEYFRAMES: PoseKeyframe[] = [
  { t: 0, pose: pose({ leftLegA: 0.12, rightLegA: -0.12, leftArmA: 0.08, rightArmA: -0.08, leftForeA: 0.13, rightForeA: -0.13, headTilt: 0, bodyLean: 0 }) },
  { t: 0.1, pose: pose({ leftLegA: 0.12, rightLegA: -0.12, leftArmA: 0.25, rightArmA: -0.5, leftForeA: 0.16, rightForeA: -0.35, headTilt: 0, bodyLean: 0.02 }) },
  { t: 0.22, pose: pose({ leftLegA: 0.13, rightLegA: -0.12, leftArmA: 0.25, rightArmA: -0.66, leftForeA: 0.16, rightForeA: -1.55, headTilt: 0.08, bodyLean: 0.03 }) },
  { t: 0.3, pose: pose({ leftLegA: 0.14, rightLegA: -0.12, leftArmA: 0.25, rightArmA: -0.72, leftForeA: 0.16, rightForeA: -2.18, headTilt: 0.15, bodyLean: 0.03 }) },
  { t: 0.9, pose: pose({ leftLegA: 0.16, rightLegA: -0.1, leftArmA: 0.25, rightArmA: -0.72, leftForeA: 0.18, rightForeA: -2.12, headTilt: 0.15, headBob: 1, bodyLean: 0.04 }) },
  { t: 1, pose: pose({ leftLegA: 0.12, rightLegA: -0.12, leftArmA: 0.08, rightArmA: -0.08, leftForeA: 0.13, rightForeA: -0.13, headTilt: 0, bodyLean: 0 }) },
];

export function starterAnimations(now = new Date().toISOString()): AuthoredAnimation[] {
  return [
    {
      id: "starter_walk",
      name: "walk",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftLegA: 0.46, rightLegA: -0.46, leftArmA: -0.32, rightArmA: 0.32, leftForeA: -0.08, rightForeA: 0.08, bodyLean: 0.04 }) },
        { t: 0.33, pose: pose({ leftLegA: 0.05, rightLegA: -0.08, leftArmA: 0.02, rightArmA: -0.02, leftForeA: 0.08, rightForeA: -0.08, headBob: -2 }) },
        { t: 0.66, pose: pose({ leftLegA: -0.46, rightLegA: 0.46, leftArmA: 0.32, rightArmA: -0.32, leftForeA: 0.08, rightForeA: -0.08, bodyLean: -0.04 }) },
        { t: 1, pose: pose({ leftLegA: 0.46, rightLegA: -0.46, leftArmA: -0.32, rightArmA: 0.32, leftForeA: -0.08, rightForeA: 0.08, bodyLean: 0.04 }) },
      ],
    },
    {
      id: "starter_jump",
      name: "jump",
      loop: false,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftLegA: 0.28, rightLegA: -0.28, leftArmA: -0.45, rightArmA: -0.45 }) },
        { t: 0.2, pose: pose({ leftLegA: -0.2, rightLegA: -0.15, leftArmA: -0.55, rightArmA: -0.55, airborneY: -45 }) },
        { t: 0.7, pose: pose({ leftLegA: -0.55, rightLegA: -0.45, leftArmA: -0.5, rightArmA: -0.5, leftForeA: -0.3, rightForeA: -0.3, airborneY: -150 }) },
        { t: 1, pose: pose({ leftLegA: 0.25, rightLegA: 0.15, leftArmA: 0.4, rightArmA: -0.4 }) },
      ],
    },
    {
      id: "starter_flip",
      name: "flip",
      loop: false,
      createdAt: now,
      keyframes: FORWARD_TUCK_FLIP_KEYFRAMES,
    },
    {
      id: "starter_grapple_zip",
      name: "grapple-zip",
      loop: false,
      createdAt: now,
      keyframes: GRAPPLE_ZIP_KEYFRAMES,
    },
    {
      id: "starter_grapple_swing_compat",
      name: "grapple-swing",
      loop: false,
      createdAt: now,
      keyframes: GRAPPLE_ZIP_KEYFRAMES,
    },
    {
      id: "starter_skate_pedal",
      name: "skate-pedal",
      loop: true,
      createdAt: now,
      keyframes: SKATE_PEDAL_KEYFRAMES,
    },
    {
      id: "starter_skate_olly",
      name: "skate-olly",
      loop: false,
      createdAt: now,
      keyframes: SKATE_OLLY_KEYFRAMES,
    },
    {
      id: "starter_idle",
      name: "idle",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ headBob: 0, bodyLean: -0.02 }) },
        { t: 0.5, pose: pose({ headBob: 2, bodyLean: 0.02 }) },
        { t: 1, pose: pose({ headBob: 0, bodyLean: -0.02 }) },
      ],
    },
    {
      id: "starter_explain",
      name: "explain",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftArmA: 0.9, rightArmA: -0.88, leftForeA: 1.25, rightForeA: -1.2, bodyLean: 0.02 }) },
        { t: 0.16, pose: pose({ leftArmA: 1.18, rightArmA: -2.35, leftForeA: 1.45, rightForeA: -2.9, headBob: -1, headTilt: 0.05, bodyLean: -0.03 }) },
        { t: 0.34, pose: pose({ leftArmA: 1.05, rightArmA: -0.82, leftForeA: 1.38, rightForeA: -0.35, headBob: 1.6, headTilt: 0.01, bodyLean: 0.04 }) },
        { t: 0.5, pose: pose({ leftArmA: 2.28, rightArmA: -1.05, leftForeA: 2.86, rightForeA: -1.34, headBob: -0.5, headTilt: -0.05, bodyLean: 0.03 }) },
        { t: 0.66, pose: pose({ leftArmA: 1.18, rightArmA: -1.16, leftForeA: 1.45, rightForeA: -1.42, headBob: 1.2, headTilt: 0.02 }) },
        { t: 0.84, pose: pose({ leftArmA: 0.72, rightArmA: -2.22, leftForeA: 0.24, rightForeA: -2.82, headBob: -0.6, headTilt: 0.05, bodyLean: -0.03 }) },
        { t: 1, pose: pose({ leftArmA: 0.9, rightArmA: -0.88, leftForeA: 1.25, rightForeA: -1.2, bodyLean: 0.02 }) },
      ],
    },
    {
      id: "starter_sit",
      name: "sit",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftLegA: 1.08, rightLegA: -1.02, leftShinA: -0.88, rightShinA: 0.82, leftArmA: -0.2, rightArmA: 0.18, leftForeA: -0.25, rightForeA: 0.2, bodyLean: 0.08, headTilt: 0.03, headBob: 0 }) },
        { t: 0.24, pose: pose({ leftLegA: 1.08, rightLegA: -1.02, leftShinA: -0.88, rightShinA: 0.82, leftArmA: -0.18, rightArmA: 0.48, leftForeA: -0.22, rightForeA: 0.86, bodyLean: 0.09, headTilt: 0.04, headBob: 0.5 }) },
        { t: 0.52, pose: pose({ leftLegA: 1.08, rightLegA: -1.02, leftShinA: -0.88, rightShinA: 0.82, leftArmA: -0.2, rightArmA: -0.72, leftForeA: -0.25, rightForeA: -1.55, bodyLean: 0.08, headTilt: 0.06, headBob: -0.5 }) },
        { t: 0.7, pose: pose({ leftLegA: 1.08, rightLegA: -1.02, leftShinA: -0.88, rightShinA: 0.82, leftArmA: -0.2, rightArmA: -0.28, leftForeA: -0.25, rightForeA: -0.6, bodyLean: 0.08, headTilt: 0.04, headBob: 0.8 }) },
        { t: 1, pose: pose({ leftLegA: 1.08, rightLegA: -1.02, leftShinA: -0.88, rightShinA: 0.82, leftArmA: -0.2, rightArmA: 0.18, leftForeA: -0.25, rightForeA: 0.2, bodyLean: 0.08, headTilt: 0.03, headBob: 0 }) },
      ],
    },
    {
      id: "starter_emote_thinking",
      name: "emote-thinking",
      loop: false,
      createdAt: now,
      keyframes: THINKING_EMOTE_KEYFRAMES,
    },
    {
      id: "starter_pullups_rep",
      name: "pullups-rep",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftArmA: -0.85, rightArmA: 0.85, leftForeA: -0.32, rightForeA: 0.32, leftLegA: 0.02, rightLegA: -0.02, airborneY: -40 }) },
        { t: 0.32, pose: pose({ leftArmA: -1.08, rightArmA: 1.08, leftForeA: 0.95, rightForeA: -0.95, leftLegA: 0.36, rightLegA: -0.34, airborneY: -82, bodyLean: 0.02 }) },
        { t: 0.5, pose: pose({ leftArmA: -1.18, rightArmA: 1.18, leftForeA: 1.45, rightForeA: -1.45, leftLegA: 0.48, rightLegA: -0.46, airborneY: -103, headBob: -2 }) },
        { t: 0.78, pose: pose({ leftArmA: -1.0, rightArmA: 1.0, leftForeA: 0.65, rightForeA: -0.65, leftLegA: 0.3, rightLegA: -0.28, airborneY: -64 }) },
        { t: 1, pose: pose({ leftArmA: -0.85, rightArmA: 0.85, leftForeA: -0.32, rightForeA: 0.32, leftLegA: 0.02, rightLegA: -0.02, airborneY: -40 }) },
      ],
    },
    {
      id: "starter_mirror_flex",
      name: "mirror-flex",
      loop: false,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftArmA: 0.08, rightArmA: -0.08, leftForeA: 0.13, rightForeA: -0.13, headTilt: 0 }) },
        { t: 0.25, pose: pose({ leftArmA: 0.62, rightArmA: -0.62, leftForeA: 0.8, rightForeA: -0.8, headTilt: 0.08, bodyLean: 0.02 }) },
        { t: 0.55, pose: pose({ leftArmA: 1.18, rightArmA: -1.18, leftForeA: 2.15, rightForeA: -2.15, leftLegA: 0.18, rightLegA: -0.18, headTilt: 0.08 }) },
        { t: 0.82, pose: pose({ leftArmA: 0.8, rightArmA: -0.8, leftForeA: 1.05, rightForeA: -1.05, leftLegA: 0.22, rightLegA: -0.22, headTilt: 0.08 }) },
        { t: 1, pose: pose({ leftArmA: 1.15, rightArmA: -0.35, leftForeA: 2.05, rightForeA: -0.65, leftLegA: 0.22, rightLegA: -0.22, headTilt: 0.08 }) },
      ],
    },
    {
      id: "starter_dance",
      name: "dance",
      loop: true,
      createdAt: now,
      keyframes: [
        { t: 0, pose: pose({ leftLegA: 0.46, rightLegA: -0.46, leftShinA: 0.18, rightShinA: -0.18, leftArmA: 0.72, rightArmA: -0.72, leftForeA: 1.02, rightForeA: -1.02, bodyLean: 0.12, headBob: 0 }) },
        { t: 0.25, pose: pose({ leftLegA: 0.52, rightLegA: -0.4, leftShinA: 0.14, rightShinA: -0.2, leftArmA: 0.44, rightArmA: -1.0, leftForeA: 0.84, rightForeA: -1.2, bodyLean: 0.02, headTilt: -0.04, headBob: -3 }) },
        { t: 0.5, pose: pose({ leftLegA: 0.46, rightLegA: -0.46, leftShinA: 0.18, rightShinA: -0.18, leftArmA: 0.72, rightArmA: -0.72, leftForeA: 1.02, rightForeA: -1.02, bodyLean: 0.12, headBob: 0 }) },
        { t: 0.75, pose: pose({ leftLegA: 0.4, rightLegA: -0.52, leftShinA: 0.2, rightShinA: -0.14, leftArmA: 1.0, rightArmA: -0.44, leftForeA: 1.2, rightForeA: -0.84, bodyLean: 0.22, headTilt: 0.04, headBob: -3 }) },
        { t: 1, pose: pose({ leftLegA: 0.46, rightLegA: -0.46, leftShinA: 0.18, rightShinA: -0.18, leftArmA: 0.72, rightArmA: -0.72, leftForeA: 1.02, rightForeA: -1.02, bodyLean: 0.12, headBob: 0 }) },
      ],
    },
  ];
}
