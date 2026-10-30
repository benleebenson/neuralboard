// Sticky-note threads: a reply is a sticky note with `parentId` set to the note it answers.
// Replies can be answered too, to any depth. A reply stores its thread's palette color as its
// `noteColor` (so the server's palette check still holds); each level down is drawn a little
// lighter, worked out here from depth rather than stored.
//
// A `parentId` can point at nothing: someone deleted the parent while another person was
// replying, and the board merge kept the reply. Such a note is treated as top-level everywhere.

export type ThreadItem = { id: string; parentId?: unknown };
type Box = { boardX: number; boardY: number; boardW: number; boardH: number };

/** The id of the note this one hangs off, or null when it's top-level or its parent is gone. */
function liveParentId(item: ThreadItem, ids: ReadonlySet<string>): string | null {
  return typeof item.parentId === "string" && item.parentId !== item.id && ids.has(item.parentId) ? item.parentId : null;
}

/**
 * Each item's parent, for items whose parent is on the board. A cycle (only possible from a
 * hand-edited or corrupted board) is broken by dropping the link that closes it.
 */
export function threadParents(items: readonly ThreadItem[]): Map<string, string> {
  const ids = new Set(items.map((item) => item.id));
  const parents = new Map<string, string>();
  for (const item of items) {
    const parentId = liveParentId(item, ids);
    if (parentId) parents.set(item.id, parentId);
  }
  for (const item of items) {
    const seen = new Set<string>([item.id]);
    let current = parents.get(item.id);
    while (current !== undefined) {
      if (seen.has(current)) { parents.delete(item.id); break; }
      seen.add(current);
      current = parents.get(current);
    }
  }
  return parents;
}

/** How many notes up each item's thread goes: 0 for a top-level item. */
export function threadDepths(items: readonly ThreadItem[]): Map<string, number> {
  const parents = threadParents(items);
  const depths = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const parentId = parents.get(id);
    const depth = parentId === undefined ? 0 : depthOf(parentId) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const item of items) depthOf(item.id);
  return depths;
}

/** Every item below the given ones in their threads (not including them). */
export function threadDescendants(items: readonly ThreadItem[], rootIds: Iterable<string>): Set<string> {
  const children = new Map<string, string[]>();
  for (const [childId, parentId] of threadParents(items)) children.set(parentId, [...(children.get(parentId) ?? []), childId]);
  const roots = new Set(rootIds);
  const found = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    for (const childId of children.get(stack.pop()!) ?? []) {
      if (found.has(childId) || roots.has(childId)) continue;
      found.add(childId);
      stack.push(childId);
    }
  }
  return found;
}

export type ThreadDeletePlan = { ok: true; ids: Set<string> } | { ok: false; error: string };

export const THREAD_DELETE_OWNER_ONLY = "Only the board owner can delete a note that has other people's replies.";

/**
 * Deleting a note deletes its whole thread below it. Only someone who may delete every note in
 * that thread can do it, so a joiner can delete a thread of their own, and only the owner can
 * delete one with other people's replies in it.
 */
export function planThreadDelete<T extends ThreadItem>(items: readonly T[], ids: Iterable<string>, canDelete: (item: T) => boolean): ThreadDeletePlan {
  const all = new Set(ids);
  for (const id of threadDescendants(items, all)) all.add(id);
  for (const item of items) {
    if (all.has(item.id) && !canDelete(item)) return { ok: false, error: THREAD_DELETE_OWNER_ONLY };
  }
  return { ok: true, ids: all };
}

// Each level down mixes this much more white into the note's color, up to a limit so deep
// replies still read as part of their thread.
const SHADE_PER_LEVEL = 0.8;
const MAX_SHADE = 0.55;

/** The color a note is drawn in: its palette color, lightened by its depth in the thread. */
export function threadShade(color: string, depth: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match || depth <= 0) return color;
  const white = Math.min(MAX_SHADE, 1 - SHADE_PER_LEVEL ** depth);
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 0xff;
    return Math.round(c + (255 - c) * white).toString(16).padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`.toUpperCase();
}

// Where a reply goes, in units of its parent's size: right, below, left, above, then the corners.
const REPLY_SPOTS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
// The space between a note and its reply, as a share of the note's width.
const REPLY_GAP = 0.25;

function overlaps(a: Box, b: Box): boolean {
  return a.boardX < b.boardX + b.boardW && b.boardX < a.boardX + a.boardW && a.boardY < b.boardY + b.boardH && b.boardY < a.boardY + a.boardH;
}

/**
 * The box for a new reply to `parent`: the same size as the parent, in the first of eight spots
 * around it that's clear of `others`. When all eight are taken it goes to the right, stepped down
 * by the number of replies the parent already has.
 */
export function placeReply(parent: Box, others: readonly Box[], existingReplies: number): Box {
  const w = parent.boardW, h = parent.boardW;
  const stepX = parent.boardW + parent.boardW * REPLY_GAP;
  const stepY = parent.boardH + parent.boardW * REPLY_GAP;
  for (const [dx, dy] of REPLY_SPOTS) {
    const box = { boardX: parent.boardX + dx * stepX, boardY: parent.boardY + dy * stepY, boardW: w, boardH: h };
    if (!others.some((other) => overlaps(box, other))) return box;
  }
  return { boardX: parent.boardX + stepX, boardY: parent.boardY + existingReplies * h * 0.3, boardW: w, boardH: h };
}
