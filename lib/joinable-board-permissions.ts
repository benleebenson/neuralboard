import { parseBoardType, stableStringify, type JoinableBoardState } from "./joinable-board.ts";
import { isStickyNoteColor, STICKY_NOTE_MAX_TEXT } from "./sticky-notes.ts";
import { THREAD_DELETE_OWNER_ONLY } from "./sticky-threads.ts";

// Owner vs joiner on a joinable board. The owner can change anything. A joiner adds to the board
// and changes only what they added; whole-board settings belong to the owner. The server applies
// checkJoinerUpdate to every save that doesn't prove ownership.

/** Settings that affect the whole board for everyone. */
export const OWNER_ONLY_FIELDS = [
  "boardColor", "boardDimensions", "canvasAspect", "showCharacter", "showCharacter2",
  "characterActions", "characterActions2", "cameraKeyframes", "boardType",
] as const;

/** Clip types a joiner may put on the board (text goes on as an annotation). */
export const JOINER_CLIP_TYPES = new Set(["image", "video"]);

// An old-school board holds sticky notes and photos, and nothing else a joiner sends.
const SIMPLE_BOARD_ITEM_TYPES = { clips: new Set(["image"]), annotations: new Set(["sticky"]) };
export const SIMPLE_BOARD_ITEMS_ONLY = "This board takes sticky notes and photos only.";

// Per-device values a browser may fill in on any clip it displays (e.g. a video's measured
// duration). They never make another person's item count as changed.
const DERIVED_ITEM_KEYS = ["sourceDurationSec", "waveform", "thumbnailBlobUrl", "previewUrl", "sourceBlob", "audioBlob"];

type Item = Record<string, unknown> & { id?: unknown; addedBy?: unknown; type?: unknown; boardX?: unknown };

export type JoinerCheck =
  | { ok: true; state: JoinableBoardState }
  | { ok: false; error: string };

function comparable(item: Item): string {
  const copy: Record<string, unknown> = { ...item };
  for (const key of DERIVED_ITEM_KEYS) delete copy[key];
  return stableStringify(copy);
}

// A sticky note a joiner adds or changes must use the shared palette and carry plain text.
function stickyNoteError(item: Item): string | null {
  if (item.type !== "sticky") return null;
  if (!isStickyNoteColor(item.noteColor)) return "Sticky notes must use one of the note colors.";
  if (item.text !== undefined && (typeof item.text !== "string" || item.text.length > STICKY_NOTE_MAX_TEXT)) return "That sticky note's text is too long.";
  if (item.parentId !== undefined && (typeof item.parentId !== "string" || item.parentId.length > 200)) return "That reply doesn't point at a note.";
  return null;
}

// Deleting a note takes its replies with it, so a joiner can't delete a note that other people
// have replied to: that would leave their replies hanging off nothing. The owner can.
function threadDeleteError(previous: Item[], kept: Item[], participantId: string): string | null {
  const keptIds = new Set(kept.map((item) => item.id));
  const removed = new Set(previous.filter((item) => typeof item.id === "string" && !keptIds.has(item.id)).map((item) => item.id as string));
  if (removed.size === 0) return null;
  const strandsReply = kept.some((item) => typeof item.parentId === "string" && removed.has(item.parentId) && item.addedBy !== participantId);
  return strandsReply ? THREAD_DELETE_OWNER_ONLY : null;
}

function checkItems(kind: "clips" | "annotations", previous: Item[], next: Item[], participantId: string, simple: boolean): { ok: true; items: Item[] } | { ok: false; error: string } {
  const prevById = new Map(previous.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
  const nextIds = new Set<string>();
  const items: Item[] = [];
  for (const item of next) {
    if (typeof item.id !== "string") return { ok: false, error: "Every item needs an id." };
    nextIds.add(item.id);
    const before = prevById.get(item.id);
    if (!before) {
      if (item.addedBy !== participantId) return { ok: false, error: "New items must be marked as yours." };
      if (kind === "clips" && (!JOINER_CLIP_TYPES.has(String(item.type)) || typeof item.boardX !== "number")) {
        return { ok: false, error: "You can add images, video and text to the board; only the owner can change the video timeline." };
      }
      if (simple && !SIMPLE_BOARD_ITEM_TYPES[kind].has(String(item.type))) return { ok: false, error: SIMPLE_BOARD_ITEMS_ONLY };
      const stickyError = stickyNoteError(item);
      if (stickyError) return { ok: false, error: stickyError };
      items.push(item);
    } else if (comparable(before) === comparable(item)) {
      items.push(before); // unchanged: keep exactly what's stored
    } else {
      if (before.addedBy !== participantId || item.addedBy !== participantId) return { ok: false, error: "You can only move or change what you added." };
      if (simple && !SIMPLE_BOARD_ITEM_TYPES[kind].has(String(item.type))) return { ok: false, error: SIMPLE_BOARD_ITEMS_ONLY };
      const stickyError = stickyNoteError(item);
      if (stickyError) return { ok: false, error: stickyError };
      items.push(item);
    }
  }
  for (const [id, before] of prevById) {
    if (!nextIds.has(id) && before.addedBy !== participantId) return { ok: false, error: "You can only remove what you added." };
  }
  return { ok: true, items };
}

/**
 * Validates a joiner's save against the stored board. Rejects any change to owner-only settings
 * or to items someone else added. On success returns the state to store: the stored board with
 * only the joiner's own items changed.
 */
export function checkJoinerUpdate(previous: JoinableBoardState, next: JoinableBoardState, participantId: string): JoinerCheck {
  if (!/^[0-9a-f]{64}$/.test(participantId)) return { ok: false, error: "Missing participant identity." };
  const prev = previous as unknown as Record<string, unknown>;
  const nxt = next as unknown as Record<string, unknown>;
  for (const field of OWNER_ONLY_FIELDS) {
    // A setting the board doesn't have yet stays unset; the joiner's value is ignored. A board type
    // left out (a tab from before board types) is kept as stored.
    if (field === "boardType" && nxt[field] === undefined) continue;
    if (prev[field] !== undefined && stableStringify(prev[field]) !== stableStringify(nxt[field])) {
      return { ok: false, error: "Only the board owner can change board settings." };
    }
  }
  // The stored type decides, never the joiner's copy.
  const simple = parseBoardType(prev.boardType) === "simple";
  const clips = checkItems("clips", (prev.clips as Item[] | undefined) ?? [], (nxt.clips as Item[] | undefined) ?? [], participantId, simple);
  if (!clips.ok) return clips;
  const annotations = checkItems("annotations", (prev.annotations as Item[] | undefined) ?? [], (nxt.annotations as Item[] | undefined) ?? [], participantId, simple);
  if (!annotations.ok) return annotations;
  const threadError = threadDeleteError((prev.annotations as Item[] | undefined) ?? [], annotations.items, participantId);
  if (threadError) return { ok: false, error: threadError };
  return { ok: true, state: { ...previous, clips: clips.items, annotations: annotations.items } as JoinableBoardState };
}

/**
 * The board type a save stores. A board only ever goes from old school to Neural, and only by the
 * owner saying so: a save that leaves the type out (or asks for old school again) keeps what's stored.
 */
export function withStoredBoardType(stored: unknown, next: JoinableBoardState): JoinableBoardState {
  const storedType = (stored as JoinableBoardState | null)?.boardType;
  if (storedType === undefined) return next;
  const boardType = parseBoardType(storedType) === "simple" && next.boardType === "neural" ? "neural" : parseBoardType(storedType);
  return { ...next, boardType };
}
