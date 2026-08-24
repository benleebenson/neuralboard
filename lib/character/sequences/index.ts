import { kneeToFaceSequence } from "./knee-to-face.ts";
import { trenchCoatRevealSequence } from "./trench-coat-reveal.ts";
import type { CharacterSequence } from "./types.ts";

export * from "./types.ts";
export * from "./runtime.ts";
export { kneeToFaceSequence } from "./knee-to-face.ts";
export { trenchCoatRevealSequence } from "./trench-coat-reveal.ts";

/**
 * Sequence registration point. The harness and board action UI consume this list; neither keeps
 * its own sequence list. Import a sequence module and add it here once to expose it everywhere.
 */
export const characterSequences = [kneeToFaceSequence, trenchCoatRevealSequence] as const satisfies readonly CharacterSequence[];

export const characterSequenceById: Readonly<Record<string, CharacterSequence>> = Object.fromEntries(
  characterSequences.map((sequence) => [sequence.id, sequence]),
);
