export const JOIN_CODE_LENGTH = 6;
// Boards created without an account are kept this long unless saved to an account.
export const ANONYMOUS_BOARD_TTL_DAYS = 5;
export const JOINABLE_BOARD_UNAVAILABLE = "Board sharing is temporarily unavailable.";

export function normalizeJoinCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, JOIN_CODE_LENGTH);
}

export function validJoinCode(value: unknown): value is string {
  return normalizeJoinCode(value).length === JOIN_CODE_LENGTH;
}

export function generateJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// Video and narration on a joinable board upload straight from the browser to Storage (a Vercel
// function body is capped at 4.5 MB), so every collaborator can load them. Images still go through
// /api/joinable-board/media, which converts them to webp. Keep in sync with the bucket's
// file_size_limit and allowed_mime_types (supabase/migrations/20261011_joinable_board_av_media.sql).
export const SHARED_AV_MAX_BYTES = 50 * 1024 * 1024;
export const SHARED_AV_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};
export const SHARED_MEDIA_EXTENSIONS = new Set(["webp", ...Object.values(SHARED_AV_EXTENSIONS)]);

export type JoinableBoardState = {
  clips: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  boardDimensions: { width: number; height: number };
  cameraKeyframes?: Array<Record<string, unknown>>;
  characterActions?: Array<Record<string, unknown>>;
  characterActions2?: Array<Record<string, unknown>>;
  showCharacter?: boolean;
  showCharacter2?: boolean;
  canvasAspect?: "16:9" | "9:16";
};

/**
 * JSON with object keys sorted, for comparing board states. The server stores state as jsonb,
 * which reorders keys, so plain JSON.stringify of the same board differs before and after a
 * round trip — every pulled update would look like a local edit and be written straight back.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]));
  });
}

const MERGED_LISTS = ["clips", "annotations", "characterActions", "characterActions2"] as const;
const MERGED_VALUES = ["boardDimensions", "cameraKeyframes", "showCharacter", "showCharacter2", "canvasAspect"] as const;

type Identified = Record<string, unknown> & { id?: unknown };

function mergeById(base: Identified[] = [], mine: Identified[] = [], theirs: Identified[] = []): Identified[] {
  const key = (item: Identified) => typeof item.id === "string" ? item.id : null;
  const baseById = new Map(base.flatMap((item) => key(item) ? [[key(item)!, stableStringify(item)] as const] : []));
  const mineById = new Map(mine.flatMap((item) => key(item) ? [[key(item)!, item] as const] : []));
  const result = theirs.flatMap((item) => {
    const id = key(item);
    if (!id || !baseById.has(id)) return [item];
    const local = mineById.get(id);
    if (!local) return []; // deleted here
    return [stableStringify(local) !== baseById.get(id) ? local : item]; // edited here wins
  });
  const present = new Set(result.flatMap((item) => key(item) ?? []));
  for (const item of mine) {
    const id = key(item);
    if (id && !baseById.has(id) && !present.has(id)) result.push(item); // added here
  }
  return result;
}

/**
 * Three-way merge of a joinable board: `theirs` (the newer server state) plus the local changes
 * `mine` made since `base` (the server state they started from). Clips, annotations and character
 * actions merge per item by id; other fields take the local value only if it changed. When both
 * sides edited the same item, the local edit wins.
 */
export function mergeJoinableStates(base: JoinableBoardState, mine: JoinableBoardState, theirs: JoinableBoardState): JoinableBoardState {
  const merged: Record<string, unknown> = { ...theirs };
  for (const field of MERGED_LISTS) {
    if (!theirs[field] && !mine[field]) continue;
    merged[field] = mergeById(base[field] as Identified[] | undefined, mine[field] as Identified[] | undefined, theirs[field] as Identified[] | undefined);
  }
  for (const field of MERGED_VALUES) {
    if (stableStringify(mine[field]) !== stableStringify(base[field])) merged[field] = mine[field];
  }
  return merged as JoinableBoardState;
}

// The creator's owner token for each board made on this device, so they can come back to it,
// stop sharing it, and claim it after signing in. Keyed by join code.
export const CREATED_BOARDS_STORAGE_KEY = "nb_anon_boards";
export type CreatedBoardRecord = { token: string; expiresAt: string | null; createdAt: string };

export function readCreatedBoards(): Record<string, CreatedBoardRecord> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CREATED_BOARDS_STORAGE_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, CreatedBoardRecord> : {};
  } catch {
    return {};
  }
}

export function rememberCreatedBoard(code: string, record: CreatedBoardRecord): void {
  try {
    window.localStorage.setItem(CREATED_BOARDS_STORAGE_KEY, JSON.stringify({ ...readCreatedBoards(), [code]: record }));
  } catch {}
}

export function forgetCreatedBoard(code: string): void {
  try {
    const boards = readCreatedBoards();
    delete boards[code];
    window.localStorage.setItem(CREATED_BOARDS_STORAGE_KEY, JSON.stringify(boards));
  } catch {}
}
