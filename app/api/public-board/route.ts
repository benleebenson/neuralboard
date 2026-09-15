import { NextResponse } from "next/server";

const retired = () => NextResponse.json(
  { error: "The public community board has been replaced by private join codes." },
  { status: 410, headers: { "Cache-Control": "no-store" } },
);

export async function GET() { return retired(); }
export async function POST() { return retired(); }
