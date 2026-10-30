import test from "node:test";
import assert from "node:assert/strict";
import { STICKY_NOTE_PADDING_EM, STICKY_NOTE_RADIUS_EM, stickyNoteFrame } from "./sticky-notes.ts";

const box = { boardX: 0, boardY: 0, boardW: 700, boardH: 700 };
const pad = 100 * STICKY_NOTE_PADDING_EM;

test("a note hugs its text, centered in its box, with rounded corners", () => {
  const frame = stickyNoteFrame(box, [300, 200], 100, 1.2);
  assert.equal(frame.boardW, 300 + pad * 2);
  assert.equal(frame.boardH, 240 + pad * 2);
  assert.equal(frame.boardX + frame.boardW / 2, 350);
  assert.equal(frame.boardY + frame.boardH / 2, 350);
  assert.equal(frame.radius, 100 * STICKY_NOTE_RADIUS_EM);
});

test("a note is never drawn bigger than its box", () => {
  const frame = stickyNoteFrame({ ...box, boardW: 200, boardH: 150 }, [900, 900, 900, 900], 100, 1.2);
  assert.deepEqual([frame.boardX, frame.boardY, frame.boardW, frame.boardH], [0, 0, 200, 150]);
});

test("an empty note is one line tall, and corners never round past half the note", () => {
  const frame = stickyNoteFrame(box, [], 100, 1.2);
  assert.equal(frame.boardH, 120 + pad * 2);
  const tiny = stickyNoteFrame({ ...box, boardW: 40, boardH: 40 }, [], 100, 1.2);
  assert.equal(tiny.radius, 20);
});
