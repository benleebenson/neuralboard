// Sticky notes: a block of text on a colored note, placed on the board like any annotation.
// The palette is fixed so every board (and the server's joiner check) agrees on it.

import { ANNOTATION_LINE_HEIGHT, layoutAnnotationText, type AnnotationTextMeasurer } from "./board2/annotation-text-layout.ts";

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
type NoteFrame = NoteBox & { radius: number };

// A note always shows all of its text, as the original boards' notes did (a shrink-to-fit box
// with a max width, wrapping even inside long words, and no height limit). Here the max width is
// the note's own box width, less padding: the text wraps there and the note grows taller instead.

/** The width a note's text wraps at, in board units: its box less padding. */
export function stickyNoteWrapWidth(boardW: number, fontSize: number): number {
  return Math.max(1, boardW - fontSize * STICKY_NOTE_PADDING_EM * 2);
}

/**
 * A note's text as lines no wider than `maxWidth`: wrapped at spaces like other board text, and
 * a word too long for a line is split across lines so it never runs off the note.
 */
export function wrapStickyNoteText(text: string, maxWidth: number, measureText: AnnotationTextMeasurer): string[] {
  const lines: string[] = [];
  for (const line of layoutAnnotationText(text, maxWidth, measureText)) {
    if (measureText(line) <= maxWidth) { lines.push(line); continue; }
    let piece = "";
    for (const char of line) {
      // A line always takes at least one character, however narrow the note.
      if (piece && measureText(piece + char) > maxWidth) { lines.push(piece); piece = ""; }
      piece += char;
    }
    lines.push(piece);
  }
  return lines;
}

/**
 * The rounded rectangle a note is drawn as: hugging its wrapped text (which wraps within the box,
 * so it's only wider than the box when one character is), centered across its box (so rotation
 * and thread lines still meet its middle), and as tall as its text needs. It's
 * centered in the box when it fits; when the box is too short, it starts at the box's top and
 * runs past its bottom rather than cropping. `lineWidths` are the wrapped lines' widths in board
 * units; with none, the note is one empty line tall.
 */
export function stickyNoteFrame(box: NoteBox, lineWidths: readonly number[], fontSize: number, lineHeight: number): NoteFrame {
  const pad = fontSize * STICKY_NOTE_PADDING_EM;
  const textW = Math.max(fontSize, ...lineWidths);
  const textH = Math.max(1, lineWidths.length) * fontSize * lineHeight;
  const w = textW + pad * 2, h = textH + pad * 2;
  return {
    boardX: box.boardX + (box.boardW - w) / 2,
    boardY: box.boardY + Math.max(0, (box.boardH - h) / 2),
    boardW: w,
    boardH: h,
    radius: Math.min(fontSize * STICKY_NOTE_RADIUS_EM, w / 2, h / 2),
  };
}

/**
 * A note's wrapped lines and the frame they're drawn in. The board, the typing view's height and
 * the export all come from this, so they wrap the same. `measureText` gives widths in board units
 * at the note's font size.
 */
export function layoutStickyNote(box: NoteBox, text: string, fontSize: number, measureText: AnnotationTextMeasurer): { lines: string[]; frame: NoteFrame } {
  const lines = text ? wrapStickyNoteText(text, stickyNoteWrapWidth(box.boardW, fontSize), measureText) : [];
  return { lines, frame: stickyNoteFrame(box, lines.map(measureText), fontSize, ANNOTATION_LINE_HEIGHT) };
}

/**
 * The note while it's being typed in: the box's full width (where the text wraps) and tall enough
 * for every line plus one more, so the caret and a line the browser wraps a little differently
 * stay inside it. It grows downward from the box's top.
 */
export function stickyNoteTypingFrame(box: NoteBox, lineCount: number, fontSize: number): NoteFrame {
  const pad = fontSize * STICKY_NOTE_PADDING_EM;
  const h = Math.max(box.boardH, (Math.max(1, lineCount) + 1) * fontSize * ANNOTATION_LINE_HEIGHT + pad * 2);
  return { ...box, boardH: h, radius: Math.min(fontSize * STICKY_NOTE_RADIUS_EM, box.boardW / 2, h / 2) };
}

// Likes make a note bigger, as votes did on the original boards (there each vote added half the
// note's size, up to 6×; here up to 3×), so popular notes loom over the rest. Display only: the
// stored note keeps its size, so permissions and merging never see it.
export const STICKY_NOTE_SCALE_PER_LIKE = 0.5;
export const STICKY_NOTE_MAX_SCALE = 3;

export function stickyNoteLikeScale(likeCount: number): number {
  return Math.min(STICKY_NOTE_MAX_SCALE, 1 + STICKY_NOTE_SCALE_PER_LIKE * Math.max(0, likeCount));
}

type DisplayItem = NoteBox & { id: string; type: string; fontSize?: number };

/** A note scaled about its middle, text and all (the board's notes default to an 80-unit font). */
export function scaleStickyNote<T extends DisplayItem>(note: T, scale: number): T {
  if (scale === 1) return note;
  const w = note.boardW * scale, h = note.boardH * scale;
  return {
    ...note,
    boardX: note.boardX + (note.boardW - w) / 2,
    boardY: note.boardY + (note.boardH - h) / 2,
    boardW: w,
    boardH: h,
    fontSize: (note.fontSize ?? 80) * scale,
  };
}

/**
 * The board's items as they're shown: sticky notes bigger by their likes, everything else as
 * stored. The board and the export both draw from this, so they agree.
 */
export function stickyNotesForDisplay<T extends DisplayItem>(items: readonly T[], likes: Readonly<Record<string, readonly unknown[]>>): T[] {
  return items.map((item) => item.type === "sticky" ? scaleStickyNote(item, stickyNoteLikeScale(likes[item.id]?.length ?? 0)) : item);
}
