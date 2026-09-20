import { strToU8, zipSync } from "fflate";
import { readNbpManifest } from "@/lib/board-library";
import {
  WORLD_FILE_NAME,
  assertWorldDocument,
  boardDimensions,
  buildRegion,
  createEmptyWorld,
  parseWorld,
  safeWorldMediaRoot,
  serializeWorld,
  stagingBounds,
  type BoardWorld,
  type WorldAssetReference,
  type WorldRegion,
} from "@/lib/board-world";

type DirectoryWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function cleanSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "") || "asset";
}

async function nestedDirectory(root: FileSystemDirectoryHandle, parts: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(cleanSegment(part), { create });
  return current;
}

async function writeBytes(root: FileSystemDirectoryHandle, relativePath: string, bytes: Uint8Array, mime: string): Promise<void> {
  const parts = relativePath.split("/").filter(Boolean).map(cleanSegment);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Invalid world media path.");
  const directory = await nestedDirectory(root, parts, true);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes.slice().buffer], { type: mime }));
  await writable.close();
}

async function readFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const parts = relativePath.split("/").filter(Boolean).map(cleanSegment);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Invalid world media path.");
  const directory = await nestedDirectory(root, parts, false);
  return (await directory.getFileHandle(fileName)).getFile();
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

export async function loadOrCreateWorld(directory: FileSystemDirectoryHandle): Promise<BoardWorld> {
  try {
    const handle = await directory.getFileHandle(WORLD_FILE_NAME);
    const world = parseWorld(await (await handle.getFile()).text());
    return world;
  } catch (error) {
    if ((error as DOMException)?.name !== "NotFoundError") throw error;
    const world = createEmptyWorld();
    await saveWorld(directory, world);
    return world;
  }
}

export async function saveWorld(directory: FileSystemDirectoryHandle, world: BoardWorld): Promise<void> {
  assertWorldDocument(world);
  const handle = await directory.getFileHandle(WORLD_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([serializeWorld(world)], { type: "application/json" }));
  await writable.close();
}

export async function importBoardAsRegion(
  directory: FileSystemDirectoryHandle,
  world: BoardWorld,
  sourceFile: File,
): Promise<{ world: BoardWorld; region: WorldRegion }> {
  const { manifest: rawManifest, files } = readNbpManifest(new Uint8Array(await sourceFile.arrayBuffer()));
  const manifest = cloneWithoutDataUris(rawManifest) as Record<string, unknown>;
  const dimensions = boardDimensions(manifest);
  const now = new Date().toISOString();
  const regionId = `region_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const mediaRoot = await directory.getDirectoryHandle(world.mediaRoot || safeWorldMediaRoot(), { create: true });
  const assets = await storeArchiveAssets(mediaRoot, regionId, files);

  const bounds = stagingBounds(world, dimensions.width, dimensions.height);
  const title = manifestTitle(manifest, sourceFile.name);
  const region = buildRegion({
    regionId,
    name: title,
    bounds,
    manifest,
    assets,
    source: { kind: "nbp-import", fileName: sourceFile.name, importedAt: now },
    now,
  });
  const nextWorld = { ...world, modifiedAt: now, regions: [...world.regions, region] };
  await saveWorld(directory, nextWorld);
  return { world: nextWorld, region };
}

export async function updateWorldRegion(
  directory: FileSystemDirectoryHandle,
  regionId: string,
  rawManifest: Record<string, unknown>,
  files: Record<string, Uint8Array>,
): Promise<{ world: BoardWorld; region: WorldRegion }> {
  const world = await loadOrCreateWorld(directory);
  const existing = world.regions.find((region) => region.id === regionId);
  if (!existing) throw new Error("This world region no longer exists.");
  const manifest = cloneWithoutDataUris(rawManifest) as Record<string, unknown>;
  const mediaRoot = await directory.getDirectoryHandle(world.mediaRoot || safeWorldMediaRoot(), { create: true });
  const assets = await storeArchiveAssets(mediaRoot, regionId, files);
  const now = new Date().toISOString();
  const region = buildRegion({
    regionId,
    name: manifestTitle(manifest, existing.name),
    bounds: existing.bounds,
    manifest,
    assets,
    source: existing.source,
    now,
  });
  region.createdAt = existing.createdAt;
  const nextWorld = { ...world, modifiedAt: now, regions: world.regions.map((candidate) => candidate.id === regionId ? region : candidate) };
  await saveWorld(directory, nextWorld);
  return { world: nextWorld, region };
}

export async function materializeRegionFile(
  directory: FileSystemDirectoryHandle,
  world: BoardWorld,
  region: WorldRegion,
): Promise<File> {
  const mediaRoot = await directory.getDirectoryHandle(world.mediaRoot);
  const archive: Record<string, Uint8Array> = {};
  for (const asset of region.assets) {
    const file = await readFile(mediaRoot, asset.path);
    archive[asset.archivePath] = new Uint8Array(await file.arrayBuffer());
  }
  archive["manifest.json"] = strToU8(JSON.stringify(region.project.manifest, null, 2));
  const bytes = zipSync(archive, { level: 6 });
  return new File([bytes.slice().buffer], `${cleanSegment(region.name)}.nbp`, { type: "application/zip" });
}

export async function worldMediaUrl(
  directory: FileSystemDirectoryHandle,
  world: BoardWorld,
  relativePath: string,
): Promise<string> {
  const mediaRoot = await directory.getDirectoryHandle(world.mediaRoot);
  return URL.createObjectURL(await readFile(mediaRoot, relativePath));
}

export async function listWorldFiles(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of (directory as DirectoryWithEntries).entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".nbw")) names.push(name);
  }
  return names.sort();
}

function guessMime(fileName: string): string {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function storeArchiveAssets(
  mediaRoot: FileSystemDirectoryHandle,
  regionId: string,
  files: Record<string, Uint8Array>,
): Promise<WorldAssetReference[]> {
  const assets: WorldAssetReference[] = [];
  for (const [archivePath, bytes] of Object.entries(files)) {
    if (archivePath === "manifest.json" || archivePath.endsWith("/")) continue;
    const archiveSegments = archivePath.split("/").filter(Boolean).map(cleanSegment);
    const fileName = archiveSegments.at(-1) ?? "asset";
    const rawMime = guessMime(fileName);
    const path = `regions/${regionId}/files/${archiveSegments.join("/")}`;
    await writeBytes(mediaRoot, path, bytes, rawMime);
    const preview = await imagePreview(bytes, rawMime);
    const previewPath = preview ? `regions/${regionId}/previews/${archiveSegments.join("_").replace(/\.[^.]+$/, "")}.webp` : undefined;
    if (preview && previewPath) await writeBytes(mediaRoot, previewPath, preview, "image/webp");
    assets.push({ archivePath, path, previewPath, mime: rawMime, bytes: bytes.byteLength });
  }
  return assets;
}
