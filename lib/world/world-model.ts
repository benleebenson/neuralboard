/**
 * NEURAL BOARD WORLD — the .nbw format (schema 2)
 * ================================================
 *
 * One world = one folder the user granted (the same File System Access folder as their .nbp boards):
 *
 *   Neural Board World.nbw            the INDEX. Small JSON, read in full on open.
 *   Neural Board World.media/
 *     regions/<regionId>.json         one region's full manifest (a board's manifest.json) + asset list.
 *                                     Read only when a region is opened, edited-in-place or exported.
 *     assets/<xx>/<hash32>.<ext>      original media, content-addressed (first 32 hex of SHA-256).
 *                                     Identical bytes are stored once across every region, forever.
 *     previews/<xx>/<hash32>.webp     ≤320px preview of each image, generated at import; the only
 *                                     thing the MID level ever loads.
 *
 * .nbw (index):
 *   { kind: "neural-board-world", schemaVersion: 2, id, name, createdAt, modifiedAt,
 *     mediaRoot: "<name>.media",
 *     staging?: { x, y },                         // origin of the import staging strip (see stagingPlacement)
 *     regions: [{
 *       id, name, createdAt, modifiedAt,
 *       bounds: { x, y, width, height },          // world units; the region's rectangle. Never overlaps another.
 *       source?: { kind: "nbp-import", fileName, importedAt },
 *       refs: ["<hash32>.<ext>", …],              // every asset this region needs (drives garbage collection)
 *       lod: {
 *         contentFingerprint,                     // hash of placements; the far-blob cache key
 *         media: [{ id, type, x, y, width, height, rotation, asset?, preview? }],   // board-local coords
 *         far: { cols, rows, extentWidth, extentHeight, density: number[cols*rows] } // 0–100 coverage grid
 *       }
 *     }] }
 *
 * region file:
 *   { kind: "neural-board-region", schemaVersion: 1, id, savedAt,
 *     manifest: { …an .nbp manifest.json verbatim: media, annotations, timeline, camera, characters… },
 *     assets: [{ archivePath, file, preview, mime, bytes }] }   // archivePath = the path the manifest uses
 *
 * Why the index is not one giant file, and holds no bytes:
 *  - Media bytes never appear in any JSON (a validator rejects `data:…;base64` strings at read and write).
 *    Embedding them would make a world that accumulates every project forever unopenable.
 *  - Manifests are big (timelines, camera tracks, viseme tracks). Keeping them in per-region files
 *    means opening the world parses only the index, whose size grows by ~8 KB per region.
 *  - The index is the commit point: region files and assets are written first, the index last, so a
 *    crash can leave orphan files (swept by garbage collection) but never an index that points at nothing.
 *
 * Geometry: a region is a rectangle in world units, at least as large as one board (4000×3000), because
 * a region IS a project and the editor's board is never smaller. Item positions in `lod.media` and in the
 * manifest are board-local, so moving a region changes only `bounds` and everything inside moves with it.
 *
 * Projected size, 50 regions × 40 images (≈850 KB average original): see `projectWorldSize()` below,
 * which builds a synthetic world with the real serializers. Result: index ≈ 0.5 MB, region files ≈ 0.6 MB,
 * previews ≈ 24 MB, originals ≈ 1.7 GB living as separate files. The JSON you open is ~1 MB; embedding
 * originals as base64 would instead be a single ≈ 2.3 GB file.
 */

export const WORLD_FILE_NAME = "Neural Board World.nbw";
export const WORLD_PENDING_IMPORT_FILE = "nb_world_pending_import_file";
/** 2 = the .nbw is an index; each region's manifest lives in its own file under the media root. */
export const WORLD_SCHEMA_VERSION = 2 as const;
export const REGION_FILE_SCHEMA_VERSION = 1 as const;

export type WorldPoint = { x: number; y: number };
export type WorldRect = WorldPoint & { width: number; height: number };

