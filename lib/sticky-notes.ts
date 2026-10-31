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

// Notes make room for each other, as the original boards' notes did: a collision-relaxation
// pass in which each overlapping pair pushes itself apart, a share of the overlap at a time.
// Display only, like the like scaling: stored positions are untouched.
export const STICKY_PUSH_ITERATIONS = 30;
export const STICKY_PUSH_STIFFNESS = 0.25;
/** The gap pushed notes keep between them, as a share of the larger one's font size. */
export const STICKY_PUSH_GAP_EM = 0.3;

export type PushRect = { id: string; x: number; y: number; w: number; h: number; gap: number };

/**
 * How far to shift each rectangle so overlapping ones stand apart. Each pass, an overlapping pair
 * is pushed apart along the axis it overlaps least, by STICKY_PUSH_STIFFNESS of the overlap,
 * shared equally; a pinned rectangle (one being dragged) doesn't move and the other takes the
 * whole push. The result depends only on the input, so every board and the export agree.
 */
export function pushStickyNotesApart(rects: readonly PushRect[], pinned: ReadonlySet<string> = new Set()): Map<string, { dx: number; dy: number }> {
  const items = rects.map((rect) => ({ ...rect, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, pinned: pinned.has(rect.id) }));
  for (let pass = 0; pass < STICKY_PUSH_ITERATIONS; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.pinned && b.pinned) continue;
        const gap = Math.max(a.gap, b.gap);
        const ox = (a.w + b.w) / 2 + gap - Math.abs(b.cx - a.cx);
        const oy = (a.h + b.h) / 2 + gap - Math.abs(b.cy - a.cy);
        if (ox <= 0 || oy <= 0) continue;
        // Exactly level notes go apart in list order, so the result is still the same everywhere.
        const alongX = ox <= oy;
        const sign = (alongX ? b.cx - a.cx : b.cy - a.cy) < 0 ? -1 : 1;
        const push = (alongX ? ox : oy) * STICKY_PUSH_STIFFNESS * sign;
        const aShare = a.pinned ? 0 : b.pinned ? 1 : 0.5;
        if (alongX) { a.cx -= push * aShare; b.cx += push * (1 - aShare); }
        else { a.cy -= push * aShare; b.cy += push * (1 - aShare); }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(items.map((item) => [item.id, { dx: item.cx - item.x - item.w / 2, dy: item.cy - item.y - item.h / 2 }]));
}

// The last pushes worked out, by their input: the board asks again on every change to any item,
// and the export on every frame, but notes only move when the notes themselves change. Two, so
// the board mid-drag (with a pinned note) and a canvas drawing the board don't evict each other.
let recentPushes: { key: string; offsets: Map<string, { dx: number; dy: number }> }[] = [];

function pushStickyNotesApartCached(rects: readonly PushRect[], pinned: ReadonlySet<string>) {
  const key = JSON.stringify([rects.map(({ id, x, y, w, h, gap }) => [id, x, y, w, h, gap]), [...pinned].sort()]);
  const known = recentPushes.find((push) => push.key === key);
  if (known) return known.offsets;
  const offsets = pushStickyNotesApart(rects, pinned);
  recentPushes = [{ key, offsets }, ...recentPushes.slice(0, 1)];
  return offsets;
}

/**
 * The board's items as they're shown: sticky notes bigger by their likes and pushed apart where
 * they'd overlap, everything else as stored. `frameOf` gives a (shown) note's drawn frame, so
 * notes make room for what's visible rather than their boxes; `pinned` notes stay put (they're
 * being dragged). The board and the export both draw from this, so they agree.
 */
export function stickyNotesForDisplay<T extends DisplayItem>(
  items: readonly T[],
  likes: Readonly<Record<string, readonly unknown[]>>,
  frameOf?: (note: T) => NoteBox,
  pinned: ReadonlySet<string> = new Set(),
): T[] {
  const shown = items.map((item) => item.type === "sticky" ? scaleStickyNote(item, stickyNoteLikeScale(likes[item.id]?.length ?? 0)) : item);
  if (!frameOf) return shown;
  const rects = shown.flatMap((item): PushRect[] => {
    if (item.type !== "sticky") return [];
    const frame = frameOf(item);
    return [{ id: item.id, x: frame.boardX, y: frame.boardY, w: frame.boardW, h: frame.boardH, gap: (item.fontSize ?? 80) * STICKY_PUSH_GAP_EM }];
  });
  if (rects.length < 2) return shown;
  const offsets = pushStickyNotesApartCached(rects, pinned);
  return shown.map((item) => {
    const offset = offsets.get(item.id);
    return offset && (offset.dx || offset.dy) ? { ...item, boardX: item.boardX + offset.dx, boardY: item.boardY + offset.dy } : item;
  });
}
