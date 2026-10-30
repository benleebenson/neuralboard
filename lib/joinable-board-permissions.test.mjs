import test from "node:test";
import assert from "node:assert/strict";
import { checkJoinerUpdate, SIMPLE_BOARD_ITEMS_ONLY, withStoredBoardType } from "./joinable-board-permissions.ts";

const me = "a".repeat(64), other = "b".repeat(64);
const board = () => ({
  clips: [{ id: "owner-img", type: "image", boardX: 0, boardY: 0, sourceUrl: "/x" }, { id: "my-img", type: "image", boardX: 5, boardY: 5, addedBy: me }],
  annotations: [{ id: "owner-note", type: "text", text: "hi", boardX: 1, boardY: 1 }],
  boardDimensions: { width: 4000, height: 3000 },
  boardColor: "#f5e3c0",
  canvasAspect: "16:9",
});

test("a joiner can add, move and remove their own items", () => {
  const next = board();
  next.clips[1] = { ...next.clips[1], boardX: 50 };
  next.annotations.push({ id: "new-note", type: "text", text: "yo", boardX: 9, boardY: 9, addedBy: me });
  next.clips.push({ id: "new-img", type: "image", boardX: 3, boardY: 3, addedBy: me });
  const result = checkJoinerUpdate(board(), next, me);
  assert.equal(result.ok, true);
  assert.equal(result.state.clips[1].boardX, 50);
  assert.equal(result.state.annotations.length, 2);
  const removed = board(); removed.clips.splice(1, 1);
  assert.equal(checkJoinerUpdate(board(), removed, me).ok, true);
});

test("a joiner can't change board settings", () => {
  for (const change of [{ boardColor: "#000000" }, { canvasAspect: "9:16" }, { boardDimensions: { width: 8000, height: 3000 } }]) {
    const result = checkJoinerUpdate(board(), { ...board(), ...change }, me);
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.error, /owner/);
  }
});

test("a joiner can't move, edit or delete what others added", () => {
  const moved = board(); moved.clips[0] = { ...moved.clips[0], boardX: 99 };
  assert.equal(checkJoinerUpdate(board(), moved, me).ok, false);
  const edited = board(); edited.annotations[0] = { ...edited.annotations[0], text: "changed" };
  assert.equal(checkJoinerUpdate(board(), edited, me).ok, false);
  const deleted = board(); deleted.annotations = [];
  assert.equal(checkJoinerUpdate(board(), deleted, me).ok, false);
  const stolen = board(); stolen.clips[0] = { ...stolen.clips[0], addedBy: me };
  assert.equal(checkJoinerUpdate(board(), stolen, me).ok, false);
  assert.equal(checkJoinerUpdate(board(), board(), other).ok, true, "an unchanged board is always accepted");
  const theirs = board(); theirs.clips[1] = { ...theirs.clips[1], boardX: 1 };
  assert.equal(checkJoinerUpdate(board(), theirs, other).ok, false, "someone else can't move my item");
});

test("a joiner can't add timeline clips or items tagged as someone else's", () => {
  const narration = board(); narration.clips.push({ id: "n", type: "narration", addedBy: me });
  assert.equal(checkJoinerUpdate(board(), narration, me).ok, false);
  const forged = board(); forged.clips.push({ id: "f", type: "image", boardX: 1, addedBy: other });
  assert.equal(checkJoinerUpdate(board(), forged, me).ok, false);
});

test("values a browser derives locally never count as a change, and aren't stored", () => {
  const next = board(); next.clips[0] = { ...next.clips[0], sourceDurationSec: 12 };
  const result = checkJoinerUpdate(board(), next, me);
  assert.equal(result.ok, true);
  assert.equal(result.state.clips[0].sourceDurationSec, undefined);
});

test("a setting the board doesn't have yet stays unset", () => {
  const prev = board(); delete prev.boardColor;
  const result = checkJoinerUpdate(prev, { ...board(), boardColor: "#123456" }, me);
  assert.equal(result.ok, true);
  assert.equal(result.state.boardColor, undefined);
});