/** One file of a region's .nbp archive, stored once under its content hash. */
export type WorldAsset = {
  /** Path inside the original .nbp, which is what the manifest refers to. */
  archivePath: string;
  /** `<32 hex of SHA-256>.<ext>`; identical bytes always map to the same file. */
  file: string;
  /** True when a 320px webp preview exists at `previewStoragePath(file)`. */
  preview: boolean;
  mime: string;
  bytes: number;
};

export type WorldMediaPlacement = {
  id: string;
  type: "image" | "video" | "other";
  /** Board-space position inside the region. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Asset file name (see WorldAsset.file). Previews are derived from it. */
  asset?: string;
  preview?: boolean;
};

/**
 * Coarse density grid used at far zoom. `density` is row-major, `cols * rows` integers 0–100;
 * the grid spans the region's content extent, not its full bounds.
 */
export type FarLod = { cols: number; rows: number; extentWidth: number; extentHeight: number; density: number[] };

/** A region as recorded in the index. Everything here is enough to draw the region at any zoom. */
export type WorldRegion = {
  id: string;
  name: string;
  bounds: WorldRect;
  createdAt: string;
  modifiedAt: string;
  source?: { kind: "nbp-import"; fileName: string; importedAt: string };
  /** Every asset file the region's manifest needs. Drives garbage collection. */
  refs: string[];
  lod: {
    contentFingerprint: string;
    media: WorldMediaPlacement[];
    far: FarLod;
  };
};

/** The heavyweight half of a region, stored at `regionFilePath(id)` and read only when the region is opened or edited. */
export type WorldRegionFile = {
  kind: "neural-board-region";
  schemaVersion: typeof REGION_FILE_SCHEMA_VERSION;
  id: string;
  savedAt: string;
  manifest: Record<string, unknown>;
  assets: WorldAsset[];
};

export type BoardWorld = {
  kind: "neural-board-world";
  schemaVersion: typeof WORLD_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  mediaRoot: string;
  /** Top-left of the staging strip that imports fill (see stagingPlacement). Set by the first import. */
  staging?: WorldPoint;
  regions: WorldRegion[];
};

/** A selection is a set of these keys: whole regions, or single media items inside a region. */
export type WorldSelection = ReadonlySet<string>;
export function regionSelectionKey(regionId: string): string { return `region:${regionId}`; }
export function itemSelectionKey(regionId: string, mediaId: string): string { return `item:${regionId}:${mediaId}`; }

export const ASSET_FILE_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function assetStoragePath(file: string): string { return `assets/${file.slice(0, 2)}/${file}`; }
export function previewFileName(file: string): string { return `${file.slice(0, 32)}.webp`; }
export function previewStoragePath(file: string): string { return `previews/${file.slice(0, 2)}/${previewFileName(file)}`; }
export function regionFilePath(regionId: string): string { return `regions/${regionId}.json`; }

/** A region is at least one editor board, so the editor's board always fits inside its region. */
export const REGION_MIN_WIDTH = 4000;
export const REGION_MIN_HEIGHT = 3000;
const REGION_GAP = 800;
/** Clear space kept between regions, so a region's frame and label never touch its neighbour. */
export const REGION_CLEARANCE = 40;

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
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < REGION_MIN_WIDTH || bounds.height < REGION_MIN_HEIGHT) {
    return `Regions must be at least ${REGION_MIN_WIDTH} × ${REGION_MIN_HEIGHT} world units, the size of one board.`;
  }
  const collision = world.regions.find((region) => !exceptIds.has(region.id) && rectsOverlap(region.bounds, bounds, REGION_CLEARANCE));
  return collision ? `Regions cannot overlap “${collision.name}”.` : null;
}

/** Imports fill the staging strip this many regions wide, then start a new row beneath. */
export const STAGING_COLUMNS = 6;

/**
 * Where an imported board lands. The staging strip has a fixed origin (`world.staging`, chosen the
 * first time: just below the world's existing content, left-aligned with it) and fills left to right,
 * wrapping into rows. The strip therefore stays put and compact while the user drags regions out of it.
 * The result never overlaps, or comes within REGION_CLEARANCE of, any existing region.
 */
