// Client side of the Asset Library auto-save. Two production failures shaped this:
//  - Every board image fired its own POST at once, so a 45-image board meant 45 concurrent
//    function invocations, each running sharp + a vision call + an embedding + a Storage upload.
//  - Local images are sent as multipart through the function body, which Vercel caps at 4.5 MB
//    (it answers 413 before the route runs). The server stores at most 1800 px WebP anyway, so
//    oversized images are shrunk to that here before upload.

// Vercel's request body cap is 4.5 MB; leave room for the multipart envelope and fields.
export const ASSET_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const ASSET_UPLOAD_MAX_EDGE = 1800;

export function createTaskQueue(concurrency: number) {
  const limit = Math.max(1, Math.floor(concurrency));
  let running = 0;
  const waiting: Array<() => void> = [];
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        running++;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          running--;
          waiting.shift()?.();
        });
      };
      if (running < limit) run();
      else waiting.push(run);
    });
  };
}

export type ImageReencoder = (blob: Blob, maxEdge: number, quality: number) => Promise<Blob>;

const browserReencode: ImageReencoder = async (blob, maxEdge, quality) => {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D context for image re-encode");
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/webp", quality });
  } finally {
    bitmap.close();
  }
};

// The blob to upload, or null when it cannot be brought under the body limit (the caller skips the
// upload instead of sending a request that is certain to 413).
export async function imageForAssetUpload(
  blob: Blob,
  options: { maxBytes?: number; maxEdge?: number; reencode?: ImageReencoder } = {},
): Promise<Blob | null> {
  const maxBytes = options.maxBytes ?? ASSET_UPLOAD_MAX_BYTES;
  if (blob.size <= maxBytes) return blob;
  const reencode = options.reencode ?? browserReencode;
  const maxEdge = options.maxEdge ?? ASSET_UPLOAD_MAX_EDGE;
  for (const [edge, quality] of [[maxEdge, 0.82], [Math.round(maxEdge * 0.7), 0.75]] as const) {
    try {
      const smaller = await reencode(blob, edge, quality);
      if (smaller.size > 0 && smaller.size <= maxBytes) return smaller;
    } catch (error) {
      console.warn("[asset-save] could not shrink image for upload", error);
      return null;
    }
  }
  return null;
}
