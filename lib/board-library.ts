import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { extractBoardStyleSummary, type BoardStyleSummary } from "@/lib/board2/style-exemplars";

export const BOARD_LIBRARY_PENDING_FILE = "nb_board_library_pending_file";
const DB_NAME = "neuralboard-library";
const STORE_NAME = "handles";
const HANDLE_KEY = "boards-directory";

export type BoardLibraryMeta = {
  id: string;
  title: string;
  aspectRatio?: string;
  duration: number;
  createdAt: string;
  modifiedAt: string;
  trainingExample: boolean;
};

export type BoardLibraryEntry = {
  fileName: string;
  file: File;
  meta: BoardLibraryMeta;
  thumbnailDataUri?: string;
  styleSummary?: BoardStyleSummary;
};
export type NbpManifest = {
  schemaVersion?: number;
  name?: string;
  savedAt?: string;
  meta?: Record<string, unknown>;
  snapshot?: { thumbnailDataUri?: string };
  [key: string]: unknown;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};
type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

const styleSummaryCache = new Map<string, BoardStyleSummary>();

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function persistDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function supportsBoardDirectory(): boolean {
  return typeof window !== "undefined" && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

export async function getBoardsDirectory(options: { prompt: boolean; write?: boolean }): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsBoardDirectory()) return null;
  let handle = await storedDirectory();
  const permission = options.write ? "readwrite" : "read";
  if (handle) {
    const permissionHandle = handle as PermissionDirectoryHandle;
    const current = await permissionHandle.queryPermission({ mode: permission });
    if (current !== "granted" && options.prompt) {
      const requested = await permissionHandle.requestPermission({ mode: permission });
      if (requested !== "granted") handle = null;
    } else if (current !== "granted") {
      return null;
    }
  }
  if (!handle && options.prompt) {
    handle = await (window as DirectoryPickerWindow).showDirectoryPicker?.({ id: "neuralboard-boards", mode: "readwrite" }) ?? null;
    if (handle) await persistDirectory(handle);
  }
  return handle;
}

export function safeBoardFilename(title: string, id: string): string {
  const safeTitle = title.trim().replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "board";
  return `${safeTitle}-${id}.nbp`;
}

export function readNbpManifest(bytes: Uint8Array): { manifest: NbpManifest; files: Record<string, Uint8Array> } {
  const files = unzipSync(bytes);
  if (!files["manifest.json"]) throw new Error("Not a valid .nbp file");
  return { manifest: JSON.parse(strFromU8(files["manifest.json"])), files };
}

export function replaceNbpManifest(files: Record<string, Uint8Array>, manifest: NbpManifest): Uint8Array {
  return zipSync({ ...files, "manifest.json": strToU8(JSON.stringify(manifest, null, 2)) }, { level: 6 });
}

function normalizeMeta(manifest: NbpManifest, file: File): BoardLibraryMeta {
  const raw = manifest.meta ?? {};
  return {
    id: String(raw.id ?? raw.projectId ?? file.name.replace(/\.nbp$/i, "")),
    title: String(raw.title ?? manifest.name ?? file.name.replace(/\.nbp$/i, "")),
    aspectRatio: typeof raw.aspectRatio === "string" ? raw.aspectRatio : undefined,
    duration: Number(raw.duration ?? raw.totalDurationSec ?? 0),
    createdAt: String(raw.createdAt ?? raw.modifiedAt ?? new Date(file.lastModified).toISOString()),
    modifiedAt: String(raw.modifiedAt ?? manifest.savedAt ?? new Date(file.lastModified).toISOString()),
    trainingExample: raw.trainingExample === true,
  };
}

export async function listBoards(handle: FileSystemDirectoryHandle): Promise<BoardLibraryEntry[]> {
  const entries: BoardLibraryEntry[] = [];
  for await (const [fileName, child] of (handle as PermissionDirectoryHandle).entries()) {
    if (child.kind !== "file" || !fileName.toLowerCase().endsWith(".nbp")) continue;
    try {
      const file = await (child as FileSystemFileHandle).getFile();
      const { manifest } = readNbpManifest(new Uint8Array(await file.arrayBuffer()));
      const meta = normalizeMeta(manifest, file);
      const cacheKey = `${fileName}:${file.lastModified}:${file.size}`;
      let styleSummary: BoardStyleSummary | undefined;
      if (meta.trainingExample) {
        styleSummary = styleSummaryCache.get(cacheKey) ?? extractBoardStyleSummary(manifest);
        styleSummaryCache.set(cacheKey, styleSummary);
      }
      entries.push({ fileName, file, meta, thumbnailDataUri: manifest.snapshot?.thumbnailDataUri, styleSummary });
    } catch {
      // Ignore malformed files: the chosen folder may contain unrelated downloads.
    }
  }
  return entries.sort((a, b) => b.meta.modifiedAt.localeCompare(a.meta.modifiedAt));
}

export async function loadStarredBoardStyleSummaries(handle: FileSystemDirectoryHandle): Promise<BoardStyleSummary[]> {
  const entries = await listBoards(handle);
  return entries.flatMap((entry) => entry.meta.trainingExample && entry.styleSummary ? [entry.styleSummary] : []);
}

export async function writeBoardFile(handle: FileSystemDirectoryHandle, fileName: string, bytes: Uint8Array): Promise<void> {
  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new Blob([bytes.slice().buffer], { type: "application/zip" }));
  await writable.close();
}

export async function updateTrainingFlag(handle: FileSystemDirectoryHandle, entry: BoardLibraryEntry, value: boolean): Promise<void> {
  const parsed = readNbpManifest(new Uint8Array(await entry.file.arrayBuffer()));
  parsed.manifest.meta = { ...(parsed.manifest.meta ?? {}), trainingExample: value, modifiedAt: new Date().toISOString() };
  await writeBoardFile(handle, entry.fileName, replaceNbpManifest(parsed.files, parsed.manifest));
}
