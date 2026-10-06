import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { joinableBoardError, joinTokenHash } from "@/lib/joinable-board-server";

// "Save to account": the signed-in creator of an anonymous board takes ownership, which also
// makes it permanent. The owner token from creation proves they made it; participants who only
// know the join code can't claim it.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    if (!email) return NextResponse.json({ error: "Sign in to save this board." }, { status: 401 });
    const body = await request.json() as { code?: string; token?: string };
    const code = normalizeJoinCode(body.code);
    if (code.length !== 6 || !body.token) return NextResponse.json({ error: "Invalid board." }, { status: 400 });
    const tokenHash = joinTokenHash(body.token);
    const supabase = getSupabase();
    const { data, error } = await supabase.from("joinable_boards")
      .update({ owner_email: email, expires_at: null, updated_at: new Date().toISOString() })
      .eq("code", code).eq("owner_token_hash", tokenHash).eq("active", true)
      .is("owner_email", null).gt("expires_at", new Date().toISOString())
      .select("code").maybeSingle();
    if (error) throw error;
    if (data) return NextResponse.json({ ok: true });
    // Repeat claims (another tab, a retry) by the same account are fine.
    const { data: existing, error: lookupError } = await supabase.from("joinable_boards")
      .select("owner_email").eq("code", code).eq("owner_token_hash", tokenHash).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing?.owner_email === email) return NextResponse.json({ ok: true });
    return NextResponse.json({ error: "This board can no longer be saved." }, { status: 409 });
  } catch (error) { return joinableBoardError(error); }
}
