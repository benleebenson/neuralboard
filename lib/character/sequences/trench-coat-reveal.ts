import { TRENCH_COAT_REVEAL_DURATION } from "../trench-coat-reveal.ts";
import type { SingleCharacterSequence } from "./types.ts";

/** Registry metadata for the one-character trench-coat prop sequence. */
export const trenchCoatRevealSequence: SingleCharacterSequence = {
  kind: "single-canvas",
  roles: ["performer"],
  renderer: "trenchCoatReveal",
  id: "trench-coat-reveal",
  name: "Trench coat reveal",
  description: "Walk into frame, pull the coat open, and reveal a chosen image.",
  durationSeconds: TRENCH_COAT_REVEAL_DURATION,
};
