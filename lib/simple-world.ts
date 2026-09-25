import { readNbpManifest } from "@/lib/board-library";
import { BOARD_SURFACE_COLOR } from "@/lib/board-theme";

const DB_NAME = "neuralboard-simple-world";
const DB_VERSION = 1;
const STORE_NAME = "boards";
const COMPOSITE_DIRECTORY = ".neuralboard-space";
const COMPOSITE_LONG_SIDE = 900;
const BOARD_GAP = 1600;

export type SimpleWorldBoard = {
  id: string;
  fileName: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  sourceFileHandle: FileSystemFileHandle;
  previewFileHandle?: FileSystemFileHandle;
  /** Compatibility with previews created by the abandoned separate-world prototype. */
  preview?: Blob;
  addedAt: string;
};

type AddSimpleWorldBoardInput = {
  file: File;
  fileName: string;
  name: string;
  sourceFileHandle: FileSystemFileHandle;
  sourceDirectoryHandle: FileSystemDirectoryHandle;
};

type CompositeMedia = {
  type?: string;
  assetFile?: string;
  assetMime?: string;
  thumbnailDataUri?: string;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  layer?: number;
  rotationDeg?: number;
};

type CompositeAnnotation = {
  type?: string;
  text?: string;
  color?: string;
  fontSize?: number;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  arrowStartX?: number;
  arrowStartY?: number;
  arrowEndX?: number;
  arrowEndY?: number;
  strokeWidth?: number;
  points?: Array<{ x: number; y: number }>;
};

function openWorldDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAllBoards(): Promise<SimpleWorldBoard[]> {
  const db = await openWorldDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as SimpleWorldBoard[]).sort((a, b) => a.addedAt.localeCompare(b.addedAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function listSimpleWorldBoards(): Promise<SimpleWorldBoard[]> {
  if (typeof indexedDB === "undefined") return [];
  return readAllBoards();
}

function dataUriToBlob(dataUri: string): Blob | null {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/.exec(dataUri);
  if (!match) return null;
  try {
    const bytes = dataUri.includes(";base64,")
      ? Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[2]));
    return new Blob([bytes], { type: match[1] || "image/png" });
  } catch {
    return null;
  }
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not create the board composite.")), "image/png");
  });
}

async function drawBlob(context: CanvasRenderingContext2D, blob: Blob, media: CompositeMedia, scale: number): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    const x = Number(media.boardX ?? 0) * scale;
    const y = Number(media.boardY ?? 0) * scale;
    const width = Math.max(1, Number(media.boardW ?? bitmap.width) * scale);
    const height = Math.max(1, Number(media.boardH ?? bitmap.height) * scale);
    context.save();
    context.translate(x + width / 2, y + height / 2);
    context.rotate((Number(media.rotationDeg ?? 0) * Math.PI) / 180);
    context.drawImage(bitmap, -width / 2, -height / 2, width, height);
    context.restore();
    bitmap.close();
    return true;
  } catch {
    // This one-time composite pass never retries an asset that cannot be decoded.
    return false;
  }
}

function drawAnnotation(context: CanvasRenderingContext2D, annotation: CompositeAnnotation, scale: number): void {
  const x = Number(annotation.boardX ?? 0) * scale;
  const y = Number(annotation.boardY ?? 0) * scale;
  const width = Number(annotation.boardW ?? 0) * scale;
  const height = Number(annotation.boardH ?? 0) * scale;
  context.save();
  context.strokeStyle = annotation.color || "#cc2200";
  context.fillStyle = annotation.color || "#2a2a2a";
  context.lineWidth = Math.max(1, Number(annotation.strokeWidth ?? 3) * scale);
  if (annotation.type === "text" || annotation.type === "emoji") {
    context.font = `${Math.max(8, Number(annotation.fontSize ?? 80) * scale)}px Caveat, Georgia, serif`;
    context.textBaseline = "top";
    context.fillText(annotation.text || "", x, y, Math.max(1, width));
  } else if (annotation.type === "circle") {
    context.beginPath();
    context.ellipse(x + width / 2, y + height / 2, Math.abs(width / 2), Math.abs(height / 2), 0, 0, Math.PI * 2);
    context.stroke();
  } else if (annotation.type === "arrow") {
    context.beginPath();
    context.moveTo(Number(annotation.arrowStartX ?? annotation.boardX ?? 0) * scale, Number(annotation.arrowStartY ?? annotation.boardY ?? 0) * scale);
    context.lineTo(Number(annotation.arrowEndX ?? annotation.boardX ?? 0) * scale, Number(annotation.arrowEndY ?? annotation.boardY ?? 0) * scale);
    context.stroke();
  } else if (annotation.points?.length) {
    context.beginPath();
    annotation.points.forEach((point, index) => index ? context.lineTo(point.x * scale, point.y * scale) : context.moveTo(point.x * scale, point.y * scale));
    context.stroke();
  } else {
    context.strokeRect(x, y, width, height);
  }
  context.restore();
}

