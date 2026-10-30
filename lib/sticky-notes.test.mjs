import test from "node:test";
import assert from "node:assert/strict";
import { layoutStickyNote, STICKY_NOTE_PADDING_EM, STICKY_NOTE_RADIUS_EM, stickyNoteFrame, stickyNoteTypingFrame, stickyNoteWrapWidth, wrapStickyNoteText } from "./sticky-notes.ts";

const box = { boardX: 0, boardY: 0, boardW: 700, boardH: 700 };
const pad = 100 * STICKY_NOTE_PADDING_EM;
// Every character is 50 board units wide.
const measure = (text) => text.length * 50;

test("a note hugs its text, centered in its box, with rounded corners", () => {
  const frame = stickyNoteFrame(box, [300, 200], 100, 1.2);
  assert.equal(frame.boardW, 300 + pad * 2);
  assert.equal(frame.boardH, 240 + pad * 2);
  assert.equal(frame.boardX + frame.boardW / 2, 350);
  assert.equal(frame.boardY + frame.boardH / 2, 350);
  assert.equal(frame.radius, 100 * STICKY_NOTE_RADIUS_EM);
});

test("a note taller than its box runs down past it from the box's top, never cropped", () => {
  const frame = stickyNoteFrame({ ...box, boardH: 150 }, [300, 300, 300, 300], 100, 1.2);
  assert.equal(frame.boardY, 0);
  assert.equal(frame.boardH, 480 + pad * 2);
});

test("an empty note is one line tall, even in a box too small for it", () => {
  const frame = stickyNoteFrame(box, [], 100, 1.2);
  assert.equal(frame.boardH, 120 + pad * 2);
  const tiny = stickyNoteFrame({ ...box, boardW: 40, boardH: 40 }, [], 100, 1.2);
  assert.deepEqual([tiny.boardW, tiny.boardH], [100 + pad * 2, 120 + pad * 2]);
  assert.ok(tiny.radius <= tiny.boardW / 2);
});

test("text wraps at the box less padding, and a word too long for a line is split", () => {
  assert.equal(stickyNoteWrapWidth(700, 100), 700 - pad * 2);
  assert.deepEqual(wrapStickyNoteText("aa bb cc", 250, measure), ["aa bb", "cc"]);
  assert.deepEqual(wrapStickyNoteText("aaaaaaaaaaaa b", 250, measure), ["aaaaa", "aaaaa", "aa", "b"]);
  // However narrow, each line takes at least one character.
  assert.deepEqual(wrapStickyNoteText("abc", 10, measure), ["a", "b", "c"]);
});

test("a long note is a column as wide as its box and as tall as all its text", () => {
  const text = "word ".repeat(200).trim();
  const { lines, frame } = layoutStickyNote(box, text, 100, measure);
  const wrap = stickyNoteWrapWidth(box.boardW, 100);
  assert.ok(lines.every((line) => measure(line) <= wrap));
  assert.equal(lines.join(" "), text);
  assert.ok(frame.boardW <= box.boardW);
  assert.equal(frame.boardH, lines.length * 120 + pad * 2);
  assert.ok(frame.boardH > box.boardH);
});

test("a short note shrinks to its text", () => {
  const { lines, frame } = layoutStickyNote(box, "hi", 100, measure);
  assert.deepEqual(lines, ["hi"]);
  assert.equal(frame.boardW, 100 + pad * 2);
  assert.equal(frame.boardH, 120 + pad * 2);
});

test("while typing, the note is the whole box, growing down with a spare line", () => {
  assert.deepEqual(stickyNoteTypingFrame(box, 2, 100), { ...box, radius: 100 * STICKY_NOTE_RADIUS_EM });
  const tall = stickyNoteTypingFrame(box, 10, 100);
  assert.equal(tall.boardY, 0);
  assert.equal(tall.boardW, 700);
  assert.equal(tall.boardH, 11 * 120 + pad * 2);
});
