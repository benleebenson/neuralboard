import crypto from "node:crypto";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { ANONYMOUS_BOARD_TTL_DAYS, generateJoinCode, normalizeJoinCode, type JoinableBoardState } from "@/lib/joinable-board";
import { joinableBoardError, joinTokenHash, participantIdFromToken, unexpiredBoardFilter } from "@/lib/joinable-board-server";
import { checkJoinerUpdate } from "@/lib/joinable-board-permissions";

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
    // Participants learn only whether the board is anonymous and whether they own it, never who does.
    const { owner_email: ownerEmail, ...board } = data;
    const viewerEmail = ownerEmail ? (await getServerSession(authOptions))?.user?.email : null;
    return NextResponse.json({ ...board, anonymous: ownerEmail === null, owner: !!viewerEmail && viewerEmail === ownerEmail }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return joinableBoardError(error); }
}

// Owners (owner token, or the signed-in owning account) may save anything. Everyone else is a
// joiner: checkJoinerUpdate rejects changes to board settings or to other people's items, and
// what's stored keeps everyone else's items exactly as they were.
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { code?: string; state?: JoinableBoardState; version?: number; ownerToken?: string; participantToken?: string };
    const code = normalizeJoinCode(body.code);
    if (code.length !== 6 || !body.state || typeof body.state !== "object") return NextResponse.json({ error: "Invalid board update." }, { status: 400 });
    const baseVersion = Math.floor(Number(body.version) || 0);
    const supabase = getSupabase();
    const { data: board, error: readError } = await supabase.from("joinable_boards").select("id,state,version,owner_email,owner_token_hash").eq("code", code).eq("active", true).or(unexpiredBoardFilter()).maybeSingle();
    if (readError) throw readError;
    if (!board) return NextResponse.json({ error: "That board is no longer joinable." }, { status: 404 });
    if (baseVersion !== board.version) return NextResponse.json({ conflict: true }, { status: 409 });
    const ownerByToken = typeof body.ownerToken === "string" && body.ownerToken.length > 0 && joinTokenHash(body.ownerToken) === board.owner_token_hash;
    const ownerByAccount = !ownerByToken && board.owner_email !== null && (await getServerSession(authOptions))?.user?.email === board.owner_email;
    let state = body.state;
    if (!ownerByToken && !ownerByAccount) {
      const participantId = participantIdFromToken(body.participantToken);
      if (!participantId) return NextResponse.json({ error: "Missing participant identity.", forbidden: true }, { status: 403 });
      const check = checkJoinerUpdate((board.state ?? {}) as JoinableBoardState, body.state, participantId);
      if (!check.ok) return NextResponse.json({ error: check.error, forbidden: true }, { status: 403 });
      state = check.state;
    }
    // Only applies if nobody saved since this board was read.
    const { data, error } = await supabase.from("joinable_boards").update({ state, version: board.version + 1, updated_at: active() }).eq("id", board.id).eq("version", board.version).select("version").maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ conflict: true }, { status: 409 });
    return NextResponse.json(data);
  } catch (error) { return joinableBoardError(error); }
}

// Stop sharing: the same owner check as PATCH — the owner token from creation, or the signed-in
// account that owns the board (e.g. after claiming it, on a device without the token).
export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { code?: string; token?: string };
    const code = normalizeJoinCode(body.code);
    if (code.length !== 6) return NextResponse.json({ error: "Invalid sharing session." }, { status: 400 });
    const supabase = getSupabase();
    const { data: board, error: readError } = await supabase.from("joinable_boards").select("id,owner_email,owner_token_hash").eq("code", code).maybeSingle();
    if (readError) throw readError;
    const forbidden = () => NextResponse.json({ error: "Only the board owner can stop sharing." }, { status: 403 });
    if (!board) return forbidden();
    const ownerByToken = typeof body.token === "string" && body.token.length > 0 && joinTokenHash(body.token) === board.owner_token_hash;
    const ownerByAccount = !ownerByToken && board.owner_email !== null && (await getServerSession(authOptions))?.user?.email === board.owner_email;
    if (!ownerByToken && !ownerByAccount) return forbidden();
    const { error } = await supabase.from("joinable_boards").update({ active: false, updated_at: active() }).eq("id", board.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return joinableBoardError(error); }
}