export function stagingPlacement(world: BoardWorld, width: number, height: number): { bounds: WorldRect; origin: WorldPoint } {
  const origin = world.staging ?? (world.regions.length
    ? { x: Math.min(...world.regions.map((region) => region.bounds.x)), y: Math.max(...world.regions.map((region) => region.bounds.y + region.bounds.height)) + REGION_GAP }
    : { x: 0, y: 0 });
  const rightLimit = origin.x + STAGING_COLUMNS * (width + REGION_GAP);
  // Each row either finds a free slot or is skipped; rows move down without bound, so a free one exists.
  for (let row = 0; ; row += 1) {
    const y = origin.y + row * (height + REGION_GAP);
    let x = origin.x;
    while (x + width <= rightLimit) {
      const candidate = { x, y, width, height };
      const blocker = world.regions.find((region) => rectsOverlap(region.bounds, candidate, REGION_CLEARANCE));
      if (!blocker) return { bounds: candidate, origin };
      // Every step moves x strictly right (the blocker's right edge is past x), so this terminates.
      x = blocker.bounds.x + blocker.bounds.width + REGION_GAP;
    }
  }
}

/**
 * A board can grow past its starting size in the editor. Grow the region to match (keeping its
 * top-left) unless that would touch a neighbour, in which case the region is left as it was.
 */
export function growRegionBounds(world: BoardWorld, region: WorldRegion, dimensions: { width: number; height: number }): WorldRect {
  const width = Math.max(region.bounds.width, dimensions.width);
  const height = Math.max(region.bounds.height, dimensions.height);
  if (width === region.bounds.width && height === region.bounds.height) return region.bounds;
  const grown = { ...region.bounds, width, height };
  return validateRegionPlacement(world, grown, new Set([region.id])) ? region.bounds : grown;
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
    width: Math.max(REGION_MIN_WIDTH, number(dimensions.width, REGION_MIN_WIDTH)),
    height: Math.max(REGION_MIN_HEIGHT, number(dimensions.height, REGION_MIN_HEIGHT)),
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

const round1 = (value: number): number => Math.round(value * 10) / 10;

export function worldMediaPlacements(
  manifest: Record<string, unknown>,
  assets: readonly WorldAsset[],
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
    const placement: WorldMediaPlacement = {
      id: string(item.id, `media_${index}`),
      type,
      x: round1(number(item.boardX, 0)),
      y: round1(number(item.boardY, 0)),
      width: round1(Math.max(20, number(item.boardW, 320))),
      height: round1(Math.max(20, number(item.boardH, 220))),
      rotation: round1(number(item.mediaRotationDeg, number(item.rotation, 0))),
    };
    if (asset) { placement.asset = asset.file; if (asset.preview) placement.preview = true; }
    return [placement];
  });
}

export function contentFingerprint(media: readonly WorldMediaPlacement[]): string {
  return fnv1a(JSON.stringify(media.map(({ id: mediaId, x, y, width, height, asset }) => [mediaId, x, y, width, height, asset])));
}

const FAR_COLUMNS = 16;
const FAR_ROWS = 12;

/**
 * Coverage grid over the content extent: each cell holds how much of it the media covers (area
 * overlap, so dense clusters read darker and the outline follows the real footprint). Runs when a
 * region's contents change, never per frame; the far renderer turns it into a cached bitmap.
 */
export function generateFarLod(media: readonly WorldMediaPlacement[]): FarLod {
  const extentWidth = Math.max(...media.map((item) => item.x + item.width), 1);
  const extentHeight = Math.max(...media.map((item) => item.y + item.height), 1);
  const cellWidth = extentWidth / FAR_COLUMNS;
  const cellHeight = extentHeight / FAR_ROWS;
  const coverage = Array.from({ length: FAR_COLUMNS * FAR_ROWS }, () => 0);
  for (const item of media) {
    const firstColumn = Math.max(0, Math.floor(item.x / cellWidth));
    const lastColumn = Math.min(FAR_COLUMNS - 1, Math.floor((item.x + item.width) / cellWidth));
    const firstRow = Math.max(0, Math.floor(item.y / cellHeight));
    const lastRow = Math.min(FAR_ROWS - 1, Math.floor((item.y + item.height) / cellHeight));
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const overlapX = Math.min(item.x + item.width, (column + 1) * cellWidth) - Math.max(item.x, column * cellWidth);
        const overlapY = Math.min(item.y + item.height, (row + 1) * cellHeight) - Math.max(item.y, row * cellHeight);
        if (overlapX > 0 && overlapY > 0) coverage[row * FAR_COLUMNS + column] += (overlapX * overlapY) / (cellWidth * cellHeight);
      }
    }
  }
  // sqrt lifts thinly covered cells so a sparse board still reads as a shape rather than vanishing.
  return { cols: FAR_COLUMNS, rows: FAR_ROWS, extentWidth: round1(extentWidth), extentHeight: round1(extentHeight), density: coverage.map((value) => Math.round(Math.sqrt(Math.min(1, value)) * 100)) };
}