test("sticky notes follow the same rules as other items, with a valid color", () => {
  const withNotes = () => ({ ...board(), annotations: [...board().annotations,
    { id: "owner-sticky", type: "sticky", text: "owner", noteColor: "#FFE58A", boardX: 0, boardY: 0, boardW: 200, boardH: 200 },
    { id: "my-sticky", type: "sticky", text: "mine", noteColor: "#BFE3FF", boardX: 9, boardY: 9, boardW: 200, boardH: 200, addedBy: me },
  ] });
  const added = withNotes(); added.annotations.push({ id: "new-sticky", type: "sticky", text: "hi", noteColor: "#FFC2D4", boardX: 1, boardY: 1, boardW: 200, boardH: 200, addedBy: me });
  assert.equal(checkJoinerUpdate(withNotes(), added, me).ok, true);
  const mine = withNotes(); mine.annotations[2] = { ...mine.annotations[2], boardX: 400, text: "edited", noteColor: "#BDF0C8" };
  assert.equal(checkJoinerUpdate(withNotes(), mine, me).ok, true, "move, retype and recolor my own note");
  const recolored = withNotes(); recolored.annotations[1] = { ...recolored.annotations[1], noteColor: "#BDF0C8" };
  assert.equal(checkJoinerUpdate(withNotes(), recolored, me).ok, false, "recolor someone else's note");
  const moved = withNotes(); moved.annotations[1] = { ...moved.annotations[1], boardX: 500 };
  assert.equal(checkJoinerUpdate(withNotes(), moved, me).ok, false, "move someone else's note");
  const deleted = withNotes(); deleted.annotations.splice(1, 1);
  assert.equal(checkJoinerUpdate(withNotes(), deleted, me).ok, false, "delete someone else's note");
  const badColor = withNotes(); badColor.annotations.push({ id: "x", type: "sticky", text: "x", noteColor: "url(javascript:1)", boardX: 1, boardY: 1, addedBy: me });
  assert.equal(checkJoinerUpdate(withNotes(), badColor, me).ok, false);
  const longText = withNotes(); longText.annotations.push({ id: "y", type: "sticky", text: "z".repeat(5000), noteColor: "#FFE58A", boardX: 1, boardY: 1, addedBy: me });
  assert.equal(checkJoinerUpdate(withNotes(), longText, me).ok, false);
});

test("emoji annotations: a joiner adds and changes their own, never someone else's", () => {
  const withEmoji = () => ({ ...board(), annotations: [...board().annotations,
    { id: "owner-emoji", type: "emoji", emoji: "🎯", boardX: 1, boardY: 1, boardW: 120, boardH: 120 },
    { id: "my-emoji", type: "emoji", emoji: "😂", boardX: 2, boardY: 2, boardW: 120, boardH: 120, addedBy: me }] });
  const added = withEmoji(); added.annotations.push({ id: "new-emoji", type: "emoji", emoji: "👨‍👩‍👧‍👦", boardX: 3, boardY: 3, boardW: 120, boardH: 120, addedBy: me });
  assert.equal(checkJoinerUpdate(withEmoji(), added, me).ok, true, "add any emoji, including ZWJ sequences");
  const unmarked = withEmoji(); unmarked.annotations.push({ id: "sneaky", type: "emoji", emoji: "🔥", boardX: 3, boardY: 3, addedBy: other });
  assert.equal(checkJoinerUpdate(withEmoji(), unmarked, me).ok, false, "add one marked as someone else's");
  const mine = withEmoji(); mine.annotations[2] = { ...mine.annotations[2], emoji: "🏴‍☠️", boardX: 300 };
  assert.equal(checkJoinerUpdate(withEmoji(), mine, me).ok, true, "swap and move my own emoji");
  const swapped = withEmoji(); swapped.annotations[1] = { ...swapped.annotations[1], emoji: "💀" };
  assert.equal(checkJoinerUpdate(withEmoji(), swapped, me).ok, false, "swap someone else's emoji");
  const moved = withEmoji(); moved.annotations[1] = { ...moved.annotations[1], boardX: 400 };
  assert.equal(checkJoinerUpdate(withEmoji(), moved, me).ok, false, "move someone else's emoji");
  const deleted = withEmoji(); deleted.annotations.splice(1, 1);
  assert.equal(checkJoinerUpdate(withEmoji(), deleted, me).ok, false, "delete someone else's emoji");
});

