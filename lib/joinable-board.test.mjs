import test from "node:test";
import assert from "node:assert/strict";
import { generateJoinCode, mergeJoinableStates, normalizeJoinCode, stableStringify, validJoinCode } from "./joinable-board.ts";
import { threadDepths } from "./sticky-threads.ts";

test("join codes normalize for easy entry across devices", () => {
  assert.equal(normalizeJoinCode(" ab-c 12!3 "), "ABC123");
  assert.equal(validJoinCode("ABC123"), true);
  assert.equal(validJoinCode("ABC12"), false);
});

test("generated join codes are six unambiguous characters", () => {
  for (let index = 0; index < 100; index++) assert.match(generateJoinCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});

test("stableStringify ignores key order, like a jsonb round trip", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 3 } }), stableStringify({ a: { c: 3, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("merging keeps both people's edits to different items", () => {
  const dims = { width: 4000, height: 3000 };
  const base = { clips: [{ id: "a", x: 1 }, { id: "b", x: 1 }, { id: "c", x: 1 }], annotations: [], boardDimensions: dims };
  const mine = { clips: [{ id: "a", x: 2 }, { id: "b", x: 1 }, { id: "new-mine", x: 0 }], annotations: [], boardDimensions: dims, canvasAspect: "9:16" };
  const theirs = { clips: [{ id: "a", x: 1 }, { id: "b", x: 5 }, { id: "c", x: 1 }, { id: "new-theirs", x: 0 }], annotations: [{ id: "n" }], boardDimensions: dims, canvasAspect: "16:9" };
  const merged = mergeJoinableStates(base, mine, theirs);
  assert.deepEqual(merged.clips, [{ id: "a", x: 2 }, { id: "b", x: 5 }, { id: "new-theirs", x: 0 }, { id: "new-mine", x: 0 }]);
  assert.deepEqual(merged.annotations, [{ id: "n" }]);
  assert.equal(merged.canvasAspect, "9:16");
});

test("merging with no local changes is just the newer state", () => {
  const base = { clips: [{ id: "a" }], annotations: [], boardDimensions: { width: 1, height: 1 } };
  const theirs = { clips: [{ id: "b" }], annotations: [], boardDimensions: { width: 2, height: 2 }, showCharacter: true };
  assert.equal(stableStringify(mergeJoinableStates(base, base, theirs)), stableStringify(theirs));
});

test("merging keeps a reply whose parent was deleted at the same time", () => {
  const base = { clips: [], annotations: [{ id: "root", type: "sticky" }] };
  const mine = { clips: [], annotations: [{ id: "root", type: "sticky" }, { id: "reply", type: "sticky", parentId: "root" }] };
  const theirs = { clips: [], annotations: [] };
  const merged = mergeJoinableStates(base, mine, theirs);
  assert.deepEqual(merged.annotations, [{ id: "reply", type: "sticky", parentId: "root" }]);
  assert.equal(threadDepths(merged.annotations).get("reply"), 0, "drawn as a top-level note");
});
