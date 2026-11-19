import { sharedImageMime } from "../joinable-board.ts";

// Images shared on a joinable board are prepared in the browser before they upload straight to
// Storage (nothing on the server re-encodes them any more). Like app/projects/page.tsx: a photo
// bigger than SHARE_IMAGE_MAX_SIDE or SHARE_IMAGE_REENCODE_BYTES is resized and re-saved as JPEG,
// so boards stay fast and storage stays small.
export const SHARE_IMAGE_MAX_SIDE = 2560;
export const SHARE_IMAGE_REENCODE_BYTES = 4 * 1024 * 1024;

export type ShareImagePlan = { action: "keep" } | { action: "jpeg"; width: number; height: number; quality: number };

/**
 * What to do with a decoded image before sharing it. Animated images keep their bytes (a canvas
 * keeps one frame). JPEG and HEIC are always re-saved, even when small: that drops their metadata,
 * which can hold the phone's location (the old server conversion did the same), and turns HEIC
 * into something every browser can show. Small PNG and WebP keep their bytes (and transparency).
 */
export function shareImagePlan(input: { mime: string; width: number; height: number; size: number; animated: boolean }): ShareImagePlan {
  const { mime, width, height, size, animated } = input;
  if (animated || mime === "image/gif" || !(width > 0 && height > 0)) return { action: "keep" };
  const longest = Math.max(width, height);
  if (longest > SHARE_IMAGE_MAX_SIDE || size > SHARE_IMAGE_REENCODE_BYTES) {
    const scale = Math.min(1, SHARE_IMAGE_MAX_SIDE / longest);
    return { action: "jpeg", width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 0.82 };
  }
  if (mime === "image/jpeg" || mime === "image/heic" || mime === "image/heif") return { action: "jpeg", width, height, quality: 0.9 };
  return { action: "keep" };
}

/** Whether WebP bytes (the start of the file is enough) hold an animation: VP8X's animation flag. */
export function isAnimatedWebp(head: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...head.subarray(offset, offset + 4));
  return head.length >= 21 && tag(0) === "RIFF" && tag(8) === "WEBP" && tag(12) === "VP8X" && (head[20] & 0x02) !== 0;
}

/**
 * The bytes to upload for a shared image, and their type. Anything the browser can't decode
 * (HEIC outside Safari) or can't re-encode goes up as it is, if it's a type the board can share.
 */
export async function prepareImageForSharing(file: Blob, name: string): Promise<{ blob: Blob; mime: string }> {
  const mime = sharedImageMime(file.type, name);
  if (!mime || mime === "image/gif") return { blob: file, mime };
  const animated = mime === "image/webp" && isAnimatedWebp(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (animated) return { blob: file, mime };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { blob: file, mime };
  }
  try {
    const plan = shareImagePlan({ mime, width: bitmap.width, height: bitmap.height, size: file.size, animated });
    if (plan.action === "keep") return { blob: file, mime };
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d");
    if (!context) return { blob: file, mime };
    // JPEG has no transparency: see-through PNG/WebP pixels land on white, not black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, plan.width, plan.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", plan.quality));
    return jpeg ? { blob: jpeg, mime: "image/jpeg" } : { blob: file, mime };
  } finally {
    bitmap.close();
  }
}