test("sticky threads: anyone replies, only the owner deletes a thread with other people's replies", () => {
  const note = (id, addedBy, parentId) => ({ id, type: "sticky", text: id, noteColor: "#FFE58A", boardX: 0, boardY: 0, boardW: 200, boardH: 200, ...(addedBy ? { addedBy } : {}), ...(parentId ? { parentId } : {}) });
  const withThread = () => ({ ...board(), annotations: [note("owner-root"), note("my-root", me), note("their-reply", other, "my-root")] });
  const reply = withThread(); reply.annotations.push(note("my-reply", me, "owner-root"));
  assert.equal(checkJoinerUpdate(withThread(), reply, me).ok, true, "reply to someone else's note");
  const badParent = withThread(); badParent.annotations.push({ ...note("x", me), parentId: { id: "owner-root" } });
  assert.equal(checkJoinerUpdate(withThread(), badParent, me).ok, false, "parentId must be a string");
  const stranded = withThread(); stranded.annotations.splice(1, 1);
  assert.deepEqual(checkJoinerUpdate(withThread(), stranded, me), { ok: false, error: "Only the board owner can delete a note that has other people's replies." });
  const ownThread = () => ({ ...board(), annotations: [note("my-root", me), note("my-reply", me, "my-root")] });
  const both = ownThread(); both.annotations = [];
  assert.equal(checkJoinerUpdate(ownThread(), both, me).ok, true, "delete my own thread");
  const leaveMine = ownThread(); leaveMine.annotations.splice(0, 1);
  assert.equal(checkJoinerUpdate(ownThread(), leaveMine, me).ok, true, "my own leftover reply just becomes top-level");
});

test("old-school boards: a joiner adds sticky notes and photos, nothing else", () => {
  const simple = () => ({ ...board(), boardType: "simple" });
  const sticky = { id: "s", type: "sticky", text: "idea", noteColor: "#FFE58A", boardX: 1, boardY: 1, boardW: 200, boardH: 200, addedBy: me };
  const photo = { id: "p", type: "image", boardX: 2, boardY: 2, sourceUrl: "/p.webp", addedBy: me };
  const ok = simple(); ok.annotations.push(sticky); ok.clips.push(photo);
  assert.equal(checkJoinerUpdate(simple(), ok, me).ok, true);
  for (const [kind, item] of [
    ["clips", { id: "v", type: "video", boardX: 1, boardY: 1, sourceUrl: "/v.mp4", addedBy: me }],
    ["annotations", { id: "t", type: "text", text: "plain", boardX: 1, boardY: 1, addedBy: me }],
    ["annotations", { id: "e", type: "emoji", emoji: "🔥", boardX: 1, boardY: 1, addedBy: me }],
    ["annotations", { id: "d", type: "pen", boardX: 1, boardY: 1, addedBy: me }],
  ]) {
    const next = simple(); next[kind].push(item);
    assert.deepEqual(checkJoinerUpdate(simple(), next, me), { ok: false, error: SIMPLE_BOARD_ITEMS_ONLY }, item.type);
  }
  const withMine = () => ({ ...simple(), annotations: [...board().annotations, sticky] });
  const retyped = withMine(); retyped.annotations[1] = { ...sticky, type: "text" };
  assert.deepEqual(checkJoinerUpdate(withMine(), retyped, me), { ok: false, error: SIMPLE_BOARD_ITEMS_ONLY }, "turn my note into plain text");
  const video = board(); video.clips.push({ id: "v", type: "video", boardX: 1, boardY: 1, addedBy: me });
  assert.equal(checkJoinerUpdate(board(), video, me).ok, true, "a Neural board still takes video");
});

test("old-school boards: a joiner can't change the board type, and the stored type decides", () => {
  const simple = () => ({ ...board(), boardType: "simple" });
  const upgraded = { ...simple(), boardType: "neural" };
  assert.match(checkJoinerUpdate(simple(), upgraded, me).error, /owner/);
  const forged = { ...board(), boardType: "neural" };
  forged.clips.push({ id: "v", type: "video", boardX: 1, boardY: 1, addedBy: me });
  assert.equal(checkJoinerUpdate(simple(), forged, me).ok, false, "claiming neural doesn't unlock video");
  const untyped = simple(); delete untyped.boardType;
  const result = checkJoinerUpdate(simple(), untyped, me);
  assert.equal(result.ok, true, "a tab from before board types leaves it out");
  assert.equal(result.state.boardType, "simple");
  const down = { ...board(), boardType: "neural" };
  assert.match(checkJoinerUpdate(down, { ...down, boardType: "simple" }, me).error, /owner/);
});

test("a save keeps the stored board type, except the owner turning old school into Neural", () => {
  assert.equal(withStoredBoardType({ boardType: "simple" }, { clips: [] }).boardType, "simple");
  assert.equal(withStoredBoardType({ boardType: "simple" }, { boardType: "neural" }).boardType, "neural");
  assert.equal(withStoredBoardType({ boardType: "neural" }, { boardType: "simple" }).boardType, "neural");
  assert.equal(withStoredBoardType({}, { boardType: "simple" }).boardType, "simple", "a board from before types takes what's saved");
  assert.equal(withStoredBoardType(null, { clips: [] }).boardType, undefined);
});
