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
