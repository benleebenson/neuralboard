export const WORLD_FILE_NAME = "Neural Board World.nbw";
export const WORLD_PENDING_IMPORT_FILE = "nb_world_pending_import_file";
export const WORLD_SCHEMA_VERSION = 1 as const;

export type WorldPoint = { x: number; y: number };
export type WorldRect = WorldPoint & { width: number; height: number };

export type WorldAssetReference = {
  archivePath: string;
  path: string;
  previewPath?: string;
  mime: string;
  bytes: number;
};

export type WorldMediaPlacement = {
  id: string;
  type: "image" | "video" | "other";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  assetPath?: string;
  previewPath?: string;
};

export type FarLodCell = WorldRect & { density: number };

export type WorldRegion = {
  id: string;
  name: string;
  bounds: WorldRect;
  createdAt: string;
  modifiedAt: string;
  source?: { kind: "nbp-import"; fileName: string; importedAt: string };
  project: { schemaVersion: number; manifest: Record<string, unknown> };
  assets: WorldAssetReference[];
  lod: {
    contentFingerprint: string;
    media: WorldMediaPlacement[];
    far: { cells: FarLodCell[]; generatedAt: string };
  };
};

export type BoardWorld = {
  kind: "neural-board-world";
  schemaVersion: typeof WORLD_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  mediaRoot: string;
  camera: { x: number; y: number; zoom: number };
  regions: WorldRegion[];
};

export type WorldSelection = ReadonlySet<string>;

const REGION_GAP = 800;
const STAGING_X_GAP = 2400;

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function safeWorldMediaRoot(worldFileName = WORLD_FILE_NAME): string {
  return `${worldFileName.replace(/\.nbw$/i, "").replace(/[^a-z0-9 _-]/gi, "").trim() || "Neural Board World"}.media`;
}

export function createEmptyWorld(now = new Date().toISOString()): BoardWorld {
  return {
    kind: "neural-board-world",
    schemaVersion: WORLD_SCHEMA_VERSION,
    id: id("world"),
    name: "Neural Board World",
    createdAt: now,
    modifiedAt: now,
    mediaRoot: safeWorldMediaRoot(),
    camera: { x: 0, y: 0, zoom: 0.12 },
    regions: [],
  };
}

export function rectsOverlap(a: WorldRect, b: WorldRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export function rectIntersects(a: WorldRect, b: WorldRect): boolean {
  return rectsOverlap(a, b, 0);
}

export function visibleRegions(world: BoardWorld, viewport: WorldRect): WorldRegion[] {
  return world.regions.filter((region) => rectIntersects(region.bounds, viewport));
}

export function validateRegionPlacement(world: BoardWorld, bounds: WorldRect, exceptIds: ReadonlySet<string> = new Set()): string | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 400 || bounds.height < 300) {
    return "Regions must be at least 400 × 300 world units.";
  }
  const collision = world.regions.find((region) => !exceptIds.has(region.id) && rectsOverlap(region.bounds, bounds, 40));
  return collision ? `Regions cannot overlap “${collision.name}”.` : null;
}

