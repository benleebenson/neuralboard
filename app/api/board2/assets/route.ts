import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import sharp from "sharp";
import { authOptions } from "@/lib/auth";
import { bestSemanticAsset, ASSET_SEMANTIC_MATCH_THRESHOLD } from "@/lib/board2/asset-matching";
import { getSupabase, saveAsset, listAssets, setIntroAsset, type AssetType } from "@/lib/supabase";
import { AssetSaveError, assetSaveStatus, errorDetails, errorMessage, isStorageDuplicate, isUniqueViolation } from "@/lib/board2/asset-save-errors";

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

const BUCKET = "asset-library";
// Remote images are downloaded into memory before compression; refuse anything absurd.
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

type AssetRow = Awaited<ReturnType<typeof listAssets>>[number];

async function signedAssets(email: string, type?: AssetType) {
  const supabase = getSupabase();
  const assets = await listAssets(email, type, 500);
  const paths = assets.flatMap((asset) => asset.storage_path ? [asset.storage_path as string] : []);
  if (paths.length === 0) return assets;
  // One batched call instead of one signing request per asset (up to 500 in parallel).
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) console.warn("[asset-list] signing failed; returning stored URLs", errorDetails(error));
  const signed = new Map((data ?? []).flatMap((item) => item.path && item.signedUrl ? [[item.path, item.signedUrl] as const] : []));
  return assets.map((asset) => {
    const url = asset.storage_path ? signed.get(asset.storage_path) : undefined;
    return url ? { ...asset, url, thumbnail_url: url } : asset;
  });
}

async function withSignedUrl(asset: AssetRow) {
  if (!asset.storage_path) return asset;
  const { data } = await getSupabase().storage.from(BUCKET).createSignedUrl(asset.storage_path, 3600);
  return { ...asset, url: data?.signedUrl ?? asset.url, thumbnail_url: data?.signedUrl ?? asset.thumbnail_url };
}

async function findAsset(email: string, column: "url" | "storage_path", value: string): Promise<AssetRow | null> {
  const { data, error } = await getSupabase().from("nb_assets").select("*").eq("email", email).eq("type", "image").eq(column, value).limit(1).maybeSingle();
  if (error) throw error;
  return (data as AssetRow | null) ?? null;
}

