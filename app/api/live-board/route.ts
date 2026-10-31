import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { ADMIN_EMAIL, authOptions } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { joinableBoardError, unexpiredBoardFilter } from "@/lib/joinable-board-server";
import { isLiveable, LIVE_BOARD_NOT_YOURS, LIVE_BOARD_OWNER_ONLY, parseLiveBoardRequest } from "@/lib/live-board";

// Which board neuralboard.org/live sends people to (see lib/live-board). Only the site owner,
// signed in, may read or change it; the session is checked here, before anything touches the DB.

const noStore = { "Cache-Control": "private, no-store" };

async function isSiteOwner(): Promise<boolean> {
  return (await getServerSession(authOptions))?.user?.email === ADMIN_EMAIL;
}

const forbidden = () => NextResponse.json({ error: LIVE_BOARD_OWNER_ONLY }, { status: 403, headers: noStore });

/** The live board's code and the owner's boards that could be live, newest first. */
export async function GET() {
  if (!(await isSiteOwner())) return forbidden();
  try {
    const supabase = getSupabase();
    const [live, boards] = await Promise.all([
      supabase.from("live_board").select("code,updated_at").eq("id", true).maybeSingle(),
      supabase.from("joinable_boards").select("code,created_at,updated_at,expires_at").eq("owner_email", ADMIN_EMAIL).eq("active", true).or(unexpiredBoardFilter()).order("updated_at", { ascending: false }).limit(200),
    ]);
    if (live.error) throw live.error;
    if (boards.error) throw boards.error;
    return NextResponse.json({ live: live.data?.code ?? null, boards: boards.data ?? [] }, { headers: noStore });
  } catch (error) { return joinableBoardError(error); }
}

/** Sets the live board ({ code }) or clears it ({ code: null }). The board must be the owner's and active. */
export async function PUT(request: Request) {
  if (!(await isSiteOwner())) return forbidden();
  try {
    const parsed = parseLiveBoardRequest(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: noStore });
    const supabase = getSupabase();
    if (parsed.code) {
      const { data: board, error } = await supabase.from("joinable_boards").select("code,active,expires_at,owner_email").eq("code", parsed.code).maybeSingle();
      if (error) throw error;
      if (!isLiveable(board, ADMIN_EMAIL)) return NextResponse.json({ error: LIVE_BOARD_NOT_YOURS }, { status: 404, headers: noStore });
    }
    const { error } = await supabase.from("live_board").upsert({ id: true, code: parsed.code, updated_at: new Date().toISOString() });
    if (error) throw error;
    return NextResponse.json({ live: parsed.code }, { headers: noStore });
  } catch (error) { return joinableBoardError(error); }
}
