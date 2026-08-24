import type { CharacterSequence } from "./types.ts";

const stand = {
  leftLegA: 0.12, rightLegA: -0.12,
  leftArmA: 0.25, rightArmA: -0.25,
  leftForeA: 0.18, rightForeA: -0.18,
  bodyLean: 0, headTilt: 0, headBob: 0, poseRotation: 0, airborneY: 0,
};

export const kneeToFaceSequence: CharacterSequence = {
  id: "knee-to-face",
  name: "Knee to face",
  description: "Grab, comedy beat, knee strike, impact hold, and a theatrical throw.",
  durationSeconds: 3.2,
  setup: { distance: 230, facing: "toward" },
  keyframes: [
    {
      t: 0, easing: "easeInOut",
      attacker: { pose: stand, position: { mode: "absolute", x: -115, y: 0 } },
      victim: { pose: stand, position: { mode: "absolute", x: 115, y: 0 } },
    },
    {
      t: 0.16, easing: "easeOut",
      attacker: {
        pose: { ...stand, leftLegA: 0.38, rightLegA: -0.22, leftArmA: -0.72, rightArmA: 0.72, leftForeA: -1.35, rightForeA: 1.35, bodyLean: 0.14 },
        position: { mode: "absolute", x: -64, y: 0 },
      },
      victim: { pose: { ...stand, bodyLean: -0.04, headTilt: -0.06 }, position: { mode: "absolute", x: 82, y: 0 } },
      effects: [{ type: "motionLines", anchor: "attacker", x: -48, y: -82, intensity: 0.7 }],
    },
    {
      t: 0.31, easing: "easeInOut",
      attacker: {
        pose: { ...stand, leftLegA: 0.24, rightLegA: -0.28, leftArmA: -1.02, rightArmA: 1.02, leftForeA: -1.92, rightForeA: 1.92, bodyLean: 0.2 },
        position: { mode: "absolute", x: -42, y: 0 },
      },
      victim: {
        pose: { ...stand, leftArmA: 0.58, rightArmA: -0.58, leftForeA: 0.9, rightForeA: -0.9, bodyLean: -0.2, headTilt: -0.14, headBob: 5 },
        position: { mode: "relative", to: "attacker", x: 112, y: 0 },
      },
    },
    {
      t: 0.43, easing: "hold",
      attacker: {
        pose: { ...stand, leftLegA: 0.5, rightLegA: -0.52, leftShinA: -0.15, rightShinA: 0.15, leftArmA: -1.08, rightArmA: 1.08, leftForeA: -1.98, rightForeA: 1.98, bodyLean: -0.12, headBob: 2 },
        position: { mode: "absolute", x: -38, y: 0 },
      },
      victim: {
        pose: { ...stand, leftArmA: 0.68, rightArmA: -0.68, leftForeA: 1.0, rightForeA: -1.0, bodyLean: -0.22, headTilt: -0.18, headBob: 7 },
        position: { mode: "relative", to: "attacker", x: 108, y: 0 },
      },
      effects: [{ type: "motionLines", anchor: "attacker", x: -18, y: -20, intensity: 0.45 }],
    },
    {
      t: 0.49, easing: "hold",
      attacker: {
        pose: { ...stand, leftLegA: 0.22, rightLegA: -1.42, leftShinA: 0.14, rightShinA: -2.28, leftArmA: -1.08, rightArmA: 1.08, leftForeA: -1.98, rightForeA: 1.98, bodyLean: 0.28, headBob: -4 },
        position: { mode: "absolute", x: -26, y: -8 },
      },
      victim: {
        pose: { ...stand, leftLegA: 0.52, rightLegA: -0.48, leftArmA: 1.08, rightArmA: -1.08, leftForeA: 1.55, rightForeA: -1.55, bodyLean: -0.62, headTilt: -0.56, headBob: -13, airborneY: -24 },
        position: { mode: "relative", to: "attacker", x: 105, y: -4 },
      },
      effects: [
        { type: "impactStars", anchor: "victim", x: -25, y: -162, intensity: 1 },
        { type: "screenShake", anchor: "between", intensity: 1 },
        { type: "motionLines", anchor: "attacker", x: 22, y: -78, intensity: 0.9 },
      ],
    },
    {
      t: 0.57, easing: "easeOut",
      attacker: {
        pose: { ...stand, leftLegA: 0.22, rightLegA: -1.42, leftShinA: 0.14, rightShinA: -2.28, leftArmA: -1.08, rightArmA: 1.08, leftForeA: -1.98, rightForeA: 1.98, bodyLean: 0.28, headBob: -4 },
        position: { mode: "absolute", x: -26, y: -8 },
      },
      victim: {
        pose: { ...stand, leftLegA: 0.72, rightLegA: -0.62, leftArmA: 1.18, rightArmA: -1.18, leftForeA: 1.65, rightForeA: -1.65, bodyLean: -0.78, headTilt: -0.68, headBob: -16, airborneY: -34 },
        position: { mode: "relative", to: "attacker", x: 116, y: -7 },
      },
      effects: [{ type: "impactStars", anchor: "victim", x: -24, y: -162, intensity: 0.85 }],
    },
    {
      t: 0.76, easing: "easeIn",
      attacker: {
        pose: { ...stand, leftLegA: 0.34, rightLegA: -0.22, leftArmA: -0.48, rightArmA: 0.82, leftForeA: -0.7, rightForeA: 1.1, bodyLean: 0.12 },
        position: { mode: "absolute", x: -28, y: 0 },
      },
      victim: {
        pose: { ...stand, leftLegA: 0.92, rightLegA: -0.82, leftShinA: -0.35, rightShinA: 0.3, leftArmA: 1.28, rightArmA: -1.12, leftForeA: 0.72, rightForeA: -0.62, bodyLean: -0.15, headTilt: -0.42, poseRotation: -1.12, airborneY: -55 },
        position: { mode: "absolute", x: 156, y: -12 },
      },
      effects: [{ type: "motionLines", anchor: "victim", x: -42, y: -70, intensity: 0.8 }],
    },
    {
      t: 0.87, easing: "easeOut",
      attacker: {
        pose: { ...stand, leftLegA: 0.18, rightLegA: -0.18, leftArmA: 0.42, rightArmA: -0.42, leftForeA: 0.72, rightForeA: -0.72, bodyLean: 0.04 },
        position: { mode: "absolute", x: -16, y: 0 },
      },
      victim: {
        pose: { ...stand, leftLegA: 1.18, rightLegA: -0.92, leftShinA: -0.82, rightShinA: 0.7, leftArmA: 1.42, rightArmA: -1.26, leftForeA: 0.82, rightForeA: -0.72, bodyLean: 0.02, headTilt: -0.3, poseRotation: -1.54, airborneY: -8 },
        position: { mode: "absolute", x: 188, y: 0 },
      },
      effects: [
        { type: "dustPuff", anchor: "victim", x: 8, y: 0, intensity: 1 },
        { type: "screenShake", anchor: "victim", intensity: 0.55 },
      ],
    },
    {
      t: 1, easing: "easeInOut",
      attacker: {
        pose: { ...stand, leftLegA: 0.2, rightLegA: -0.2, leftArmA: 0.38, rightArmA: -0.38, leftForeA: 0.62, rightForeA: -0.62, bodyLean: 0.05, headTilt: -0.08 },
        position: { mode: "absolute", x: 24, y: 0 },
      },
      victim: {
        pose: { ...stand, leftLegA: 1.18, rightLegA: -0.92, leftShinA: -0.82, rightShinA: 0.7, leftArmA: 1.42, rightArmA: -1.26, leftForeA: 0.82, rightForeA: -0.72, bodyLean: 0, headTilt: -0.3, poseRotation: -1.57 },
        position: { mode: "absolute", x: 188, y: 0 },
      },
    },
  ],
};
