import test from "node:test";
import assert from "node:assert/strict";
import { isStickyNoteImage, layoutStickyNote, pushStickyNotesApart, scaleStickyNote, STICKY_NOTE_PADDING_EM, STICKY_NOTE_PICTURE_MAX_TALL, STICKY_NOTE_RADIUS_EM, stickyNoteFrame, stickyNoteLikeScale, stickyNotePictureSize, stickyNotesForDisplay, stickyNoteTypingFrame, stickyNoteWrapWidth, wrapStickyNoteText } from "./sticky-notes.ts";

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

test("each like makes a note half again as big, up to 3×", () => {
  assert.deepEqual([0, 1, 2, 4, 10].map(stickyNoteLikeScale), [1, 1.5, 2, 3, 3]);
});

test("a liked note grows about its middle, text and all; other items and stored notes are untouched", () => {
  const note = { id: "n", type: "sticky", boardX: 100, boardY: 100, boardW: 200, boardH: 100, fontSize: 40 };
  const pen = { id: "p", type: "pen", boardX: 0, boardY: 0, boardW: 10, boardH: 10 };
  const [shown, shownPen] = stickyNotesForDisplay([note, pen], { n: ["a", "b"], p: ["a"] });
  assert.deepEqual(shown, { ...note, boardX: 0, boardY: 50, boardW: 400, boardH: 200, fontSize: 80 });
  assert.equal(shownPen, pen);
  assert.equal(note.boardW, 200);
  assert.equal(stickyNotesForDisplay([note], {})[0], note);
  assert.equal(scaleStickyNote({ ...note, fontSize: undefined }, 2).fontSize, 160);
});

const rect = (id, x, y, w = 100, h = 100) => ({ id, x, y, w, h, gap: 0 });
const overlaps = (a, b, oa, ob) => {
  const ax = a.x + oa.dx, ay = a.y + oa.dy, bx = b.x + ob.dx, by = b.y + ob.dy;
  return ax < bx + b.w - 0.5 && bx < ax + a.w - 0.5 && ay < by + b.h - 0.5 && by < ay + a.h - 0.5;
};

test("overlapping notes push each other apart, equally, along the way they overlap least", () => {
  const a = rect("a", 0, 0), b = rect("b", 60, 10);
  const offsets = pushStickyNotesApart([a, b]);
  assert.ok(!overlaps(a, b, offsets.get("a"), offsets.get("b")));
  assert.ok(Math.abs(offsets.get("a").dx + offsets.get("b").dx) < 1e-9);
  assert.ok(offsets.get("a").dx < 0 && offsets.get("b").dx > 0);
  assert.equal(offsets.get("a").dy, 0);
});