export function stagingBounds(world: BoardWorld, width: number, height: number): WorldRect {
  const rightEdge = world.regions.reduce((right, region) => Math.max(right, region.bounds.x + region.bounds.width), 0);
  const x = rightEdge + (world.regions.length ? STAGING_X_GAP : 0);
  const staged = world.regions.filter((region) => region.source?.kind === "nbp-import" && region.bounds.x >= x - STAGING_X_GAP);
  const y = staged.reduce((bottom, region) => Math.max(bottom, region.bounds.y + region.bounds.height + REGION_GAP), 0);
  return { x, y, width, height };
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function boardDimensions(manifest: Record<string, unknown>): { width: number; height: number } {
  const board = asRecord(manifest.board);
  const dimensions = asRecord(board.dimensions);
  return {
    width: Math.max(400, number(dimensions.width, 4000)),
    height: Math.max(300, number(dimensions.height, 3000)),
  };
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function worldMediaPlacements(
  manifest: Record<string, unknown>,
  assets: readonly WorldAssetReference[],
): WorldMediaPlacement[] {
  const board = asRecord(manifest.board);
  const media = Array.isArray(board.media) ? board.media : Array.isArray(board.clips) ? board.clips : [];
  const byArchivePath = new Map(assets.map((asset) => [asset.archivePath, asset]));
  return media.flatMap((raw, index) => {
    const item = asRecord(raw);
    const type = item.type === "image" || item.type === "video" ? item.type : "other";
    if (type === "other") return [];
    const archivePath = typeof item.assetFile === "string" ? item.assetFile : undefined;
    const asset = archivePath ? byArchivePath.get(archivePath) : undefined;
    return [{
      id: string(item.id, `media_${index}`),
      type,
      x: number(item.boardX, 0),
      y: number(item.boardY, 0),
      width: Math.max(20, number(item.boardW, 320)),
      height: Math.max(20, number(item.boardH, 220)),
      rotation: number(item.mediaRotationDeg, number(item.rotation, 0)),
      assetPath: asset?.path,
      previewPath: asset?.previewPath,
    } satisfies WorldMediaPlacement];
  });
}

export function contentFingerprint(media: readonly WorldMediaPlacement[]): string {
  return fnv1a(JSON.stringify(media.map(({ id: mediaId, x, y, width, height, assetPath, previewPath }) => [mediaId, x, y, width, height, assetPath, previewPath])));
}

export function generateFarLod(media: readonly WorldMediaPlacement[], now = new Date().toISOString()): WorldRegion["lod"]["far"] {
  if (!media.length) return { cells: [], generatedAt: now };
  const columns = 12;
  const rows = 9;
  const maxX = Math.max(...media.map((item) => item.x + item.width), 1);
  const maxY = Math.max(...media.map((item) => item.y + item.height), 1);
  const cellWidth = maxX / columns;
  const cellHeight = maxY / rows;
  const density = Array.from({ length: columns * rows }, () => 0);
  for (const item of media) {
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    const column = Math.max(0, Math.min(columns - 1, Math.floor(centerX / cellWidth)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(centerY / cellHeight)));
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const cx = column + ox;
        const cy = row + oy;
        if (cx < 0 || cy < 0 || cx >= columns || cy >= rows) continue;
        density[cy * columns + cx] += ox === 0 && oy === 0 ? 1 : 0.32;
      }
    }
  }
  const peak = Math.max(...density, 1);
  const cells = density.flatMap((value, index) => value <= 0 ? [] : [{
    x: (index % columns) * cellWidth,
    y: Math.floor(index / columns) * cellHeight,
    width: cellWidth * 1.6,
    height: cellHeight * 1.6,
    density: Math.min(1, value / peak),
  }]);
  return { cells, generatedAt: now };
}

export function buildRegion(options: {
  name: string;
  bounds: WorldRect;
  manifest: Record<string, unknown>;
  assets?: WorldAssetReference[];
  source?: WorldRegion["source"];
  now?: string;
  regionId?: string;
}): WorldRegion {
  const now = options.now ?? new Date().toISOString();
  const assets = options.assets ?? [];
  const media = worldMediaPlacements(options.manifest, assets);
  return {
    id: options.regionId ?? id("region"),
    name: options.name.trim() || "Untitled region",
    bounds: options.bounds,
    createdAt: now,
    modifiedAt: now,
    source: options.source,
    project: { schemaVersion: number(options.manifest.schemaVersion, 0), manifest: options.manifest },
    assets,
    lod: { contentFingerprint: contentFingerprint(media), media, far: generateFarLod(media, now) },
  };
}

export function emptyRegionManifest(name: string, bounds: WorldRect, now = new Date().toISOString()): Record<string, unknown> {
  const projectId = id("proj");
  return {
    schemaVersion: 6,
    meta: { id: projectId, projectId, title: name, aspectRatio: "16:9", duration: 0, totalDurationSec: 0, createdAt: now, modifiedAt: now, trainingExample: false },
    board: { media: [], dimensions: { width: Math.max(4000, Math.round(bounds.width)), height: Math.max(3000, Math.round(bounds.height)) }, pxPerSec: 20, boardZoom: 1, boardPan: { x: 0, y: 0 }, spawnDoor: null },
    timeline: { blocks: [], customZoomDurationSeconds: 3 },
    annotations: [],
    narration: { clipIds: [], visemeTrack: [], gestureTrack: [], smartGestures: false, captions: { enabled: false, track: [] } },
    camera: { mode: "clips", inputs: { holdFractions: {}, panBlocks: [], frameSurfaceBlocks: [], characterZoomBlocks: [] }, keyframes: [], resolvedTrack: [] },
    characters: {
      c1: { id: "c1", enabled: false, accentColor: "#2a2a2a", mode: "auto", skin: "stick", characterType: "stickFigure", expression: "neutral", actions: [], resolvedPositionTrack: [] },
      c2: { id: "c2", enabled: false, accentColor: "#3a3a5a", mode: "auto", skin: "stick", characterType: "stickFigure", expression: "neutral", actions: [], resolvedPositionTrack: [] },
    },
  };
}

export function createRegion(world: BoardWorld, name: string, bounds: WorldRect, now = new Date().toISOString()): BoardWorld {
  const problem = validateRegionPlacement(world, bounds);
  if (problem) throw new Error(problem);
  const region = buildRegion({ name, bounds, manifest: emptyRegionManifest(name, bounds, now), now });
  return { ...world, modifiedAt: now, regions: [...world.regions, region] };
}

