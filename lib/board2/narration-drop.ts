// Files the narration track accepts — the same set as the "Upload narration" file input, whose
// `accept` attribute is NARRATION_FILE_ACCEPT. A file dropped from the OS onto the narration track
// goes through the same path as one picked with that input.

export const NARRATION_FILE_ACCEPT = "audio/*,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.webm";

const NARRATION_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const NARRATION_EXTENSION_PATTERN = /\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm)$/i;

type FileLike = { type: string; name?: string };

export function isNarrationFile(file: FileLike): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith("audio/") || NARRATION_VIDEO_TYPES.has(type)) return true;
  return NARRATION_EXTENSION_PATTERN.test(file.name ?? "");
}

type DragTransferLike = {
  items?: ArrayLike<{ kind: string; type: string }>;
  types?: ArrayLike<string>;
};

/** Whether a drag carries files from the OS (not a board item or a media-library entry). */
export function dragCarriesFiles(dataTransfer: DragTransferLike): boolean {
  return Array.from(dataTransfer.types ?? []).some((type) => type.toLowerCase() === "files");
}

/**
 * During dragover only MIME types are readable, not names. "reject" when every dragged file has a
 * known type the narration track would refuse; otherwise "accept" (an empty type may still be,
 * say, an .m4a, so the drop itself decides).
 */
export function narrationDragVerdict(dataTransfer: DragTransferLike): "accept" | "reject" {
  const files = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  if (!files.length) return "accept";
  return files.some((item) => !item.type || isNarrationFile({ type: item.type })) ? "accept" : "reject";
}
