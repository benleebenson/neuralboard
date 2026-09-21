export type ImageKind = "preview" | "full";

type Ready = { image: HTMLImageElement; objectUrl: string; kind: ImageKind; lastUsed: number };
type Failure = { count: number; retryAt: number };
type Want = { path: string; kind: ImageKind; priority: number };

export const MAX_CONCURRENT_LOADS = 4;
/** Resident caps. Full-size images are the memory hazard; previews are ≤320px so many more fit. */
export const MAX_RESIDENT: Record<ImageKind, number> = { full: 10, preview: 160 };
const IDLE_EVICT_MS = 1200;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** After this many consecutive failures a path is given up on until the store is cleared. */
const MAX_FAILURES = 4;

/**
 * Owns every decoded world image and its object URL. The draw loop calls `get`/`want` every frame,
 * so nothing here may do work proportional to failures: a path that failed is recorded and left
 * alone until its backoff expires, and object URLs are always revoked on the error path.
 */
export class WorldImageStore {
  private ready = new Map<string, Ready>();
  private loading = new Map<string, ImageKind>();
  private failures = new Map<string, Failure>();
  private wanted: Want[] = [];
  private epoch = 0;
  private liveUrls = 0;

  private read: (path: string) => Promise<Blob> = () => Promise.reject(new Error("No media reader attached."));

  setReader(read: (path: string) => Promise<Blob>): void {
    this.read = read;
  }

  get(path: string | undefined, now: number): HTMLImageElement | undefined {
    if (!path) return undefined;
    const entry = this.ready.get(path);
    if (!entry) return undefined;
    entry.lastUsed = now;
    return entry.image;
  }

  isFailed(path: string | undefined): boolean {
    return !!path && this.failures.has(path);
  }

  /** Register interest for this frame. Lower priority number = closer to the viewport centre = loaded first. */
  want(path: string, kind: ImageKind, priority: number): void {
    this.wanted.push({ path, kind, priority });
  }

  /** Called once at the end of every frame: evicts, then starts loads within the concurrency and residency caps. */
  pump(now: number, keepResident: boolean): void {
    const wantedPaths = new Set<string>();
    for (const item of this.wanted) wantedPaths.add(item.path);
    if (!keepResident) {
      this.wanted.length = 0;
      if (this.ready.size) this.releaseAll();
      return;
    }
    for (const [path, entry] of this.ready) {
      if (!wantedPaths.has(path) && now - entry.lastUsed > IDLE_EVICT_MS) this.evict(path);
    }
    this.wanted.sort((a, b) => a.priority - b.priority);
    const counts: Record<ImageKind, number> = { full: 0, preview: 0 };
    for (const entry of this.ready.values()) counts[entry.kind] += 1;
    for (const kind of this.loading.values()) counts[kind] += 1;
    for (const item of this.wanted) {
      if (this.loading.size >= MAX_CONCURRENT_LOADS) break;
      if (this.ready.has(item.path) || this.loading.has(item.path)) continue;
      const failure = this.failures.get(item.path);
      if (failure && (failure.count >= MAX_FAILURES || now < failure.retryAt)) continue;
      if (counts[item.kind] >= MAX_RESIDENT[item.kind]) {
        // Make room by dropping the least recently drawn image that nothing wants this frame.
        let victim: string | null = null;
        let oldest = Infinity;
        for (const [path, entry] of this.ready) {
          if (entry.kind === item.kind && !wantedPaths.has(path) && entry.lastUsed < oldest) { oldest = entry.lastUsed; victim = path; }
        }
        if (!victim) continue;
        this.evict(victim);
        counts[item.kind] -= 1;
      }
      counts[item.kind] += 1;
      this.start(item.path, item.kind);
    }
    this.wanted.length = 0;
  }

  stats(): { resident: number; loading: number; failed: number; liveUrls: number } {
    return { resident: this.ready.size, loading: this.loading.size, failed: this.failures.size, liveUrls: this.liveUrls };
  }

  /** Drops everything, including failure history. In-flight loads finish into the void and revoke themselves. */
  clear(): void {
    this.epoch += 1;
    this.wanted.length = 0;
    this.releaseAll();
    this.loading.clear();
    this.failures.clear();
  }

  private start(path: string, kind: ImageKind): void {
    const epoch = this.epoch;
    this.loading.set(path, kind);
    const settle = (objectUrl: string | null, image: HTMLImageElement | null) => {
      if (epoch !== this.epoch) { if (objectUrl) this.revoke(objectUrl); return; }
      this.loading.delete(path);
      if (image && objectUrl) {
        this.failures.delete(path);
        this.ready.set(path, { image, objectUrl, kind, lastUsed: performance.now() });
        return;
      }
      if (objectUrl) this.revoke(objectUrl);
      const count = (this.failures.get(path)?.count ?? 0) + 1;
      this.failures.set(path, { count, retryAt: performance.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (count - 1)) });
    };
    this.read(path).then((blob) => {
      if (epoch !== this.epoch) return;
      const objectUrl = URL.createObjectURL(blob);
      this.liveUrls += 1;
      const image = new Image();
      image.onload = () => settle(objectUrl, image);
      image.onerror = () => settle(objectUrl, null);
      image.src = objectUrl;
    }).catch(() => settle(null, null));
  }

  private evict(path: string): void {
    const entry = this.ready.get(path);
    if (!entry) return;
    this.ready.delete(path);
    this.revoke(entry.objectUrl);
  }

  private releaseAll(): void {
    for (const entry of this.ready.values()) this.revoke(entry.objectUrl);
    this.ready.clear();
  }

  private revoke(objectUrl: string): void {
    URL.revokeObjectURL(objectUrl);
    this.liveUrls -= 1;
  }
}
