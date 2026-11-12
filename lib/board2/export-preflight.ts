// Pre-flight for video export: before the save dialog opens (and creates a file on disk), confirm
// that every media source the timeline references can actually be fetched. A board restored from
// an old session can hold blob: URLs whose object was revoked; those fail with
// ERR_FILE_NOT_FOUND only once the encoder reaches them, minutes into an export.

export type PreflightClip = {
  type: string;
  name?: string;
  id?: string;
  sourceUrl?: string;
  audioBlob?: Blob;
  sourceBlob?: Blob;
  flashImageUrl?: string;
  flashSoundUrl?: string;
  cutToMedia?: "image" | "video";
  cutToSourceClipId?: string;
};

export type ExportMediaKind = "image" | "video" | "audio" | "sound";

export type ExportMediaRef = { url: string; kind: ExportMediaKind; names: string[] };

export type BrokenExportMedia = { names: string[]; kind: ExportMediaKind; url: string; reason: string };

function clipLabel(clip: PreflightClip): string {
  return clip.name?.trim() || clip.id || `untitled ${clip.type}`;
}

// Every distinct URL the export will load, with the names of the items that use it. Items that
// should have media but have no URL at all come back as already broken.
export function collectExportMedia(
  clips: readonly PreflightClip[],
  extras: ReadonlyArray<{ name: string; url: string | null | undefined; kind: ExportMediaKind }> = [],
): { refs: ExportMediaRef[]; missing: BrokenExportMedia[] } {
  const byUrl = new Map<string, ExportMediaRef>();
  const missing: BrokenExportMedia[] = [];
  const add = (url: string | undefined | null, kind: ExportMediaKind, name: string) => {
    if (!url) {
      missing.push({ names: [name], kind, url: "", reason: "it has no media file" });
      return;
    }
    const existing = byUrl.get(url);
    if (existing) {
      if (!existing.names.includes(name)) existing.names.push(name);
    } else {
      byUrl.set(url, { url, kind, names: [name] });
    }
  };
  for (const clip of clips) {
    const name = clipLabel(clip);
    switch (clip.type) {
      case "image":
        add(clip.sourceUrl, "image", name);
        break;
      case "video":
        add(clip.sourceUrl, "video", name);
        break;
      case "narration":
        // Recorded/uploaded narration decodes from its in-memory Blob; only a URL-backed one can be stale.
        if (!clip.audioBlob && !clip.sourceBlob) add(clip.sourceUrl, "audio", name);
        break;
      case "flash":
        if (clip.flashImageUrl) add(clip.flashImageUrl, "image", name);
        if (clip.flashSoundUrl) add(clip.flashSoundUrl, "sound", name);
        break;
      case "cutto":
        // A Cut To of the narration video draws that clip, which is checked as a video above.
        if (!clip.cutToSourceClipId) add(clip.sourceUrl, clip.cutToMedia === "video" ? "video" : "image", name);
        break;
      default:
        break;
    }
  }
  for (const extra of extras) add(extra.url, extra.kind, extra.name);
  return { refs: [...byUrl.values()], missing };
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; method?: string; cache?: RequestCache; mode?: RequestMode }) => Promise<{
  ok: boolean;
  status: number;
  body?: { cancel(): Promise<void> } | null;
}>;

// Resolves to null when the URL serves something, else a short human reason. Only the response
// headers are awaited; the body is cancelled, so large videos are not downloaded.
export async function probeMediaUrl(url: string, options: { fetch: FetchLike; timeoutMs?: number }): Promise<string | null> {
  if (url.startsWith("data:")) return null;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await options.fetch(url, { signal: controller.signal, cache: "no-store", mode: url.startsWith("blob:") ? undefined : "cors" });
    void response.body?.cancel().catch(() => {});
    if (!response.ok) return response.status === 404 ? "file not found (404)" : `the server answered ${response.status}`;
    return null;
  } catch (error) {
    if (controller.signal.aborted) return `no response after ${Math.round(timeoutMs / 1000)}s`;
    // fetch() rejects with a bare TypeError for revoked blob: URLs, CORS refusals and network errors.
    return url.startsWith("blob:")
      ? "its local file is no longer available in this browser session"
      : `it could not be downloaded (${error instanceof Error ? error.message : String(error)})`;
  } finally {
    clearTimeout(timer);
  }
}

export async function findBrokenExportMedia(
  refs: readonly ExportMediaRef[],
  probe: (url: string) => Promise<string | null>,
  options: { concurrency?: number; onProgress?: (checked: number, total: number) => void } = {},
): Promise<BrokenExportMedia[]> {
  const broken: BrokenExportMedia[] = [];
  let next = 0;
  let checked = 0;
  const worker = async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      const reason = await probe(ref.url).catch((error) => `check failed (${error instanceof Error ? error.message : String(error)})`);
      if (reason) broken.push({ names: ref.names, kind: ref.kind, url: ref.url, reason });
      options.onProgress?.(++checked, refs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, refs.length)) }, worker));
  // Report in timeline order, not completion order.
  const order = new Map(refs.map((ref, index) => [ref.url, index]));
  return broken.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0));
}

export function brokenExportMediaMessage(broken: readonly BrokenExportMedia[], maxListed = 12): string {
  const lines = broken.slice(0, maxListed).map((item) => {
    const names = item.names.map((name) => `“${name}”`).join(", ");
    return `• ${names} (${item.kind}): ${item.reason}`;
  });
  const more = broken.length > maxListed ? `\n• …and ${broken.length - maxListed} more` : "";
  const count = broken.length === 1 ? "1 media item can't be loaded" : `${broken.length} media items can't be loaded`;
  return `${count}, so the export was not started and no file was created:\n${lines.join("\n")}${more}\nRe-add or remove these items, then export again`;
}
