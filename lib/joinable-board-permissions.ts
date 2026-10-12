import { stableStringify, type JoinableBoardState } from "./joinable-board.ts";

// Owner vs joiner on a joinable board. The owner can change anything. A joiner adds to the board
// and changes only what they added; whole-board settings belong to the owner. The server applies
// checkJoinerUpdate to every save that doesn't prove ownership.

/** Settings that affect the whole board for everyone. */
export const OWNER_ONLY_FIELDS = [
  "boardColor", "boardDimensions", "canvasAspect", "showCharacter", "showCharacter2",
  "characterActions", "characterActions2", "cameraKeyframes",
] as const;

/** Clip types a joiner may put on the board (text goes on as an annotation). */
export const JOINER_CLIP_TYPES = new Set(["image", "video"]);

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

function checkItems(kind: "clips" | "annotations", previous: Item[], next: Item[], participantId: string): { ok: true; items: Item[] } | { ok: false; error: string } {
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
      items.push(item);
    } else if (comparable(before) === comparable(item)) {
      items.push(before); // unchanged: keep exactly what's stored
    } else {
      if (before.addedBy !== participantId || item.addedBy !== participantId) return { ok: false, error: "You can only move or change what you added." };
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
    // A setting the board doesn't have yet stays unset; the joiner's value is ignored.
    if (prev[field] !== undefined && stableStringify(prev[field]) !== stableStringify(nxt[field])) {
      return { ok: false, error: "Only the board owner can change board settings." };
    }
  }
  const clips = checkItems("clips", (prev.clips as Item[] | undefined) ?? [], (nxt.clips as Item[] | undefined) ?? [], participantId);
  if (!clips.ok) return clips;
  const annotations = checkItems("annotations", (prev.annotations as Item[] | undefined) ?? [], (nxt.annotations as Item[] | undefined) ?? [], participantId);
  if (!annotations.ok) return annotations;
  return { ok: true, state: { ...previous, clips: clips.items, annotations: annotations.items } as JoinableBoardState };
}
