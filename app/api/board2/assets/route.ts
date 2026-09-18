import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import sharp from "sharp";
import { authOptions } from "@/lib/auth";
import { bestSemanticAsset, ASSET_SEMANTIC_MATCH_THRESHOLD } from "@/lib/board2/asset-matching";
import { getSupabase, saveAsset, listAssets, setIntroAsset, type AssetType } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

function isAssetType(value: unknown): value is AssetType { return value === "image" || value === "youtube"; }

async function embedding(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text.trim()) return [];
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.trim().slice(0, 1000), dimensions: 512 }),
  });
  const data = await response.json().catch(() => null) as { data?: Array<{ embedding?: number[] }> } | null;
  return response.ok && Array.isArray(data?.data?.[0]?.embedding) ? data!.data![0].embedding! : [];
}

async function describeImage(bytes: Buffer, fallback: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return fallback;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", max_tokens: 80, temperature: 0.2,
      messages: [{ role: "user", content: [
        { type: "text", text: "Describe this image in one concrete searchable sentence. Name visible people, objects, setting, action, mood, and era when evident. No filler." },
        { type: "image_url", image_url: { url: `data:image/webp;base64,${bytes.toString("base64")}`, detail: "low" } },
      ] }],
    }),
  });
  const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
  return response.ok ? data?.choices?.[0]?.message?.content?.replace(/\s+/g, " ").trim().slice(0, 500) || fallback : fallback;
}

async function signedAssets(email: string, type?: AssetType) {
  const supabase = getSupabase();
  const assets = await listAssets(email, type, 500);
  return Promise.all(assets.map(async (asset) => {
    if (!asset.storage_path) return asset;
    const { data } = await supabase.storage.from("asset-library").createSignedUrl(asset.storage_path, 3600);
    return { ...asset, url: data?.signedUrl ?? asset.url, thumbnail_url: data?.signedUrl ?? asset.thumbnail_url };
  }));
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const typeParam = req.nextUrl.searchParams.get("type");
    const type = isAssetType(typeParam) ? typeParam : undefined;
    const assets = await signedAssets(session.user.email, type);
    if (req.nextUrl.searchParams.get("intro") === "true") {
      return NextResponse.json({ asset: assets.find((asset) => asset.type === "image" && asset.is_intro) ?? null });
    }
    const query = req.nextUrl.searchParams.get("query")?.trim();
    if (query) {
      const match = bestSemanticAsset(assets.filter((asset) => asset.type === "image"), await embedding(query));
      return NextResponse.json({ match: match ? { ...match.asset, score: match.score } : null, threshold: ASSET_SEMANTIC_MATCH_THRESHOLD });
    }
    return NextResponse.json({ assets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load assets" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const email = session.user.email;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let inputBytes: Buffer | null = null;
    let label = "Library image";
    let source = "manual";
    let remoteUrl: string | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || !file.type.startsWith("image/")) return NextResponse.json({ error: "An image file is required" }, { status: 400 });
      if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "Image must be under 15 MB" }, { status: 413 });
      inputBytes = Buffer.from(await file.arrayBuffer());
      label = String(form.get("label") || file.name).slice(0, 200);
      source = String(form.get("source") || "manual").slice(0, 40);
    } else {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const type = body?.type;
      if (!isAssetType(type)) return NextResponse.json({ error: "type must be 'image' or 'youtube'" }, { status: 400 });
      const payload = body!;
      label = typeof body?.label === "string" ? body.label.trim().slice(0, 200) || label : label;
      source = typeof body?.source === "string" ? body.source.trim().slice(0, 40) || source : source;
      if (type === "youtube") {
        const youtubeId = typeof payload.youtubeId === "string" ? payload.youtubeId.slice(0, 64) : "";
        if (!youtubeId) return NextResponse.json({ error: "youtubeId is required" }, { status: 400 });
        const asset = await saveAsset(email, { type, youtubeId, ytStart: Number(payload.ytStart) || 0, ytEnd: Number(payload.ytEnd) || null, label, source, thumbnailUrl: `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg` });
        return NextResponse.json({ asset });
      }
      remoteUrl = typeof payload.url === "string" && /^https?:\/\//.test(payload.url) ? payload.url.slice(0, 2000) : null;
      if (!remoteUrl) return NextResponse.json({ error: "url is required" }, { status: 400 });
      const response = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Could not download image (${response.status})`);
      inputBytes = Buffer.from(await response.arrayBuffer());
    }
    const compressed = await sharp(inputBytes!).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    const description = await describeImage(compressed, label);
    const vector = await embedding(description);
    const storagePath = `${encodeURIComponent(email)}/${randomUUID()}.webp`;
    const supabase = getSupabase();
    const { error: uploadError } = await supabase.storage.from("asset-library").upload(storagePath, compressed, { contentType: "image/webp", upsert: false });
    if (uploadError) throw uploadError;
    try {
      const asset = await saveAsset(email, { type: "image", url: remoteUrl, thumbnailUrl: remoteUrl, label, source, description, embedding: vector, storagePath });
      const { data } = await supabase.storage.from("asset-library").createSignedUrl(storagePath, 3600);
      return NextResponse.json({ asset: { ...asset, url: data?.signedUrl, thumbnail_url: data?.signedUrl } });
    } catch (error) {
      await supabase.storage.from("asset-library").remove([storagePath]);
      throw error;
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save asset" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as { id?: unknown; isIntro?: unknown } | null;
  if (typeof body?.id !== "string" || body.isIntro !== true) return NextResponse.json({ error: "id and isIntro=true are required" }, { status: 400 });
  try { return NextResponse.json({ asset: await setIntroAsset(session.user.email, body.id) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to set intro" }, { status: 500 }); }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const supabase = getSupabase();
  const { data: asset } = await supabase.from("nb_assets").select("storage_path").eq("email", session.user.email).eq("id", id).maybeSingle();
  const { error } = await supabase.from("nb_assets").delete().eq("email", session.user.email).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (asset?.storage_path) await supabase.storage.from("asset-library").remove([asset.storage_path]);
  return NextResponse.json({ ok: true });
}
