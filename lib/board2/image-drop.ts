const IMAGE_SRC_PATTERN = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
export const BOARD_DROP_STRING_TYPES = new Set(["text/uri-list", "text/html", "text/plain"]);

export type ExtendedDataTransferItem = {
  kind: string;
  type: string;
  getAsFile?: () => Blob | null | PromiseLike<Blob | null>;
  getAsBlob?: () => Blob | null | PromiseLike<Blob | null>;
  getType?: (type: string) => Blob | null | PromiseLike<Blob | null>;
  getAsFileSystemHandle?: () => PromiseLike<{
    kind?: string;
    getFile?: () => PromiseLike<File>;
  } | null>;
  webkitGetAsEntry?: () => {
    isFile?: boolean;
    file?: (success: (file: File) => void, failure?: () => void) => void;
  } | null;
  getAsString?: (callback: (value: string) => void) => void;
};

export type DroppedBlob = { blob: Blob; declaredType: string };

export function centeredBoardDropPosition(options: {
  dropX: number;
  dropY: number;
  imageWidth: number;
  imageHeight: number;
  boardWidth: number;
  boardHeight: number;
}): { boardX: number; boardY: number } {
  const maxX = Math.max(0, options.boardWidth - options.imageWidth);
  const maxY = Math.max(0, options.boardHeight - options.imageHeight);
  return {
    boardX: Math.min(maxX, Math.max(0, options.dropX - options.imageWidth / 2)),
    boardY: Math.min(maxY, Math.max(0, options.dropY - options.imageHeight / 2)),
  };
}

type DropDataTransferLike = {
  files?: ArrayLike<Blob>;
  items?: ArrayLike<ExtendedDataTransferItem>;
  types?: ArrayLike<string>;
};

export function isBoardMediaFile(file: Blob): boolean {
  return file.type.startsWith("image/") || file.type.startsWith("video/");
}

export function boardDropMayContainMedia(dataTransfer: DropDataTransferLike): boolean {
  const files = Array.from(dataTransfer.files ?? []);
  if (files.some(isBoardMediaFile)) return true;
  const items = Array.from(dataTransfer.items ?? []);
  if (items.some((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/") || item.type.startsWith("video/")))) return true;
  const types = Array.from(dataTransfer.types ?? []);
  if (types.some((type) => type.toLowerCase() === "files")) return true;
  return types.some((type) => BOARD_DROP_STRING_TYPES.has(type.toLowerCase()));
}

// `getAsFile()` is synchronous in the standard API, but macOS/WebKit integrations and browser
// shims can expose the promised Blob through adjacent async item APIs. Call every accessor while
// the drop event's protected data store is still readable, then resolve the captured values.
export function imageBlobFromTransferItem(item: ExtendedDataTransferItem): Promise<DroppedBlob | null> | null {
  // Some OS drags advertise an empty MIME type until their promised file resolves.
  if (item.kind !== "file" || (item.type && !item.type.startsWith("image/"))) return null;
  const candidates: Array<PromiseLike<Blob | null> | Blob | null> = [];
  try { candidates.push(item.getAsFile?.() ?? null); } catch { /* Try the async variants. */ }
  try { candidates.push(item.getAsBlob?.() ?? null); } catch { /* Try the remaining variants. */ }
  if (item.type) {
    try { candidates.push(item.getType?.(item.type) ?? null); } catch { /* Try the remaining variants. */ }
  }
  try {
    const handle = item.getAsFileSystemHandle?.();
    if (handle) {
      candidates.push(Promise.resolve(handle).then((value) => value?.kind === "file" && value.getFile ? value.getFile() : null));
    }
  } catch { /* Fall through to the legacy entry API. */ }
  try {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isFile && entry.file) {
      candidates.push(new Promise<File | null>((resolve) => entry.file?.(resolve, () => resolve(null))));
    }
  } catch { /* The standard getAsFile candidate may still succeed. */ }

  return (async () => {
    for (const candidate of candidates) {
      try {
        const blob = await Promise.resolve(candidate);
        if (blob instanceof Blob && (blob.type.startsWith("image/") || item.type.startsWith("image/"))) {
          return { blob, declaredType: item.type };
        }
      } catch {
        // A browser may advertise more than one accessor while only one is usable.
      }
    }
    return null;
  })();
}

export function stringFromTransferItem(item: ExtendedDataTransferItem): Promise<{ type: string; value: string }> | null {
  if (item.kind !== "string" || !BOARD_DROP_STRING_TYPES.has(item.type.toLowerCase())) return null;
  if (!item.getAsString) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve({ type: item.type.toLowerCase(), value });
    };
    try {
      item.getAsString?.(finish);
      setTimeout(() => finish(""), 1000);
    } catch {
      finish("");
    }
  });
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos);/gi, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (entity.toLowerCase() === "&amp;") return "&";
    if (entity.toLowerCase() === "&quot;") return '"';
    if (entity.toLowerCase() === "&apos;") return "'";
    return entity;
  });
}

export function imageSourceFromHtml(html: string): string | null {
  const match = IMAGE_SRC_PATTERN.exec(html);
  const source = match?.[1] ?? match?.[2] ?? match?.[3];
  return source ? decodeHtmlAttribute(source.trim()) : null;
}

export function firstUriListEntry(uriList: string): string | null {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? null;
}

export function normalizeDroppedImageUrl(candidate: string | null | undefined, baseUrl?: string): string | null {
  const value = candidate?.trim();
  if (!value) return null;
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "blob:") return url.toString();
    if (url.protocol === "data:" && /^data:image\//i.test(value)) return value;
  } catch {
    return null;
  }
  return null;
}

export function droppedImageUrl(
  payload: { uriList?: string; html?: string; plainText?: string },
  baseUrl?: string,
): string | null {
  const candidates = [
    imageSourceFromHtml(payload.html ?? ""),
    firstUriListEntry(payload.uriList ?? ""),
    payload.plainText,
  ];
  for (const candidate of candidates) {
    const url = normalizeDroppedImageUrl(candidate, baseUrl);
    if (url) return url;
  }
  return null;
}

export function extensionForImageType(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
  if (!subtype) return "png";
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return subtype.replace(/[^a-z0-9.+-]/g, "") || "png";
}
