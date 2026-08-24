# Two-character sequences

Sequences are plain TypeScript data. To make a move, copy `knee-to-face.ts`, rename its exported object and `id`, then add it to `characterSequences` in `index.ts`. Refresh `/board2/anim` after saving; Next.js Fast Refresh will pick up the data change.

Each sequence declares its duration, setup spacing, and ordered keyframes. `t` is a fraction from `0` to `1`. `easing` controls the trip from that keyframe to the next: `linear`, `easeIn`, `easeOut`, `easeInOut`, or `hold`.

```ts
export const example: CharacterSequence = {
  id: "example-slug",
  name: "Example name",
  description: "What happens in one sentence.",
  durationSeconds: 2.4,
  setup: {
    distance: 220,       // starting distance in board pixels
    facing: "toward",   // "toward", "same", or "away"
  },
  keyframes: [
    {
      t: 0,
      easing: "easeInOut", // interpolation from here to the next frame
      attacker: {
        pose: { bodyLean: 0, leftArmA: 0.25 },
        // Absolute positions use sequence-local board pixels. x=0 is the
        // setup midpoint, positive x points toward the victim, y=0 is ground.
        position: { mode: "absolute", x: -110, y: 0 },
      },
      victim: {
        pose: { bodyLean: 0, rightArmA: -0.25 },
        position: { mode: "absolute", x: 110, y: 0 },
      },
    },
    {
      t: 0.5,
      easing: "hold",
      attacker: {
        pose: { rightLegA: -1.4, rightShinA: -2.2, bodyLean: 0.25 },
        position: { mode: "absolute", x: -25, y: -8 },
      },
      victim: {
        pose: { headTilt: -0.6, airborneY: -25 },
        // Relative positions follow the named character at this keyframe.
        position: { mode: "relative", to: "attacker", x: 105, y: 0 },
      },
      effects: [
        { type: "impactStars", anchor: "victim", x: -20, y: -160 },
        { type: "screenShake", anchor: "between", intensity: 1 },
      ],
    },
    // Add a final keyframe at t: 1.
  ],
};
```

Pose values are radians: `leftLegA`, `rightLegA`, optional `leftShinA` and `rightShinA`, `leftArmA`, `rightArmA`, `leftForeA`, `rightForeA`, `bodyLean`, `headTilt`, `poseRotation`, plus pixel values `headBob` and `airborneY`. Missing pose values use the neutral pose.

Available effects are `impactStars`, `motionLines`, `dustPuff`, and `screenShake`. `anchor` can be `attacker`, `victim`, or `between`; `x`/`y` offset the effect in sequence-local pixels and `intensity` defaults to `1`.

Preview the move at `/board2/anim`. Pick it under “Two-character sequences,” adjust A/B positions if you want different spacing, turn skeleton overlays on, and scrub or use the left/right arrow keys to inspect individual 60 fps frames.
