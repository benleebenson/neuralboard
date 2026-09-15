import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { JOINABLE_BOARD_UNAVAILABLE } from "./joinable-board";

export function joinTokenHash(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function joinableBoardError(error: unknown) {
  console.error("JOINABLE_BOARD_FAIL", error);
  return NextResponse.json({ error: JOINABLE_BOARD_UNAVAILABLE }, { status: 503 });
}
