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

// A note's corners are rounded by this share of its font size, and its text sits inset from its
// edges by STICKY_NOTE_PADDING_EM of it.
export const STICKY_NOTE_RADIUS_EM = 0.6;
export const STICKY_NOTE_PADDING_EM = 0.45;

type NoteBox = { boardX: number; boardY: number; boardW: number; boardH: number };

/**
 * The rounded rectangle a note is drawn as: hugging its wrapped text rather than filling its
 * whole box, centered in that box (so rotation and thread lines still meet its middle), and
 * never bigger than it. `lineWidths` are the wrapped lines' widths in board units; with none,
 * the note is one empty line tall. The box itself is unchanged, so this is drawing only.
 */
export function stickyNoteFrame(box: NoteBox, lineWidths: readonly number[], fontSize: number, lineHeight: number): NoteBox & { radius: number } {
  const pad = fontSize * STICKY_NOTE_PADDING_EM;
  const textW = Math.max(fontSize, ...lineWidths);
  const textH = Math.max(1, lineWidths.length) * fontSize * lineHeight;
  const w = Math.min(box.boardW, textW + pad * 2), h = Math.min(box.boardH, textH + pad * 2);
  return {
    boardX: box.boardX + (box.boardW - w) / 2,
    boardY: box.boardY + (box.boardH - h) / 2,
    boardW: w,
    boardH: h,
    radius: Math.min(fontSize * STICKY_NOTE_RADIUS_EM, w / 2, h / 2),
  };
}
