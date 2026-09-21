import { strToU8, zipSync } from "fflate";
import {
  WORLD_FILE_NAME,
  assertWorldDocument,
  assetStoragePath,
  createEmptyWorld,
  parseRegionFile,
  parseWorld,
  previewFileName,
  regionFilePath,
  safeWorldMediaRoot,
  serializeRegionFile,
  serializeWorld,
  translateManifestItems,
  type BoardWorld,
  type ItemMoves,
  type WorldRegion,
  type WorldRegionFile,
} from "@/lib/world/world-model";

/**
 * World persistence: the .nbw index, per-region files and the shared media folder, all inside a
 * folder the user granted through the File System Access API (the same folder as their .nbp boards).
 * Importing boards into regions lives in region-import.ts.
 */

type DirectoryWithEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** Files younger than this are never garbage-collected: they may belong to an import in another tab that has not reached its index write yet. */
export const GC_GRACE_MS = 10 * 60_000;

// Every world write goes through one queue. createWritable() swaps files atomically on close, so a
// single file is never torn, but two overlapping read-modify-write operations would still lose updates.
let writeChain: Promise<unknown> = Promise.resolve();
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

function cleanSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "") || "asset";
}

async function nestedDirectory(root: FileSystemDirectoryHandle, parts: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(cleanSegment(part), { create });
  return current;
}

function splitPath(relativePath: string): { directories: string[]; fileName: string } {
  const parts = relativePath.split("/").filter(Boolean).map(cleanSegment);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Invalid world media path.");
  return { directories: parts, fileName };
}

export async function writeBytes(root: FileSystemDirectoryHandle, relativePath: string, data: Uint8Array | string, mime: string): Promise<void> {
  const { directories, fileName } = splitPath(relativePath);
  const directory = await nestedDirectory(root, directories, true);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([typeof data === "string" ? data : data.slice().buffer], { type: mime }));
  await writable.close();
}

async function readFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const { directories, fileName } = splitPath(relativePath);
  const directory = await nestedDirectory(root, directories, false);
  return (await directory.getFileHandle(fileName)).getFile();
}

export async function fileExists(root: FileSystemDirectoryHandle, relativePath: string): Promise<boolean> {
  try { await readFile(root, relativePath); return true; }
  catch (error) {
    const name = (error as DOMException)?.name;
    if (name === "NotFoundError" || name === "TypeMismatchError") return false;
    throw error;
  }
}

// ── index + region files ────────────────────────────────────────────────────

export async function readIndex(directory: FileSystemDirectoryHandle): Promise<BoardWorld> {
  const handle = await directory.getFileHandle(WORLD_FILE_NAME);
  return parseWorld(await (await handle.getFile()).text());
}

export async function writeIndex(directory: FileSystemDirectoryHandle, world: BoardWorld): Promise<void> {
  assertWorldDocument(world);
  const handle = await directory.getFileHandle(WORLD_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([serializeWorld(world)], { type: "application/json" }));
  await writable.close();
}

export async function mediaRootOf(directory: FileSystemDirectoryHandle, world: BoardWorld, create: boolean): Promise<FileSystemDirectoryHandle> {
  return directory.getDirectoryHandle(world.mediaRoot || safeWorldMediaRoot(), { create });
}

export async function writeRegionFile(directory: FileSystemDirectoryHandle, world: BoardWorld, file: WorldRegionFile): Promise<void> {
  await writeBytes(await mediaRootOf(directory, world, true), regionFilePath(file.id), serializeRegionFile(file), "application/json");
}

export async function readRegionFile(directory: FileSystemDirectoryHandle, world: BoardWorld, regionId: string): Promise<WorldRegionFile> {
  let text: string;
  try { text = await (await readFile(await mediaRootOf(directory, world, false), regionFilePath(regionId))).text(); }
  catch (error) {
    if ((error as DOMException)?.name === "NotFoundError") throw new Error(`The file for this region (${regionFilePath(regionId)}) is missing from the world's media folder.`);
    throw error;
  }
  return parseRegionFile(text, regionId);
}

export async function loadOrCreateWorld(directory: FileSystemDirectoryHandle): Promise<BoardWorld> {
  try {
    return await readIndex(directory);
  } catch (error) {
    if ((error as DOMException)?.name !== "NotFoundError") throw error;
    return serialized(async () => {
      // Another tab may have created it while we waited for the queue.
      try { return await readIndex(directory); }
      catch (again) { if ((again as DOMException)?.name !== "NotFoundError") throw again; }
      const world = createEmptyWorld();
      await writeIndex(directory, world);
      return world;
    });
  }
}

/** Writes the index only. Use `commitRegionChanges` when a region file changed too. */
export function saveWorld(directory: FileSystemDirectoryHandle, world: BoardWorld): Promise<void> {
  return serialized(() => writeIndex(directory, world));
}

