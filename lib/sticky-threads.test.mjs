import test from "node:test";
import assert from "node:assert/strict";
import { planThreadDelete, placeReply, THREAD_CONNECTOR_COLOR, threadConnectors, threadDepths, threadDescendants, threadPaintOrder, threadParents, threadShade, THREAD_DELETE_OWNER_ONLY } from "./sticky-threads.ts";

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

const lightness = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

test("shades lift lightness by depth, stay hex, and stop short of white", () => {
  assert.equal(threadShade("#FFE58A", 0, "n1"), "#FFE58A");
  const one = threadShade("#FFE58A", 1, "n1"), two = threadShade("#FFE58A", 2, "n1"), deep = threadShade("#FFE58A", 40, "n1");
  assert.match(one, /^#[0-9A-F]{6}$/);
  assert.ok(lightness("#FFE58A") < lightness(one) && lightness(one) <= lightness(two) && lightness(two) <= lightness(deep));
  assert.ok(lightness(deep) <= 0.965);
  assert.notEqual(deep, "#FFFFFF");
  assert.equal(threadShade("not a color", 3, "n1"), "not a color");
});

test("a shade comes from the note's id: the same everywhere, different between notes", () => {
  assert.equal(threadShade("#FFC2D4", 1, "abc"), threadShade("#FFC2D4", 1, "abc"));
  const shades = new Set(["a", "b", "c", "d", "e", "f"].map((id) => threadShade("#FFC2D4", 1, id)));
  assert.ok(shades.size > 1);
});

test("connectors run center to center in solid slate, as wide as a share of the parent's font", () => {
  const items = [
    { id: "root", boardX: 0, boardY: 0, boardW: 100, boardH: 100, fontSize: 50 },
    { id: "reply", parentId: "root", boardX: 200, boardY: 0, boardW: 100, boardH: 40 },
    { id: "loose", boardX: 500, boardY: 500, boardW: 10, boardH: 10 },
  ];
  assert.deepEqual(threadConnectors(items), [{ id: "reply", x1: 50, y1: 50, x2: 250, y2: 20, width: 10 }]);
  assert.match(THREAD_CONNECTOR_COLOR, /^#[0-9A-F]{6}$/);
});

test("paint order puts each note above its replies, and leaves everything else where it was", () => {
  const items = [
    { id: "pen" },
    { id: "root" },
    { id: "reply", parentId: "root" },
    { id: "text" },
    { id: "deep", parentId: "reply" },
    { id: "loose" },
  ];
  assert.deepEqual(threadPaintOrder(items).map((item) => item.id), ["pen", "deep", "reply", "text", "root", "loose"]);
  const plain = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(threadPaintOrder(plain), plain);
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

test("a darker color keeps getting lighter level by level until the cap", () => {
  const shades = [0, 1, 2, 3].map((depth) => threadShade("#7A5C00", depth, "n2"));
  for (let i = 1; i < shades.length; i++) assert.ok(lightness(shades[i - 1]) < lightness(shades[i]));
});
