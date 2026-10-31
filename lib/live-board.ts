import { normalizeJoinCode } from "./joinable-board.ts";

// neuralboard.org/live: one address that always sends people to whichever of the site owner's
// boards is set as live, joining it (no code to type, no sign-in). Only the site owner sets it, and
// only to a board their account owns; the setting lives in public.live_board (one row).

export const LIVE_BOARD_OWNER_ONLY = "Only the site owner can set the live board.";
export const LIVE_BOARD_NOT_YOURS = "That isn't one of your active boards.";

export type LiveBoardCandidate = { code: string; active: boolean; expires_at: string | null; owner_email: string | null };

/** Whether a board can be live right now: the owner's, still shared, and not expired. */
export function isLiveable(board: LiveBoardCandidate | null | undefined, ownerEmail: string, now = Date.now()): board is LiveBoardCandidate {
  return !!board && board.active && board.owner_email === ownerEmail && (board.expires_at === null || Date.parse(board.expires_at) > now);
}

/** Where /live sends people: into the live board, or nowhere (it shows a "nothing live" page). */
export function liveBoardDestination(board: LiveBoardCandidate | null | undefined, ownerEmail: string, now = Date.now()): string | null {
  return isLiveable(board, ownerEmail, now) ? `/board2?join=${encodeURIComponent(board.code)}` : null;
}

/** A request to set the live board: a board code, or null to clear it. */
export function parseLiveBoardRequest(body: unknown): { ok: true; code: string | null } | { ok: false; error: string } {
  const raw = (body as { code?: unknown } | null | undefined)?.code;
  if (raw === null) return { ok: true, code: null };
  const code = typeof raw === "string" ? normalizeJoinCode(raw) : "";
  return code.length === 6 ? { ok: true, code } : { ok: false, error: "Give a six-character board code, or null to clear." };
}
