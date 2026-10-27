import type { JoinableBoardState } from "./joinable-board.ts";

// Likes on a shared board's items: item id -> the participant ids that like it. They live in the
// board's stored state under `likes`, but only /api/joinable-board/like changes them, with the
// liker's id derived from their participant token; every other save keeps what's stored.

export type BoardLikes = Record<string, string[]>;

const PARTICIPANT_ID = /^[0-9a-f]{64}$/;

/** The likes in a stored or received state, keeping only well-formed entries. */
export function readLikes(state: unknown): BoardLikes {
  const raw = (state as { likes?: unknown } | null | undefined)?.likes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const likes: BoardLikes = {};
  for (const [itemId, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue;
    const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && PARTICIPANT_ID.test(id)))];
    if (unique.length) likes[itemId] = unique;
  }
  return likes;
}

type Item = { id?: unknown; type?: unknown; boardX?: unknown };

// What can be liked: everything placed on the board (not timeline-only clips or camera zoom areas).
function boardItemIds(state: unknown): Set<string> {
  const { clips, annotations } = (state ?? {}) as { clips?: unknown; annotations?: unknown };
  const placed = (Array.isArray(clips) ? clips as Item[] : []).filter((clip) => typeof clip?.boardX === "number" && clip.type !== "customZoom");
  const items = [...placed, ...(Array.isArray(annotations) ? annotations as Item[] : [])];
  return new Set(items.flatMap((item) => typeof item?.id === "string" ? [item.id] : []));
}

export function hasBoardItem(state: unknown, itemId: string): boolean {
  return boardItemIds(state).has(itemId);
}

/**
 * The state to store for a save: `next` with whatever likes it carries replaced by the stored
 * ones, dropping likes on items the save removed.
 */
export function withStoredLikes(stored: unknown, next: JoinableBoardState): JoinableBoardState {
  const ids = boardItemIds(next);
  const likes = Object.fromEntries(Object.entries(readLikes(stored)).filter(([itemId]) => ids.has(itemId)));
  const { likes: _ignored, ...rest } = next as JoinableBoardState & { likes?: unknown };
  return (Object.keys(likes).length ? { ...rest, likes } : rest) as JoinableBoardState;
}

/** Sets one participant's like on one item. Setting (not toggling) makes a repeated request harmless. */
export function setLike(state: unknown, itemId: string, participantId: string, liked: boolean): BoardLikes {
  const likes = readLikes(state);
  const others = (likes[itemId] ?? []).filter((id) => id !== participantId);
  const next = liked ? [...others, participantId] : others;
  if (next.length) likes[itemId] = next;
  else delete likes[itemId];
  return likes;
}
