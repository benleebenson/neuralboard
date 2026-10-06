import crypto from "node:crypto";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { ANONYMOUS_BOARD_TTL_DAYS, generateJoinCode, normalizeJoinCode, type JoinableBoardState } from "@/lib/joinable-board";
import { joinableBoardError, joinTokenHash, unexpiredBoardFilter } from "@/lib/joinable-board-server";

const active = () => new Date().toISOString();

// No account needed: anonymous boards have no owner and expire after ANONYMOUS_BOARD_TTL_DAYS
// unless claimed; boards created while signed in belong to the account and never expire. The
// returned owner token proves the creator (stop sharing, claim) and is only stored hashed.
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    const ownerEmail = session?.user?.email ?? null;
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = ownerEmail ? null : new Date(Date.now() + ANONYMOUS_BOARD_TTL_DAYS * 86_400_000).toISOString();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateJoinCode();
      const { error } = await getSupabase().from("joinable_boards").insert({ code, owner_email: ownerEmail, owner_token_hash: joinTokenHash(token), expires_at: expiresAt });
      if (!error) return NextResponse.json({ code, token, expiresAt, anonymous: !ownerEmail }, { status: 201 });
      if (error.code !== "23505") throw error;
    }
    throw new Error("Could not allocate a join code");
  } catch (error) { return joinableBoardError(error); }
}

export async function GET(request: Request) {
  try {
    const code = normalizeJoinCode(new URL(request.url).searchParams.get("code"));
    if (code.length !== 6) return NextResponse.json({ error: "Enter a six-character board code." }, { status: 400 });
    const { data, error } = await getSupabase().from("joinable_boards").select("code,state,version,expires_at,owner_email").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "That board code is invalid or no longer active." }, { status: 404 });
    // Participants learn only whether the board is anonymous, never who owns it.
    const { owner_email: ownerEmail, ...board } = data;
    return NextResponse.json({ ...board, anonymous: ownerEmail === null }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return joinableBoardError(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { code?: string; state?: JoinableBoardState; version?: number };
    const code = normalizeJoinCode(body.code);
    if (code.length !== 6 || !body.state || typeof body.state !== "object") return NextResponse.json({ error: "Invalid board update." }, { status: 400 });
    const nextVersion = Math.max(1, Math.floor(Number(body.version) || 0) + 1);
    const { data, error } = await getSupabase().from("joinable_boards").update({ state: body.state, version: nextVersion, updated_at: active() }).eq("code", code).eq("active", true).or(unexpiredBoardFilter()).lte("version", Math.floor(Number(body.version) || 0)).select("version").maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ conflict: true }, { status: 409 });
    return NextResponse.json(data);
  } catch (error) { return joinableBoardError(error); }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { code?: string; token?: string };
    const code = normalizeJoinCode(body.code);
    if (code.length !== 6 || !body.token) return NextResponse.json({ error: "Invalid sharing session." }, { status: 400 });
    const { data, error } = await getSupabase().from("joinable_boards").update({ active: false, updated_at: active() }).eq("code", code).eq("owner_token_hash", joinTokenHash(body.token)).select("code").maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Only the board owner can stop sharing." }, { status: 403 });
    return NextResponse.json({ ok: true });
  } catch (error) { return joinableBoardError(error); }
}
