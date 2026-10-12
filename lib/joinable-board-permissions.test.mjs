import test from "node:test";
import assert from "node:assert/strict";
import { checkJoinerUpdate } from "./joinable-board-permissions.ts";

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
