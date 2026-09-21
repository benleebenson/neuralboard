import { readNbpManifest } from "@/lib/board-library";
import {
  assetStoragePath,
  boardDimensions,
  buildRegion,
  growRegionBounds,
  previewStoragePath,
  stagingPlacement,
  type BoardWorld,
  type WorldAsset,
  type WorldRegion,
} from "@/lib/world/world-model";
import {
  collectWorldGarbage,
  fileExists,
  mediaRootOf,
  readIndex,
  serialized,
  writeBytes,
  writeIndex,
  writeRegionFile,
} from "@/lib/world/world-store";

/**
 * Turning a board archive (.nbp) into a region, and writing an edited region back.
 *
 * What import does with each part of a board (the whole manifest is kept verbatim, so nothing is
 * lost or re-interpreted):
 *  - media / annotations / layout  → stored in the region file's manifest; media bytes move to the
 *    content-addressed `assets/` folder and the manifest keeps its original archive paths.
 *  - timeline blocks, camera keyframes, character actions, narration → in the manifest untouched.
 *    They come back exactly as saved when the region is opened, because opening rebuilds a real
 *    .nbp and hands it to the editor's existing loader.
 *  - inline base64 (`data:` URIs, e.g. the snapshot thumbnail) → stripped; the world stores
 *    references only.
 *  - the source .nbp → only ever read. It is never opened for writing.
 */

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function imagePreview(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (!mime.startsWith("image/") || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: mime }));
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.68 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function cloneWithoutDataUris(value: unknown): unknown {
  if (typeof value === "string" && /^data:[^;,]+;base64,/i.test(value)) return undefined;
  if (Array.isArray(value)) return value.map(cloneWithoutDataUris).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const cleaned = cloneWithoutDataUris(child);
    return cleaned === undefined ? [] : [[key, cleaned]];
  }));
}

function manifestTitle(manifest: Record<string, unknown>, fallback: string): string {
  const meta = manifest.meta && typeof manifest.meta === "object" ? manifest.meta as Record<string, unknown> : {};
  const candidate = meta.title ?? manifest.name;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : fallback.replace(/\.nbp$/i, "");
}

function guessMime(fileName: string): string {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

export type StoreStats = { assetsWritten: number; assetsReused: number; bytesWritten: number; bytesReused: number };

async function storeArchiveAssets(
  mediaRoot: FileSystemDirectoryHandle,
  files: Record<string, Uint8Array>,
): Promise<{ assets: WorldAsset[]; stats: StoreStats }> {
  const assets: WorldAsset[] = [];
  const stats: StoreStats = { assetsWritten: 0, assetsReused: 0, bytesWritten: 0, bytesReused: 0 };
  for (const [archivePath, bytes] of Object.entries(files)) {
    if (archivePath === "manifest.json" || archivePath.endsWith("/")) continue;
    const baseName = archivePath.split("/").filter(Boolean).at(-1) ?? "asset";
    const rawExtension = baseName.includes(".") ? baseName.split(".").at(-1)!.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) : "";
    const file = `${await contentHash(bytes)}.${rawExtension || "bin"}`;
    const mime = guessMime(baseName);
    if (await fileExists(mediaRoot, assetStoragePath(file))) {
      stats.assetsReused += 1;
      stats.bytesReused += bytes.byteLength;
    } else {
      await writeBytes(mediaRoot, assetStoragePath(file), bytes, mime);
      stats.assetsWritten += 1;
      stats.bytesWritten += bytes.byteLength;
    }
    let preview = false;
    if (mime.startsWith("image/")) {
      if (await fileExists(mediaRoot, previewStoragePath(file))) preview = true;
      else {
        const generated = await imagePreview(bytes, mime);
        if (generated) { await writeBytes(mediaRoot, previewStoragePath(file), generated, "image/webp"); preview = true; }
      }
    }
    assets.push({ archivePath, file, preview, mime, bytes: bytes.byteLength });
  }
  return { assets, stats };
}

/** Places a .nbp into the world's staging strip as a new region. The source file is only read. */
export function importBoardAsRegion(
  directory: FileSystemDirectoryHandle,
  sourceFile: File,
): Promise<{ world: BoardWorld; region: WorldRegion; stats: StoreStats }> {
  return serialized(async () => {
    const world = await readIndex(directory);
    const { manifest: rawManifest, files } = readNbpManifest(new Uint8Array(await sourceFile.arrayBuffer()));
    const manifest = cloneWithoutDataUris(rawManifest) as Record<string, unknown>;
    const dimensions = boardDimensions(manifest);
    const now = new Date().toISOString();
    const { assets, stats } = await storeArchiveAssets(await mediaRootOf(directory, world, true), files);
    const placement = stagingPlacement(world, dimensions.width, dimensions.height);
    const { region, file } = buildRegion({
      name: manifestTitle(manifest, sourceFile.name),
      bounds: placement.bounds,
      manifest,
      assets,
      source: { kind: "nbp-import", fileName: sourceFile.name, importedAt: now },
      now,
    });
    const nextWorld = { ...world, modifiedAt: now, staging: placement.origin, regions: [...world.regions, region] };
    await writeRegionFile(directory, nextWorld, file);
    await writeIndex(directory, nextWorld);
    return { world: nextWorld, region, stats };
  });
}

/** Writes an edited region back: new manifest, new assets, refreshed LOD data. The region's place in the world is kept. */
export function updateWorldRegion(
  directory: FileSystemDirectoryHandle,
  regionId: string,
  rawManifest: Record<string, unknown>,
  files: Record<string, Uint8Array>,
): Promise<{ world: BoardWorld; region: WorldRegion }> {
  const saved = serialized(async () => {
    const world = await readIndex(directory);
    const existing = world.regions.find((region) => region.id === regionId);
    if (!existing) throw new Error("This world region no longer exists.");
    const manifest = cloneWithoutDataUris(rawManifest) as Record<string, unknown>;
    const { assets } = await storeArchiveAssets(await mediaRootOf(directory, world, true), files);
    const now = new Date().toISOString();
    const { region, file } = buildRegion({
      regionId,
      name: manifestTitle(manifest, existing.name),
      // The editor lets a board grow past its starting size. Keep the region as large as its board
      // whenever that would not run into a neighbour.
      bounds: growRegionBounds(world, existing, boardDimensions(manifest)),
      manifest,
      assets,
      source: existing.source,
      createdAt: existing.createdAt,
      now,
    });
    const nextWorld = { ...world, modifiedAt: now, regions: world.regions.map((candidate) => candidate.id === regionId ? region : candidate) };
    await writeRegionFile(directory, nextWorld, file);
    await writeIndex(directory, nextWorld);
    return { world: nextWorld, region, dropped: existing.refs.some((ref) => !region.refs.includes(ref)) };
  });
  return saved.then(({ dropped, ...result }) => {
    // Assets the saved manifest no longer uses become garbage; sweep in the background.
    if (dropped) void collectWorldGarbage(directory).catch(() => undefined);
    return result;
  });
}