test("notes that don't overlap stay put, and a pinned note doesn't move", () => {
  const apart = pushStickyNotesApart([rect("a", 0, 0), rect("b", 200, 0)]);
  assert.deepEqual([...apart.values()], [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  const pinned = pushStickyNotesApart([rect("a", 0, 0), rect("b", 60, 0)], new Set(["a"]));
  assert.deepEqual(pinned.get("a"), { dx: 0, dy: 0 });
  assert.ok(pinned.get("b").dx > 30);
});

test("a pile of notes spreads out the same way every time", () => {
  const pile = Array.from({ length: 12 }, (_, i) => rect(`n${i}`, (i % 4) * 30, Math.floor(i / 4) * 30));
  const first = pushStickyNotesApart(pile);
  assert.deepEqual(pushStickyNotesApart(pile), first);
  const stacked = pushStickyNotesApart([rect("a", 0, 0), rect("b", 0, 0)]);
  assert.ok(!overlaps(rect("a", 0, 0), rect("b", 0, 0), stacked.get("a"), stacked.get("b")));
});

test("the shown board pushes sticky notes by their frames and leaves other items alone", () => {
  const notes = [
    { id: "a", type: "sticky", boardX: 0, boardY: 0, boardW: 100, boardH: 100, fontSize: 10 },
    { id: "b", type: "sticky", boardX: 50, boardY: 0, boardW: 100, boardH: 100, fontSize: 10 },
    { id: "p", type: "pen", boardX: 50, boardY: 0, boardW: 100, boardH: 100 },
  ];
  const frameOf = (note) => ({ boardX: note.boardX, boardY: note.boardY, boardW: note.boardW, boardH: note.boardH });
  const [a, b, pen] = stickyNotesForDisplay(notes, {}, frameOf);
  assert.ok(b.boardX - (a.boardX + 100) > 0);
  assert.equal(pen, notes[2]);
  assert.equal(notes[0].boardX, 0);
  // A pinned note stays where it's stored.
  const [pinnedA] = stickyNotesForDisplay(notes, {}, frameOf, new Set(["a"]));
  assert.equal(pinnedA.boardX, 0);
});

test("a picture post: the picture spans the note's text width, above its text, in one frame", () => {
  const wrap = stickyNoteWrapWidth(box.boardW, 100);
  const picture = stickyNotePictureSize(box.boardW, 100, { width: 1600, height: 900 });
  assert.equal(picture.w, wrap);
  assert.equal(picture.h, wrap * 900 / 1600);
  const withText = layoutStickyNote(box, "hi", 100, measure, { width: 1600, height: 900 });
  assert.equal(withText.frame.boardW, wrap + pad * 2, "as wide as the picture, wider than the text");
  assert.equal(withText.frame.boardH, pad + picture.h + pad + 120 + pad);
  assert.deepEqual(
    [withText.picture.boardX, withText.picture.boardY, withText.picture.boardW, withText.picture.boardH],
    [withText.frame.boardX + pad, withText.frame.boardY + pad, picture.w, picture.h],
  );
  assert.equal(withText.textY, withText.frame.boardY + pad + picture.h + pad, "text sits below the picture");
  assert.equal(withText.textX, withText.frame.boardX + pad);
  assert.equal(withText.picture.radius, withText.frame.radius - pad, "corners concentric with the note's");
  const only = layoutStickyNote(box, "", 100, measure, { width: 1600, height: 900 });
  assert.deepEqual(only.lines, []);
  assert.equal(only.frame.boardH, picture.h + pad * 2, "a picture alone is framed by the padding");
});

test("a tall picture is narrower, never taller than its share of the note's width", () => {
  const wrap = stickyNoteWrapWidth(box.boardW, 100);
  const tall = stickyNotePictureSize(box.boardW, 100, { width: 500, height: 2000 });
  assert.equal(tall.h, wrap * STICKY_NOTE_PICTURE_MAX_TALL);
  assert.equal(tall.w, tall.h / 4);
  const { frame, picture } = layoutStickyNote(box, "", 100, measure, { width: 500, height: 2000 });
  assert.equal(frame.boardX + frame.boardW / 2, 350, "still centered on its box");
  assert.equal(picture.boardX + picture.boardW / 2, 350);
  assert.equal(stickyNotePictureSize(box.boardW, 100, null), null);
  assert.equal(stickyNotePictureSize(box.boardW, 100, { width: 0, height: 10 }), null);
  assert.equal(layoutStickyNote(box, "hi", 100, measure).picture, null, "a plain note has no picture");
});

test("a picture note scaled by likes keeps its picture in proportion", () => {
  const note = { id: "n", type: "sticky", boardX: 0, boardY: 0, boardW: 700, boardH: 700, fontSize: 100 };
  const big = scaleStickyNote(note, 2);
  const small = stickyNotePictureSize(note.boardW, note.fontSize, { width: 4, height: 3 });
  const large = stickyNotePictureSize(big.boardW, big.fontSize, { width: 4, height: 3 });
  assert.equal(large.w, small.w * 2);
  assert.equal(large.h, small.h * 2);
});

test("while typing, a picture note keeps its picture above the text", () => {
  const picture = stickyNotePictureSize(box.boardW, 100, { width: 1, height: 1 });
  const frame = stickyNoteTypingFrame({ ...box, boardH: 100 }, 2, 100, { width: 1, height: 1 });
  assert.equal(frame.boardH, picture.h + pad + 3 * 120 + pad * 2);
});

test("note pictures must be this board's shared media", () => {
  const url = "/api/joinable-board/media/ABC234/0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(isStickyNoteImage({ url, width: 800, height: 600 }), true);
  assert.equal(isStickyNoteImage({ url, width: 800, height: 600, animated: true }, "ABC234"), true);
  assert.equal(isStickyNoteImage({ url, width: 800, height: 600 }, "ZZZ999"), false, "another board's media");
  for (const forged of [
    { url: "https://evil.example/pixel.gif", width: 1, height: 1 },
    { url: "javascript:alert(1)", width: 1, height: 1 },
    { url: "data:image/png;base64,AAAA", width: 1, height: 1 },
    { url: `${url}?x=1`, width: 1, height: 1 },
    { url: `${url}/../../other`, width: 1, height: 1 },
    { url: `//evil.example${url}`, width: 1, height: 1 },
    { url: "/api/joinable-board/media/ABC234/0f8fad5b-d9cb-469f-a165-70867728950e.mp4", width: 1, height: 1 },
    { url, width: 0, height: 600 },
    { url, width: 1e9, height: 600 },
    { url, width: "800", height: 600 },
    { url, width: 800, height: 600, animated: "yes" },
    { url, width: 800, height: 600, style: "x" },
    [url],
    url,
    null,
  ]) assert.equal(isStickyNoteImage(forged), false, JSON.stringify(forged));
});
