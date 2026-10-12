// Sticky notes: a block of text on a colored note, placed on the board like any annotation.
// The palette is fixed so every board (and the server's joiner check) agrees on it.

export const STICKY_NOTE_COLORS = [
  { color: "#FFE58A", name: "Yellow" },
  { color: "#FFC9A8", name: "Orange" },
  { color: "#FFC2D4", name: "Pink" },
  { color: "#D9CBFF", name: "Purple" },
  { color: "#BFE3FF", name: "Blue" },
  { color: "#BDF0C8", name: "Green" },
] as const;

export const DEFAULT_STICKY_NOTE_COLOR = STICKY_NOTE_COLORS[0].color;
export const STICKY_NOTE_INK = "#2a2a2a";
/** Longest note text a joiner may save. */
export const STICKY_NOTE_MAX_TEXT = 2000;

const STICKY_NOTE_COLOR_SET: ReadonlySet<string> = new Set(STICKY_NOTE_COLORS.map(({ color }) => color));

export function isStickyNoteColor(value: unknown): value is string {
  return typeof value === "string" && STICKY_NOTE_COLOR_SET.has(value);
}