export async function GET(req: NextRequest) {
  let stage = "authentication";
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    stage = "list assets";
    const typeParam = req.nextUrl.searchParams.get("type");
    const type = isAssetType(typeParam) ? typeParam : undefined;
    const assets = await signedAssets(session.user.email, type);
    if (req.nextUrl.searchParams.get("intro") === "true") {
      return NextResponse.json({ asset: assets.find((asset) => asset.type === "image" && asset.is_intro) ?? null });
    }
    const query = req.nextUrl.searchParams.get("query")?.trim();
    if (query) {
      stage = "query embedding";
      const match = bestSemanticAsset(assets.filter((asset) => asset.type === "image"), await embedding(query).catch(() => []));
      return NextResponse.json({ match: match ? { ...match.asset, score: match.score } : null, threshold: ASSET_SEMANTIC_MATCH_THRESHOLD });
    }
    return NextResponse.json({ assets });
  } catch (error) {
    console.error("[asset-list] failed", { stage, error: errorDetails(error) });
    return NextResponse.json({ error: errorMessage(error, "Failed to load assets"), stage }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID().slice(0, 8);
  let stage = "authentication";
  let email: string | undefined;
  const supabase = getSupabase();
  let uploadedPath: string | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      console.warn("[asset-save] rejected", { requestId, stage, reason: "unauthorized" });
      return NextResponse.json({ error: "Unauthorized", stage, requestId }, { status: 401 });
    }
    email = session.user.email;
    const contentType = req.headers.get("content-type") ?? "";
    console.info("[asset-save] request received", { requestId, email, contentType, contentLength: req.headers.get("content-length") });
    stage = "request parsing";
    let inputBytes: Buffer;
    let label = "Library image";
    let source = "manual";
    let remoteUrl: string | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || !file.type.startsWith("image/")) return NextResponse.json({ error: "An image file is required", requestId }, { status: 400 });
      if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "Image must be under 15 MB", requestId }, { status: 413 });
      inputBytes = Buffer.from(await file.arrayBuffer());
      label = String(form.get("label") || file.name).slice(0, 200);
      source = String(form.get("source") || "manual").slice(0, 40);
    } else {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const type = body?.type;
      if (!isAssetType(type)) return NextResponse.json({ error: "type must be 'image' or 'youtube'", requestId }, { status: 400 });
      const payload = body!;
      label = typeof body?.label === "string" ? body.label.trim().slice(0, 200) || label : label;
      source = typeof body?.source === "string" ? body.source.trim().slice(0, 40) || source : source;
      if (type === "youtube") {
        const youtubeId = typeof payload.youtubeId === "string" ? payload.youtubeId.slice(0, 64) : "";
        if (!youtubeId) return NextResponse.json({ error: "youtubeId is required", requestId }, { status: 400 });
        stage = "Supabase nb_assets youtube upsert";
        const asset = await saveAsset(email, { type, youtubeId, ytStart: Number(payload.ytStart) || 0, ytEnd: Number(payload.ytEnd) || null, label, source, thumbnailUrl: `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg` });
        return NextResponse.json({ asset, requestId });
      }
      remoteUrl = typeof payload.url === "string" && /^https?:\/\//.test(payload.url) ? payload.url.slice(0, 2000) : null;
      if (!remoteUrl) return NextResponse.json({ error: "url is required", requestId }, { status: 400 });
      // nb_assets has UNIQUE (email, url). Re-saving a known URL (every board load re-saves its
      // images) used to do all the work below and then die on that constraint with a 500.
      stage = "duplicate check (url)";
      const known = await findAsset(email, "url", remoteUrl);
      if (known) {
        console.info("[asset-save] already saved", { requestId, assetId: known.id, by: "url" });
        return NextResponse.json({ asset: await withSignedUrl(known), requestId, duplicate: true });
      }
      stage = "remote image download";
      let response: Response;
      try {
        response = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new AssetSaveError(502, `Could not download image (${errorMessage(error)})`, { cause: error });
      }
      if (!response.ok) throw new AssetSaveError(502, `Could not download image (the image host answered ${response.status})`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > MAX_REMOTE_IMAGE_BYTES) throw new AssetSaveError(413, `Remote image is too large (${declaredLength} bytes)`);
      inputBytes = Buffer.from(await response.arrayBuffer());
      if (inputBytes.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new AssetSaveError(413, `Remote image is too large (${inputBytes.byteLength} bytes)`);
    }
    // Content-addressed path: saving the same bytes again (each session re-saves every board
    // image) finds the existing asset instead of uploading and describing a duplicate.
    const storagePath = `${encodeURIComponent(email)}/${createHash("sha256").update(inputBytes).digest("hex").slice(0, 40)}.webp`;
    stage = "duplicate check (content)";
    const sameBytes = await findAsset(email, "storage_path", storagePath);
    if (sameBytes) {
      console.info("[asset-save] already saved", { requestId, assetId: sameBytes.id, by: "content" });
      return NextResponse.json({ asset: await withSignedUrl(sameBytes), requestId, duplicate: true });
    }
    stage = "image compression";
    let compressed: Buffer;
    try {
      compressed = await sharp(inputBytes).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    } catch (error) {
      throw new AssetSaveError(415, `Not a readable image (${errorMessage(error)})`, { cause: error });
    }
    console.info("[asset-save] image compressed", { requestId, inputBytes: inputBytes.byteLength, outputBytes: compressed.byteLength });
    stage = "AI description";
    // Description and embedding are enrichment: an OpenAI outage must not fail the save.
    const description = await describeImage(compressed, label).catch((error) => {
      console.warn("[asset-save] description failed; using label", { requestId, error: errorDetails(error) });
      return label;
    });
    stage = "AI embedding";
    const vector = await embedding(description).catch((error) => {
      console.warn("[asset-save] embedding failed; saving without one", { requestId, error: errorDetails(error) });
      return [] as number[];
    });
    stage = "Supabase Storage upload";
    let { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, compressed, { contentType: "image/webp", upsert: false });
    if (uploadError && /bucket.*not found/i.test(uploadError.message)) {
      console.warn("[asset-save] bucket missing; creating it", { requestId });
      stage = "Supabase Storage bucket creation";
      const { error: bucketError } = await supabase.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ["image/webp", "image/jpeg", "image/png"],
      });
      if (bucketError && !/already exists/i.test(bucketError.message)) throw bucketError;
      stage = "Supabase Storage upload retry";
      ({ error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, compressed, { contentType: "image/webp", upsert: false }));
    }
    // Same bytes uploaded by a concurrent request: the object is identical, so carry on and let
    // the row insert below resolve which request owns the row.
    if (uploadError && !isStorageDuplicate(uploadError)) throw uploadError;
    if (!uploadError) uploadedPath = storagePath;
    console.info("[asset-save] storage upload complete", { requestId, storagePath, alreadyStored: !!uploadError });
    stage = "Supabase nb_assets row insert";
    let asset: AssetRow;
    try {
      asset = await saveAsset(email, { type: "image", url: remoteUrl, thumbnailUrl: remoteUrl, label, source, description, embedding: vector, storagePath }) as AssetRow;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a race with a concurrent save of the same URL: return that row.
      stage = "Supabase nb_assets duplicate lookup";
      const existing = remoteUrl ? await findAsset(email, "url", remoteUrl) : await findAsset(email, "storage_path", storagePath);
      if (!existing) throw error;
      if (uploadedPath && existing.storage_path !== uploadedPath) await supabase.storage.from(BUCKET).remove([uploadedPath]);
      uploadedPath = null;
      console.info("[asset-save] already saved", { requestId, assetId: existing.id, by: "constraint" });
      return NextResponse.json({ asset: await withSignedUrl(existing), requestId, duplicate: true });
    }
    uploadedPath = null; // owned by the row now
    console.info("[asset-save] database row complete", { requestId, assetId: asset.id });
    stage = "signed URL creation";
    const signed = await withSignedUrl(asset);
    console.info("[asset-save] complete", { requestId, assetId: asset.id });
    return NextResponse.json({ asset: signed, requestId });
  } catch (error) {
    if (uploadedPath) await supabase.storage.from(BUCKET).remove([uploadedPath]).catch(() => {});
    const status = assetSaveStatus(error);
    const rawMessage = errorMessage(error, "Failed to save asset");
    const migrationHint = /bucket.*not found|nb_assets|storage_path|description|embedding|is_intro|schema cache/i.test(rawMessage)
      ? " The asset-library Supabase migration may not be applied."
      : "";
    const log = status >= 500 && status !== 502 ? console.error : console.warn;
    log("[asset-save] failed", { requestId, email, stage, status, error: errorDetails(error) });
    return NextResponse.json({ error: `${rawMessage}${migrationHint}`, stage, requestId }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as { id?: unknown; isIntro?: unknown } | null;
  if (typeof body?.id !== "string" || body.isIntro !== true) return NextResponse.json({ error: "id and isIntro=true are required" }, { status: 400 });
  try { return NextResponse.json({ asset: await setIntroAsset(session.user.email, body.id) }); }
  catch (error) {
    console.error("[asset-intro] failed", { id: body.id, error: errorDetails(error) });
    return NextResponse.json({ error: errorMessage(error, "Failed to set intro") }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const supabase = getSupabase();
  const { data: asset } = await supabase.from("nb_assets").select("storage_path").eq("email", session.user.email).eq("id", id).maybeSingle();
  const { error } = await supabase.from("nb_assets").delete().eq("email", session.user.email).eq("id", id);
  if (error) {
    console.error("[asset-delete] failed", { id, error: errorDetails(error) });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (asset?.storage_path) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([asset.storage_path]);
    if (removeError) console.warn("[asset-delete] storage object left behind", { id, storagePath: asset.storage_path, error: errorDetails(removeError) });
  }
  return NextResponse.json({ ok: true });
}