export function moveSelectedRegions(world: BoardWorld, selected: WorldSelection, dx: number, dy: number, now = new Date().toISOString()): BoardWorld {
  if (!selected.size || (!dx && !dy)) return world;
  const selectedIds = new Set([...selected].filter((key) => key.startsWith("region:" )).map((key) => key.slice(7)));
  const candidates = world.regions.map((region) => selectedIds.has(region.id)
    ? { ...region, bounds: { ...region.bounds, x: region.bounds.x + dx, y: region.bounds.y + dy } }
    : region);
  for (const region of candidates) {
    if (!selectedIds.has(region.id)) continue;
    const collision = candidates.find((other) => other.id !== region.id && !selectedIds.has(other.id) && rectsOverlap(region.bounds, other.bounds, 40));
    if (collision) return world;
  }
  return { ...world, modifiedAt: now, regions: candidates };
}

export function moveSelectedItems(world: BoardWorld, selected: WorldSelection, dx: number, dy: number, now = new Date().toISOString()): BoardWorld {
  if (!selected.size || (!dx && !dy)) return world;
  const itemKeys = new Set([...selected].filter((key) => key.startsWith("item:")));
  const regions = world.regions.map((region) => {
    const moving = new Set(region.lod.media.filter((item) => itemKeys.has(`item:${region.id}:${item.id}`)).map((item) => item.id));
    if (!moving.size) return region;
    const manifest = structuredClone(region.project.manifest);
    const board = asRecord(manifest.board);
    if (Array.isArray(board.media)) {
      board.media = board.media.map((raw) => {
        const item = asRecord(raw);
        return moving.has(String(item.id)) ? { ...item, boardX: number(item.boardX, 0) + dx, boardY: number(item.boardY, 0) + dy } : item;
      });
    }
    const media = region.lod.media.map((item) => moving.has(item.id) ? { ...item, x: item.x + dx, y: item.y + dy } : item);
    return { ...region, modifiedAt: now, project: { ...region.project, manifest }, lod: { contentFingerprint: contentFingerprint(media), media, far: generateFarLod(media, now) } };
  });
  return { ...world, modifiedAt: now, regions };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function lodWeights(zoom: number): { far: number; mid: number; near: number } {
  const farToMid = smoothstep(0.075, 0.16, zoom);
  const midToNear = smoothstep(0.34, 0.62, zoom);
  return { far: 1 - farToMid, mid: farToMid * (1 - midToNear), near: midToNear };
}

function containsEmbeddedBytes(value: unknown): boolean {
  if (typeof value === "string") return /^data:[^;,]+;base64,/i.test(value);
  if (Array.isArray(value)) return value.some(containsEmbeddedBytes);
  if (value && typeof value === "object") return Object.values(value).some(containsEmbeddedBytes);
  return false;
}

export function assertWorldDocument(value: unknown): asserts value is BoardWorld {
  const world = asRecord(value);
  if (world.kind !== "neural-board-world" || world.schemaVersion !== WORLD_SCHEMA_VERSION || !Array.isArray(world.regions)) {
    throw new Error("Not a valid .nbw world file.");
  }
  if (containsEmbeddedBytes(world)) throw new Error("World files may contain references only; embedded base64 media is not allowed.");
}

export function parseWorld(text: string): BoardWorld {
  const value = JSON.parse(text);
  assertWorldDocument(value);
  return value;
}

export function serializeWorld(world: BoardWorld): string {
  assertWorldDocument(world);
  return JSON.stringify(world, null, 2);
}

export function projectedWorldBytes(regionCount = 50, mediaPerRegion = 40): number {
  const now = "2026-01-01T00:00:00.000Z";
  const world = createEmptyWorld(now);
  world.regions = Array.from({ length: regionCount }, (_, regionIndex) => {
    const assets = Array.from({ length: mediaPerRegion }, (_, mediaIndex) => ({
      archivePath: `assets/media_${mediaIndex}.webp`,
      path: `regions/r${regionIndex}/assets/media_${mediaIndex}.webp`,
      previewPath: `regions/r${regionIndex}/previews/media_${mediaIndex}.webp`,
      mime: "image/webp",
      bytes: 850_000,
    }));
    const manifest = emptyRegionManifest(`Region ${regionIndex + 1}`, { x: 0, y: 0, width: 4000, height: 3000 }, now);
    (manifest.board as Record<string, unknown>).media = assets.map((asset, mediaIndex) => ({ id: `m${mediaIndex}`, type: "image", assetFile: asset.archivePath, boardX: (mediaIndex % 8) * 440, boardY: Math.floor(mediaIndex / 8) * 520, boardW: 380, boardH: 300 }));
    return buildRegion({ regionId: `r${regionIndex}`, name: `Region ${regionIndex + 1}`, bounds: { x: regionIndex * 4800, y: 0, width: 4000, height: 3000 }, manifest, assets, now });
  });
  return new TextEncoder().encode(serializeWorld(world)).byteLength;
}
