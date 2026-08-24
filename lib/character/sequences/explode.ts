import { EXPLODE_DURATION_SECONDS } from "../explode.ts";
import type { SingleCharacterSequence } from "./types.ts";

export const explodeSequence: SingleCharacterSequence = {
  kind: "single-canvas",
  roles: ["performer"],
  renderer: "explode",
  id: "explode",
  name: "Explode",
  description: "Anticipate, detonate in a comic blast, leave a crater, and despawn until the next action.",
  durationSeconds: EXPLODE_DURATION_SECONDS,
};
