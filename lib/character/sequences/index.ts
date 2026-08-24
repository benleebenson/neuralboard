import { kneeToFaceSequence } from "./knee-to-face.ts";
import type { CharacterSequence } from "./types.ts";

export * from "./types.ts";
export * from "./runtime.ts";
export { kneeToFaceSequence } from "./knee-to-face.ts";

export const characterSequences = [kneeToFaceSequence] as const satisfies readonly CharacterSequence[];

export const characterSequenceById: Readonly<Record<string, CharacterSequence>> = Object.fromEntries(
  characterSequences.map((sequence) => [sequence.id, sequence]),
);
