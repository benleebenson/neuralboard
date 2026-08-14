import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

type YtdlRequestBody = {
  id?: unknown;
  youtubeId?: unknown;
  url?: unknown;
  start?: unknown;
  end?: unknown;
};

type BridgeFileResponse = {
  ok?: unknown;
  filename?: unknown;
  url?: unknown;
};

function youtubeIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();

    if (hostname === "youtu.be" || hostname.endsWith(".youtu.be")) {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && YOUTUBE_ID_RE.test(id) ? id : null;
    }

    if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) return null;

    const pathParts = url.pathname.split("/").filter(Boolean);
    const id = url.pathname === "/watch"
      ? url.searchParams.get("v")
      : (["shorts", "embed", "live"].includes(pathParts[0] ?? "") ? pathParts[1] : null);

    return id && YOUTUBE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function youtubeIdFromBody(body: YtdlRequestBody): string | null {
  for (const candidate of [body.id, body.youtubeId]) {
    if (typeof candidate === "string" && YOUTUBE_ID_RE.test(candidate)) return candidate;
  }

  return typeof body.url === "string" ? youtubeIdFromUrl(body.url) : null;
}

function bridgeErrorText(text: string): string {
  if (!text) return "No response body";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 800);
  } catch {
    // The bridge may return a plain-text or HTML error from an upstream proxy.
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 800);
}

function parseBridgeFileResponse(text: string): BridgeFileResponse | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as BridgeFileResponse : null;
  } catch {
    return null;
  }
}

async function postToBridge(
  bridgeUrl: string,
  password: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; text: string }> {
  const response = await fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-neuralboard-password": password,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return { response, text: await response.text() };
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    let body: YtdlRequestBody;
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
      }
      body = parsed as YtdlRequestBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
    }

    const youtubeId = youtubeIdFromBody(body);
    if (!youtubeId) {
      return NextResponse.json(
        { error: "Missing or invalid YouTube id/url" },
        { status: 400 },
      );
    }

    const start = body.start === undefined ? 0 : body.start;
    const end = body.end;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) {
      return NextResponse.json({ error: "start must be a non-negative number" }, { status: 400 });
    }
    if (end !== undefined && (typeof end !== "number" || !Number.isFinite(end) || end <= start)) {
      return NextResponse.json({ error: "end must be a number greater than start" }, { status: 400 });
    }

    const configuredBridgeUrl = process.env.RAILWAY_URL ?? process.env.NEXT_PUBLIC_RAILWAY_URL;
    const password = process.env.NEURALBOARD_PASSWORD;
    if (!configuredBridgeUrl || !password) {
      console.error("[api/ytdl] bridge configuration missing", { requestId });
      return NextResponse.json({ error: "Download bridge not configured" }, { status: 500 });
    }

    const bridgeUrl = configuredBridgeUrl.replace(/\/+$/, "");
    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
    console.info("[api/ytdl] download starting", { requestId, youtubeId, start, end });

    const download = await postToBridge(bridgeUrl, password, "/video-download", { url: youtubeUrl });
    if (!download.response.ok) {
      const detail = bridgeErrorText(download.text);
      console.error("[api/ytdl] video-download failed", {
        requestId,
        status: download.response.status,
        detail,
      });
      return NextResponse.json(
        { error: `Download bridge video-download failed (${download.response.status}): ${detail}` },
        { status: 502 },
      );
    }

    const downloadData = parseBridgeFileResponse(download.text);
    if (!downloadData || typeof downloadData.filename !== "string" || typeof downloadData.url !== "string") {
      console.error("[api/ytdl] invalid video-download response", { requestId });
      return NextResponse.json({ error: "Download bridge returned an invalid video-download response" }, { status: 502 });
    }

    let filePath = downloadData.url;
    let filename = downloadData.filename;
    if (typeof end === "number") {
      const trim = await postToBridge(bridgeUrl, password, "/trim", {
        filename,
        startSec: start,
        durationSec: end - start,
      });
      if (!trim.response.ok) {
        const detail = bridgeErrorText(trim.text);
        console.error("[api/ytdl] trim failed", {
          requestId,
          status: trim.response.status,
          detail,
        });
        return NextResponse.json(
          { error: `Download bridge trim failed (${trim.response.status}): ${detail}` },
          { status: 502 },
        );
      }

      const trimData = parseBridgeFileResponse(trim.text);
      if (!trimData || typeof trimData.filename !== "string" || typeof trimData.url !== "string") {
        console.error("[api/ytdl] invalid trim response", { requestId });
        return NextResponse.json({ error: "Download bridge returned an invalid trim response" }, { status: 502 });
      }
      filePath = trimData.url;
      filename = trimData.filename;
    }

    if (!filePath.startsWith("/files/")) {
      console.error("[api/ytdl] invalid file path", { requestId });
      return NextResponse.json({ error: "Download bridge returned an invalid file path" }, { status: 502 });
    }

    const fileResponse = await fetch(`${bridgeUrl}${filePath}`, {
      headers: { "x-neuralboard-password": password },
      cache: "no-store",
    });
    if (!fileResponse.ok || !fileResponse.body) {
      const detail = bridgeErrorText(await fileResponse.text().catch(() => ""));
      console.error("[api/ytdl] file fetch failed", {
        requestId,
        status: fileResponse.status,
        detail,
      });
      return NextResponse.json(
        { error: `Download bridge file fetch failed (${fileResponse.status}): ${detail}` },
        { status: 502 },
      );
    }

    console.info("[api/ytdl] download complete", {
      requestId,
      youtubeId,
      filename,
      durationMs: Date.now() - startedAt,
    });

    const headers = new Headers({
      "Content-Type": fileResponse.headers.get("content-type") ?? "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    });
    const contentLength = fileResponse.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(fileResponse.body, { headers });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[api/ytdl] unexpected failure", {
      requestId,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