export function buildLod(media: WorldMediaPlacement[]): WorldRegion["lod"] {
  return { contentFingerprint: contentFingerprint(media), media, far: generateFarLod(media) };
}

export function buildRegion(options: {
  name: string;
  bounds: WorldRect;
  manifest: Record<string, unknown>;
  assets?: WorldAsset[];
  source?: WorldRegion["source"];
  now?: string;
  regionId?: string;
  createdAt?: string;
}): { region: WorldRegion; file: WorldRegionFile } {
  const now = options.now ?? new Date().toISOString();
  const assets = options.assets ?? [];
  const regionId = options.regionId ?? id("region");
  const region: WorldRegion = {
    id: regionId,
    name: options.name.trim() || "Untitled region",
    bounds: options.bounds,
    createdAt: options.createdAt ?? now,
    modifiedAt: now,
    refs: [...new Set(assets.map((asset) => asset.file))].sort(),
    lod: buildLod(worldMediaPlacements(options.manifest, assets)),
  };
  if (options.source) region.source = options.source;
  return { region, file: { kind: "neural-board-region", schemaVersion: REGION_FILE_SCHEMA_VERSION, id: regionId, savedAt: now, manifest: options.manifest, assets } };
}

export function emptyRegionManifest(name: string, bounds: WorldRect, now = new Date().toISOString()): Record<string, unknown> {
  const projectId = id("proj");
  return {
    schemaVersion: 6,
    meta: { id: projectId, projectId, title: name, aspectRatio: "16:9", duration: 0, totalDurationSec: 0, createdAt: now, modifiedAt: now, trainingExample: false },
    board: { media: [], dimensions: { width: Math.max(REGION_MIN_WIDTH, Math.round(bounds.width)), height: Math.max(REGION_MIN_HEIGHT, Math.round(bounds.height)) }, pxPerSec: 20, boardZoom: 1, boardPan: { x: 0, y: 0 }, spawnDoor: null },
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

/** The new region's file must be written before the returned world is saved. */
export function createRegion(world: BoardWorld, name: string, bounds: WorldRect, now = new Date().toISOString()): { world: BoardWorld; file: WorldRegionFile } {
  const problem = validateRegionPlacement(world, bounds);
  if (problem) throw new Error(problem);
  const { region, file } = buildRegion({ name, bounds, manifest: emptyRegionManifest(name, bounds, now), now });
  return { world: { ...world, modifiedAt: now, regions: [...world.regions, region] }, file };
}

export function moveSelectedRegions(world: BoardWorld, selected: WorldSelection, dx: number, dy: number, now = new Date().toISOString()): BoardWorld {
  if (!selected.size || (!dx && !dy)) return world;
  const selectedIds = new Set(world.regions.filter((region) => selected.has(regionSelectionKey(region.id))).map((region) => region.id));
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

/** Per-item displacement in board space, keyed by item id, grouped by region. */
export type ItemMoves = Map<string, Map<string, { dx: number; dy: number }>>;

/** Limits a displacement to [low, high]; if the group already sticks out so far that the range is empty, the move is left alone. */
function clampMove(delta: number, low: number, high: number): number {
  return high < low ? delta : Math.min(high, Math.max(low, delta));
}

/** Moves the selected items' placements in the index. The manifest is updated separately with `translateManifestItems`. */
export function moveSelectedItems(world: BoardWorld, selected: WorldSelection, dx: number, dy: number, now = new Date().toISOString()): BoardWorld {
  if (!selected.size || (!dx && !dy)) return world;
  const regions = world.regions.map((region) => {
    const moving = new Set(region.lod.media.filter((item) => selected.has(itemSelectionKey(region.id, item.id))).map((item) => item.id));
    if (!moving.size) return region;
    // Items stay inside their region: the group is clamped as a whole so it keeps its shape against an edge.
    const group = region.lod.media.filter((item) => moving.has(item.id));
    const regionDx = clampMove(dx, -Math.min(...group.map((item) => item.x)), region.bounds.width - Math.max(...group.map((item) => item.x + item.width)));
    const regionDy = clampMove(dy, -Math.min(...group.map((item) => item.y)), region.bounds.height - Math.max(...group.map((item) => item.y + item.height)));
    const media = region.lod.media.map((item) => moving.has(item.id) ? { ...item, x: round1(item.x + regionDx), y: round1(item.y + regionDy) } : item);
    return { ...region, modifiedAt: now, lod: buildLod(media) };
  });
  return { ...world, modifiedAt: now, regions };
}

/** Diffs two worlds' placements into the per-item moves needed to bring a manifest in line. */
export function diffItemMoves(before: BoardWorld, after: BoardWorld): ItemMoves {
  const moves: ItemMoves = new Map();
  const previous = new Map(before.regions.map((region) => [region.id, region]));
  for (const region of after.regions) {
    const old = previous.get(region.id);
    if (!old || old.lod.media === region.lod.media) continue;
    const oldById = new Map(old.lod.media.map((item) => [item.id, item]));
    for (const item of region.lod.media) {
      const was = oldById.get(item.id);
      if (!was || (was.x === item.x && was.y === item.y)) continue;
      if (!moves.has(region.id)) moves.set(region.id, new Map());
      moves.get(region.id)!.set(item.id, { dx: item.x - was.x, dy: item.y - was.y });
    }
  }
  return moves;
}

/** Applies item moves to a region manifest. Returns a new manifest; the input is not mutated. */
export function translateManifestItems(manifest: Record<string, unknown>, moves: ReadonlyMap<string, { dx: number; dy: number }>): Record<string, unknown> {
  const next = structuredClone(manifest);
  const board = asRecord(next.board);
  if (Array.isArray(board.media)) {
    board.media = board.media.map((raw) => {
      const item = asRecord(raw);
      const move = moves.get(String(item.id));
      return move ? { ...item, boardX: number(item.boardX, 0) + move.dx, boardY: number(item.boardY, 0) + move.dy } : item;
    });
  }
  return next;
}

function containsEmbeddedBytes(value: unknown): boolean {
  if (typeof value === "string") return /^data:[^;,]+;base64,/i.test(value);
  if (Array.isArray(value)) return value.some(containsEmbeddedBytes);
  if (value && typeof value === "object") return Object.values(value).some(containsEmbeddedBytes);
  return false;
}

function fail(path: string, problem: string): never {
  throw new Error(`Invalid .nbw world file: ${path} ${problem}.`);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) fail(path, "must be a non-empty string");
  return value;
}

function requireRect(value: unknown, path: string): WorldRect {
  const rect = requireObject(value, path);
  requireFinite(rect.x, `${path}.x`);
  requireFinite(rect.y, `${path}.y`);
  if (requireFinite(rect.width, `${path}.width`) <= 0) fail(`${path}.width`, "must be greater than 0");
  if (requireFinite(rect.height, `${path}.height`) <= 0) fail(`${path}.height`, "must be greater than 0");
  return rect as WorldRect;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function requireAssetFile(value: unknown, path: string): string {
  const file = requireText(value, path);
  if (!ASSET_FILE_PATTERN.test(file)) fail(path, "must look like “<32 hex characters>.<extension>”");
  return file;
}

function requireSafeId(value: unknown, path: string): string {
  const text = requireText(value, path);
  if (!SAFE_ID_PATTERN.test(text)) fail(path, "may only contain letters, digits, “_” and “-”");
  return text;
}

function validateFarLod(value: unknown, path: string): void {
  const far = requireObject(value, path);
  const cols = requireFinite(far.cols, `${path}.cols`);
  const rows = requireFinite(far.rows, `${path}.rows`);
  if (!Number.isInteger(cols) || cols < 1 || cols > 64) fail(`${path}.cols`, "must be an integer from 1 to 64");
  if (!Number.isInteger(rows) || rows < 1 || rows > 64) fail(`${path}.rows`, "must be an integer from 1 to 64");
  if (requireFinite(far.extentWidth, `${path}.extentWidth`) <= 0) fail(`${path}.extentWidth`, "must be greater than 0");
  if (requireFinite(far.extentHeight, `${path}.extentHeight`) <= 0) fail(`${path}.extentHeight`, "must be greater than 0");
  const density = requireArray(far.density, `${path}.density`);
  if (density.length !== cols * rows) fail(`${path}.density`, `must have ${cols * rows} entries (cols × rows), found ${density.length}`);
  density.forEach((entry, index) => requireFinite(entry, `${path}.density[${index}]`));
}

function validatePlacement(value: unknown, path: string): void {
  const item = requireObject(value, path);
  requireText(item.id, `${path}.id`);
  if (item.type !== "image" && item.type !== "video" && item.type !== "other") fail(`${path}.type`, 'must be "image", "video" or "other"');
  for (const key of ["x", "y", "width", "height", "rotation"] as const) requireFinite(item[key], `${path}.${key}`);
  if (item.asset !== undefined) requireAssetFile(item.asset, `${path}.asset`);
  if (item.preview !== undefined) requireBoolean(item.preview, `${path}.preview`);
}

function validateAsset(value: unknown, path: string): void {
  const asset = requireObject(value, path);
  requireText(asset.archivePath, `${path}.archivePath`);
  requireAssetFile(asset.file, `${path}.file`);
  requireBoolean(asset.preview, `${path}.preview`);
  requireText(asset.mime, `${path}.mime`);
  requireFinite(asset.bytes, `${path}.bytes`);
}

function validateRegion(value: unknown, path: string): void {
  const region = requireObject(value, path);
  requireSafeId(region.id, `${path}.id`);
  requireText(region.name, `${path}.name`);
  requireRect(region.bounds, `${path}.bounds`);
  requireText(region.createdAt, `${path}.createdAt`);
  requireText(region.modifiedAt, `${path}.modifiedAt`);
  requireArray(region.refs, `${path}.refs`).forEach((ref, index) => requireAssetFile(ref, `${path}.refs[${index}]`));
  const lod = requireObject(region.lod, `${path}.lod`);
  requireText(lod.contentFingerprint, `${path}.lod.contentFingerprint`);
  requireArray(lod.media, `${path}.lod.media`).forEach((item, index) => validatePlacement(item, `${path}.lod.media[${index}]`));
  validateFarLod(lod.far, `${path}.lod.far`);
}

/** Throws a message naming the first malformed field, so a bad file fails at load instead of inside the render loop. */
export function assertWorldDocument(value: unknown): asserts value is BoardWorld {
  const world = requireObject(value, "document");
  if (world.kind !== "neural-board-world") fail("kind", 'must be "neural-board-world"');
  if (world.schemaVersion === 1) {
    throw new Error("This world file uses schema 1 from an earlier prototype that stored every manifest inline. Move it aside and re-import your boards to create a schema 2 world.");
  }
  if (world.schemaVersion !== WORLD_SCHEMA_VERSION) fail("schemaVersion", `must be ${WORLD_SCHEMA_VERSION}`);
  requireText(world.id, "id");
  requireText(world.name, "name");
  const mediaRoot = requireText(world.mediaRoot, "mediaRoot");
  if (/[\\/]/.test(mediaRoot) || mediaRoot === "." || mediaRoot === "..") fail("mediaRoot", "must be a single folder name");
  if (world.staging !== undefined) {
    const staging = requireObject(world.staging, "staging");
    requireFinite(staging.x, "staging.x");
    requireFinite(staging.y, "staging.y");
  }
  const seen = new Set<string>();
  requireArray(world.regions, "regions").forEach((region, index) => {
    validateRegion(region, `regions[${index}]`);
    const regionId = (region as Record<string, unknown>).id as string;
    if (seen.has(regionId)) fail(`regions[${index}].id`, `duplicates region id “${regionId}”`);
    seen.add(regionId);
  });
}

export function parseWorld(text: string): BoardWorld {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid .nbw world file: the file is not valid JSON."); }
  assertWorldDocument(value);
  return value;
}

export function assertRegionFile(value: unknown, expectedId?: string): asserts value is WorldRegionFile {
  const file = requireObject(value, "region file");
  if (file.kind !== "neural-board-region") fail("kind", 'must be "neural-board-region"');
  if (file.schemaVersion !== REGION_FILE_SCHEMA_VERSION) fail("schemaVersion", `must be ${REGION_FILE_SCHEMA_VERSION}`);
  const fileId = requireSafeId(file.id, "id");
  if (expectedId && fileId !== expectedId) fail("id", `is “${fileId}” but the index expected “${expectedId}”`);
  requireObject(file.manifest, "manifest");
  requireArray(file.assets, "assets").forEach((asset, index) => validateAsset(asset, `assets[${index}]`));
  if (containsEmbeddedBytes(file)) throw new Error("Region files may contain references only; embedded base64 media is not allowed.");
}

export function parseRegionFile(text: string, expectedId?: string): WorldRegionFile {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid region file: the file is not valid JSON."); }
  assertRegionFile(value, expectedId);
  return value;
}

export function serializeRegionFile(file: WorldRegionFile): string {
  assertRegionFile(file);
  return JSON.stringify(file);
}

export function serializeWorld(world: BoardWorld): string {
  assertWorldDocument(world);
  return JSON.stringify(world);
}

/** Size of a synthetic world built with the real serializers, so the projection tracks the real format. */
export function projectWorldSize(regionCount = 50, mediaPerRegion = 40, averageAssetBytes = 850_000): {
  indexBytes: number; regionFileBytes: number; assetBytes: number; previewBytes: number; totalBytes: number;
} {
  const now = "2026-01-01T00:00:00.000Z";
  const world = createEmptyWorld(now);
  let regionFileBytes = 0;
  const encoder = new TextEncoder();
  const hex = (n: number) => (n * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(4);
  world.regions = Array.from({ length: regionCount }, (_, regionIndex) => {
    const assets: WorldAsset[] = Array.from({ length: mediaPerRegion }, (_, mediaIndex) => ({
      archivePath: `assets/media_${regionIndex}_${mediaIndex}.jpg`,
      file: `${hex(regionIndex * 1000 + mediaIndex)}.jpg`,
      preview: true,
      mime: "image/jpeg",
      bytes: averageAssetBytes,
    }));
    const manifest = emptyRegionManifest(`Region ${regionIndex + 1}`, { x: 0, y: 0, width: 4000, height: 3000 }, now);
    (manifest.board as Record<string, unknown>).media = assets.map((asset, mediaIndex) => ({ id: `clip_${(mediaIndex * 7919).toString(36)}_x`, type: "image", assetFile: asset.archivePath, boardX: (mediaIndex % 8) * 440, boardY: Math.floor(mediaIndex / 8) * 520, boardW: 380, boardH: 300 }));
    const { region, file } = buildRegion({ regionId: `region_${regionIndex.toString(36)}_abcdefg`, name: `Region ${regionIndex + 1}`, bounds: { x: regionIndex * 4800, y: 0, width: 4000, height: 3000 }, manifest, assets, now });
    regionFileBytes += encoder.encode(serializeRegionFile(file)).byteLength;
    return region;
  });
  const indexBytes = encoder.encode(serializeWorld(world)).byteLength;
  const assetBytes = regionCount * mediaPerRegion * averageAssetBytes;
  const previewBytes = regionCount * mediaPerRegion * 12_000;
  return { indexBytes, regionFileBytes, assetBytes, previewBytes, totalBytes: indexBytes + regionFileBytes + assetBytes + previewBytes };
}
