"use client";

import { zipSync, type Zippable } from "fflate";
import { readNbpManifest } from "@/lib/board-library";
import { boardCompositePreview } from "@/lib/simple-world";
import type { PublishStart } from "@/lib/published-boards";

/** Board images are re-encoded to WebP no larger than this on their long side (camera zooms stay sharp at 1080p). */
const IMAGE_LONG_SIDE = 1920;
const IMAGE_QUALITY = 0.78;
/** Feed cards are small; their preview is compressed hard. */
const PREVIEW_LONG_SIDE = 640;
const PREVIEW_QUALITY = 0.6;
const RECOMPRESSIBLE = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

type AssetRef = { assetFile?: unknown; assetMime?: unknown };

function collectAssetRefs(value: unknown, refs: AssetRef[]): void {
  if (Array.isArray(value)) { for (const item of value) collectAssetRefs(item, refs); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.assetFile === "string") refs.push(record as AssetRef);
  for (const child of Object.values(record)) collectAssetRefs(child, refs);
}

async function encodeWebp(source: Blob, longSide: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not compress an image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not compress an image.")), "image/webp", quality));
  } finally {
    bitmap.close();
  }
}

export type PublishPackage = { packageBlob: Blob; previewBlob: Blob };

/**
 * A smaller copy of a .nbp for publishing: every still image is re-encoded to WebP and capped at
 * 1920px, narration and video are kept as they are, and the result is still a valid .nbp the
 * editor loads unchanged. The owner's local file is never modified.
 */
export async function buildPublishPackage(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<PublishPackage> {
  const { manifest, files } = readNbpManifest(new Uint8Array(await file.arrayBuffer()));
  const refs: AssetRef[] = [];
  collectAssetRefs(manifest, refs);
  const mimeByFile = new Map<string, string>();
  for (const ref of refs) if (typeof ref.assetMime === "string") mimeByFile.set(ref.assetFile as string, ref.assetMime.toLowerCase());

  const names = Object.keys(files).filter((name) => name !== "manifest.json");
  const output: Zippable = {};
  const recompressed = new Set<string>();
  for (const [index, name] of names.entries()) {
    const bytes = files[name];
    const mime = mimeByFile.get(name);
    let stored: Uint8Array = bytes;
    if (mime && RECOMPRESSIBLE.has(mime)) {
      try {
        const webp = await encodeWebp(new Blob([bytes.slice().buffer], { type: mime }), IMAGE_LONG_SIDE, IMAGE_QUALITY);
        if (webp.type === "image/webp" && webp.size < bytes.byteLength) {
          stored = new Uint8Array(await webp.arrayBuffer());
          recompressed.add(name);
        }
      } catch {
        // Keep an image the browser cannot decode exactly as saved.
      }
    }
    // Media is already compressed; storing avoids slow, pointless deflate passes.
    output[name] = [stored, { level: 0 }];
    onProgress((index + 1) / Math.max(1, names.length));
  }
  for (const ref of refs) if (recompressed.has(ref.assetFile as string)) ref.assetMime = "image/webp";
  output["manifest.json"] = [new TextEncoder().encode(JSON.stringify(manifest)), { level: 6 }];
  const zipped = zipSync(output);
  const packageBlob = new Blob([zipped.slice().buffer], { type: "application/zip" });

  const composite = await boardCompositePreview(directory, fileName, file);
  const previewBlob = await encodeWebp(composite, PREVIEW_LONG_SIDE, PREVIEW_QUALITY);
  onProgress(1);
  return { packageBlob, previewBlob };
}

/** PUTs one file to a Storage signed upload URL, reporting bytes sent. */
export function uploadToSignedUrl(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("content-type", blob.type);
    request.setRequestHeader("x-upsert", "false");
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { onProgress(blob.size); resolve(); return; }
      reject(new Error(request.status === 413 ? "This board is too large to publish." : `Upload failed (${request.status}).`));
    };
    request.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    request.onabort = () => reject(new DOMException("Publishing was cancelled.", "AbortError"));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(blob);
  });
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body as T;
}

export type PublishPhase = { phase: "compressing" | "uploading" | "finishing"; fraction: number };

/** Compress, upload with progress, then ask the server to verify and list the board. */
export async function publishBoard(input: {
  directory: FileSystemDirectoryHandle;
  fileName: string;
  file: File;
  title: string;
  signal: AbortSignal;
  onProgress: (progress: PublishPhase) => void;
}): Promise<{ id: string; sizeBytes: number }> {
  const { directory, fileName, file, title, signal, onProgress } = input;
  onProgress({ phase: "compressing", fraction: 0 });
  const { packageBlob, previewBlob } = await buildPublishPackage(directory, fileName, file, (fraction) => onProgress({ phase: "compressing", fraction }));
  if (signal.aborted) throw new DOMException("Publishing was cancelled.", "AbortError");

  const start = await json<PublishStart>(await fetch("/api/published-boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ boardKey: fileName, title, packageBytes: packageBlob.size, previewBytes: previewBlob.size }),
    signal,
  }));
  const total = packageBlob.size + previewBlob.size;
  let previewSent = 0;
  let packageSent = 0;
  const report = () => onProgress({ phase: "uploading", fraction: (previewSent + packageSent) / total });
  try {
    report();
    await uploadToSignedUrl(start.uploads.preview, previewBlob, (loaded) => { previewSent = loaded; report(); }, signal);
    await uploadToSignedUrl(start.uploads.package, packageBlob, (loaded) => { packageSent = loaded; report(); }, signal);

    onProgress({ phase: "finishing", fraction: 1 });
    const done = await json<{ sizeBytes: number }>(await fetch(`/api/published-boards/${start.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: start.version, title }),
      signal,
    }));
    return { id: start.id, sizeBytes: done.sizeBytes };
  } catch (error) {
    // Cancelled mid-publish: make sure nothing is left listed (the PATCH may already have landed) or stored.
    if ((error as DOMException)?.name === "AbortError") void unpublishBoard(start.id).catch(() => {});
    throw error;
  }
}

export async function unpublishBoard(id: string): Promise<void> {
  await json<{ ok: true }>(await fetch(`/api/published-boards/${id}`, { method: "DELETE" }));
}