/** Region files first, index last: the index is the commit point, so a crash never leaves it pointing at a missing file. */
export function commitRegionChanges(directory: FileSystemDirectoryHandle, world: BoardWorld, files: readonly WorldRegionFile[]): Promise<void> {
  return serialized(async () => {
    for (const file of files) await writeRegionFile(directory, world, file);
    await writeIndex(directory, world);
  });
}

/**
 * Persists a drag of media items: rewrites each affected region's manifest, then the index.
 * `world` is the in-memory index whose placements already reflect the move.
 */
export function commitItemMoves(directory: FileSystemDirectoryHandle, world: BoardWorld, moves: ItemMoves): Promise<void> {
  return serialized(async () => {
    const files: WorldRegionFile[] = [];
    for (const [regionId, regionMoves] of moves) {
      const file = await readRegionFile(directory, world, regionId);
      files.push({ ...file, savedAt: new Date().toISOString(), manifest: translateManifestItems(file.manifest, regionMoves) });
    }
    for (const file of files) await writeRegionFile(directory, world, file);
    await writeIndex(directory, world);
  });
}

export async function materializeRegionFile(
  directory: FileSystemDirectoryHandle,
  world: BoardWorld,
  region: WorldRegion,
): Promise<File> {
  const mediaRoot = await mediaRootOf(directory, world, false);
  const regionFile = await readRegionFile(directory, world, region.id);
  const archive: Record<string, Uint8Array> = {};
  for (const asset of regionFile.assets) {
    const file = await readFile(mediaRoot, assetStoragePath(asset.file));
    archive[asset.archivePath] = new Uint8Array(await file.arrayBuffer());
  }
  archive["manifest.json"] = strToU8(JSON.stringify(regionFile.manifest, null, 2));
  const bytes = zipSync(archive, { level: 6 });
  return new File([bytes.slice().buffer], `${cleanSegment(region.name)}.nbp`, { type: "application/zip" });
}

export async function readWorldMedia(
  directory: FileSystemDirectoryHandle,
  world: BoardWorld,
  relativePath: string,
): Promise<File> {
  return readFile(await mediaRootOf(directory, world, false), relativePath);
}

export async function listWorldFiles(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of (directory as DirectoryWithEntries).entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".nbw")) names.push(name);
  }
  return names.sort();
}

// ── garbage collection ──────────────────────────────────────────────────────

export type GcResult = { removedFiles: number; removedBytes: number; keptYoung: number };

/**
 * Deletes asset, preview and region files that no region in the on-disk index references.
 * The index is re-read here rather than taken from memory, and anything modified within
 * `graceMs` is left alone (an import in another tab writes its files before its index).
 */
export function collectWorldGarbage(
  directory: FileSystemDirectoryHandle,
  options: { graceMs?: number; now?: number } = {},
): Promise<GcResult> {
  const graceMs = options.graceMs ?? GC_GRACE_MS;
  return serialized(async () => {
    const world = await readIndex(directory);
    const now = options.now ?? Date.now();
    const referencedAssets = new Set<string>();
    const referencedPreviews = new Set<string>();
    const referencedRegions = new Set<string>();
    for (const region of world.regions) {
      referencedRegions.add(`${region.id}.json`);
      for (const ref of region.refs) { referencedAssets.add(ref); referencedPreviews.add(previewFileName(ref)); }
    }
    const result: GcResult = { removedFiles: 0, removedBytes: 0, keptYoung: 0 };
    let mediaRoot: FileSystemDirectoryHandle;
    try { mediaRoot = await mediaRootOf(directory, world, false); }
    catch { return result; }

    const sweep = async (folder: FileSystemDirectoryHandle, referenced: ReadonlySet<string>) => {
      const doomed: string[] = [];
      for await (const [name, handle] of (folder as DirectoryWithEntries).entries()) {
        if (handle.kind !== "file" || referenced.has(name)) continue;
        const info = await (handle as FileSystemFileHandle).getFile();
        if (now - info.lastModified < graceMs) { result.keptYoung += 1; continue; }
        result.removedBytes += info.size;
        doomed.push(name);
      }
      for (const name of doomed) { await folder.removeEntry(name); result.removedFiles += 1; }
    };
    const sweepSharded = async (rootName: string, referenced: ReadonlySet<string>) => {
      let root: FileSystemDirectoryHandle;
      try { root = await mediaRoot.getDirectoryHandle(rootName); } catch { return; }
      const shards: FileSystemDirectoryHandle[] = [];
      for await (const [, handle] of (root as DirectoryWithEntries).entries()) if (handle.kind === "directory") shards.push(handle as FileSystemDirectoryHandle);
      for (const shard of shards) await sweep(shard, referenced);
    };
    await sweepSharded("assets", referencedAssets);
    await sweepSharded("previews", referencedPreviews);
    try { await sweep(await mediaRoot.getDirectoryHandle("regions"), referencedRegions); } catch { /* no regions folder yet */ }
    return result;
  });
}