async function generateComposite(file: File): Promise<{ blob: Blob; width: number; height: number; boardWidth: number; boardHeight: number }> {
  const { manifest, files } = readNbpManifest(new Uint8Array(await file.arrayBuffer()));
  const board = manifest.board as { dimensions?: { width?: number; height?: number }; media?: CompositeMedia[] } | undefined;
  const boardWidth = Math.max(1, Number(board?.dimensions?.width ?? 4000));
  const boardHeight = Math.max(1, Number(board?.dimensions?.height ?? 3000));
  const scale = Math.min(1, COMPOSITE_LONG_SIDE / Math.max(boardWidth, boardHeight));
  const width = Math.max(1, Math.round(boardWidth * scale));
  const height = Math.max(1, Math.round(boardHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the board composite.");
  context.fillStyle = BOARD_SURFACE_COLOR;
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "medium";

  let drawnMedia = 0;
  const mediaItems = [...(board?.media ?? [])].sort((a, b) => Number(a.layer ?? 0) - Number(b.layer ?? 0));
  for (const media of mediaItems) {
    if (media.type !== "image" && media.type !== "video") continue;
    const assetBytes = media.assetFile ? files[media.assetFile] : undefined;
    const blob = assetBytes
      ? new Blob([assetBytes.slice().buffer], { type: media.assetMime || "image/png" })
      : media.thumbnailDataUri ? dataUriToBlob(media.thumbnailDataUri) : null;
    if (blob && await drawBlob(context, blob, media, scale)) drawnMedia += 1;
  }
  for (const annotation of (manifest.annotations as CompositeAnnotation[] | undefined) ?? []) drawAnnotation(context, annotation, scale);

  if (drawnMedia === 0 && manifest.snapshot?.thumbnailDataUri) {
    const snapshot = dataUriToBlob(manifest.snapshot.thumbnailDataUri);
    if (snapshot) {
      try {
        const bitmap = await createImageBitmap(snapshot);
        const fit = Math.min(width / bitmap.width, height / bitmap.height);
        const drawWidth = bitmap.width * fit;
        const drawHeight = bitmap.height * fit;
        context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        bitmap.close();
      } catch {
        // The parchment is the accurate representation of an empty/undecodable board.
      }
    }
  }
  return { blob: await canvasPng(canvas), width, height, boardWidth, boardHeight };
}

function compositeFileName(sourceFileName: string): string {
  const safe = sourceFileName.replace(/\.nbp$/i, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 100) || "board";
  return `${safe}.png`;
}

async function writeComposite(directory: FileSystemDirectoryHandle, fileName: string, blob: Blob): Promise<FileSystemFileHandle> {
  const compositeDirectory = await directory.getDirectoryHandle(COMPOSITE_DIRECTORY, { create: true });
  const handle = await compositeDirectory.getFileHandle(compositeFileName(fileName), { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle;
}

export async function addSimpleWorldBoard(input: AddSimpleWorldBoardInput): Promise<SimpleWorldBoard> {
  const current = await readAllBoards();
  const existing = current.find((board) => board.fileName === input.fileName);
  if (existing) return existing;
  const composite = await generateComposite(input.file);
  const previewFileHandle = await writeComposite(input.sourceDirectoryHandle, input.fileName, composite.blob);
  const index = current.length;
  const column = index % 2;
  const row = Math.floor(index / 2);
  const board: SimpleWorldBoard = {
    id: input.fileName,
    fileName: input.fileName,
    name: input.name,
    x: (column + 1) * (composite.boardWidth + BOARD_GAP),
    y: row * (composite.boardHeight + BOARD_GAP),
    width: composite.boardWidth,
    height: composite.boardHeight,
    previewWidth: composite.width,
    previewHeight: composite.height,
    sourceFileHandle: input.sourceFileHandle,
    previewFileHandle,
    addedAt: new Date().toISOString(),
  };
  const db = await openWorldDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).add(board);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  return board;
}

type PermissionFileHandle = FileSystemFileHandle & {
  queryPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: "read" }) => Promise<PermissionState>;
};

async function readableFile(handle: FileSystemFileHandle): Promise<File> {
  const permissionHandle = handle as PermissionFileHandle;
  if (permissionHandle.queryPermission) {
    const current = await permissionHandle.queryPermission({ mode: "read" });
    if (current !== "granted") {
      const requested = await permissionHandle.requestPermission?.({ mode: "read" });
      if (requested !== "granted") throw new Error("Board file permission was not granted. Add the board from the Library again.");
    }
  }
  return handle.getFile();
}

export async function openSimpleWorldBoardFile(board: SimpleWorldBoard): Promise<File> {
  return readableFile(board.sourceFileHandle);
}

export async function openSimpleWorldPreviewFile(board: SimpleWorldBoard): Promise<Blob> {
  if (board.previewFileHandle) return readableFile(board.previewFileHandle);
  if (board.preview) return board.preview;
  throw new Error(`No composite exists for “${board.name}”. Add it from the Library again.`);
}
