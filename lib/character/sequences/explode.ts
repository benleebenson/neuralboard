import { EXPLODE_DURATION_SECONDS } from "../explode.ts";
import type { SingleCharacterSequence } from "./types.ts";

export const explodeSequence: SingleCharacterSequence = {
  kind: "single-canvas",
  roles: ["performer"],
  renderer: "explode",
  id: "explode",
  name: "Explode",
  description: "Instantly detonate in a brief comic blast, cut a crater into the surface, and despawn.",
  durationSeconds: EXPLODE_DURATION_SECONDS,
};
