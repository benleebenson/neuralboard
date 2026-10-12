import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { JOINABLE_BOARD_UNAVAILABLE } from "./joinable-board";

export function joinTokenHash(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

/** A joiner's public id: the SHA-256 of their secret participant token (see participantIdFor). */
export function participantIdFromToken(token: unknown): string | null {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
}

// PostgREST `or` filter for boards that haven't expired: account-owned boards have no expiry.
export function unexpiredBoardFilter(): string {
  return `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;
}

export function joinableBoardError(error: unknown) {
  console.error("JOINABLE_BOARD_FAIL", error);
  return NextResponse.json({ error: JOINABLE_BOARD_UNAVAILABLE }, { status: 503 });
}
