import test from "node:test";
import assert from "node:assert/strict";
import { planThreadDelete, placeReply, threadDepths, threadDescendants, threadParents, threadShade, THREAD_DELETE_OWNER_ONLY } from "./sticky-threads.ts";

const me = "a".repeat(64), other = "b".repeat(64);
const thread = () => [
  { id: "root", addedBy: me },
  { id: "reply", parentId: "root", addedBy: me },
  { id: "deep", parentId: "reply", addedBy: other },
  { id: "loose", addedBy: other },
];

test("depth follows the parent chain to any depth", () => {
  const depths = threadDepths(thread());
  assert.deepEqual(Object.fromEntries(depths), { root: 0, reply: 1, deep: 2, loose: 0 });
});

test("a reply whose parent is gone, or that points at itself, is top-level", () => {
  const items = [{ id: "orphan", parentId: "deleted" }, { id: "self", parentId: "self" }, { id: "odd", parentId: 7 }];
  assert.equal(threadParents(items).size, 0);
  assert.deepEqual([...threadDepths(items).values()], [0, 0, 0]);
});

test("a cycle is broken rather than looping", () => {
  const items = [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }];
  const depths = threadDepths(items);
  assert.equal(depths.size, 2);
  assert.ok([...depths.values()].includes(0));
  assert.deepEqual([...threadDescendants(items, ["a"])], ["b"]);
});

test("descendants include every level below, but not the note itself", () => {
  assert.deepEqual([...threadDescendants(thread(), ["root"])].sort(), ["deep", "reply"]);
  assert.deepEqual([...threadDescendants(thread(), ["deep"])], []);
});

test("the owner can delete a whole thread", () => {
  const plan = planThreadDelete(thread(), ["root"], () => true);
  assert.equal(plan.ok, true);
  assert.deepEqual([...plan.ids].sort(), ["deep", "reply", "root"]);
});

test("a joiner can delete a thread of their own, not one with other people's replies", () => {
  const mine = (item) => item.addedBy === me;
  assert.deepEqual(planThreadDelete(thread(), ["root"], mine), { ok: false, error: THREAD_DELETE_OWNER_ONLY });
  const own = thread().filter((item) => item.id !== "deep");
  const plan = planThreadDelete(own, ["root"], mine);
  assert.equal(plan.ok, true);
  assert.deepEqual([...plan.ids].sort(), ["reply", "root"]);
});

test("shades get lighter by depth, stay hex, and stop short of white", () => {
  assert.equal(threadShade("#BFE3FF", 0), "#BFE3FF");
  const one = threadShade("#BFE3FF", 1), two = threadShade("#BFE3FF", 2), deep = threadShade("#BFE3FF", 40);
  assert.match(one, /^#[0-9A-F]{6}$/);
  const red = (hex) => parseInt(hex.slice(1, 3), 16);
  assert.ok(red("#BFE3FF") < red(one) && red(one) < red(two) && red(two) <= red(deep));
  assert.notEqual(deep, "#FFFFFF");
  assert.equal(threadShade("not a color", 3), "not a color");
});

test("a reply takes the first clear spot around its parent", () => {
  const parent = { boardX: 0, boardY: 0, boardW: 100, boardH: 100 };
  assert.deepEqual(placeReply(parent, [parent], 0), { boardX: 125, boardY: 0, boardW: 100, boardH: 100 });
  const right = { boardX: 125, boardY: 0, boardW: 100, boardH: 100 };
  assert.deepEqual(placeReply(parent, [parent, right], 1), { boardX: 0, boardY: 125, boardW: 100, boardH: 100 });
});

test("with every spot taken, replies step down on the right", () => {
  const parent = { boardX: 0, boardY: 0, boardW: 100, boardH: 100 };
  const wall = { boardX: -1000, boardY: -1000, boardW: 3000, boardH: 3000 };
  assert.deepEqual(placeReply(parent, [wall], 3), { boardX: 125, boardY: 90, boardW: 100, boardH: 100 });
});
