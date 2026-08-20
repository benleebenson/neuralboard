export type PreviewCachePolicy = {
  hotEntries: number;
  warmEntries: number;
  preloadViewportMargin: number;
  decodedBudgetBytes: number;
};

const MIB = 1024 * 1024;

export function previewCachePolicy(options: {
  deviceMemoryGb?: number;
  boardImageCount: number;
  estimatedDecodedBytesPerImage?: number;
}): PreviewCachePolicy {
  const deviceMemoryGb = Math.max(1, options.deviceMemoryGb ?? 4);
  const imageCount = Math.max(0, options.boardImageCount);
  const perImage = Math.max(256 * 1024, options.estimatedDecodedBytesPerImage ?? 1.25 * MIB);
  const decodedBudgetBytes = Math.round(Math.min(128, Math.max(32, deviceMemoryGb * 12)) * MIB);
  const budgetEntries = Math.max(12, Math.floor(decodedBudgetBytes / perImage));
  const boardPressure = imageCount > 240 ? 0.55 : imageCount > 120 ? 0.7 : imageCount > 60 ? 0.85 : 1;
  const totalEntries = Math.max(12, Math.min(96, imageCount || 24, Math.floor(budgetEntries * boardPressure)));
  const warmEntries = Math.max(4, Math.min(20, Math.round(totalEntries * 0.25)));
  const hotEntries = Math.max(8, totalEntries - warmEntries);
  return {
    hotEntries,
    warmEntries,
    preloadViewportMargin: imageCount > 120 ? 0.25 : 0.4,
    decodedBudgetBytes,
  };
}

export function decodedImageBytes(images: Iterable<{ complete: boolean; naturalWidth: number; naturalHeight: number }>): number {
  let bytes = 0;
  for (const image of images) {
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      bytes += image.naturalWidth * image.naturalHeight * 4;
    }
  }
  return bytes;
}
