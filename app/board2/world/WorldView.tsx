"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBoardsDirectory } from "@/lib/board-library";
import {
  REGION_MIN_HEIGHT,
  REGION_MIN_WIDTH,
  WORLD_PENDING_IMPORT_FILE,
  createRegion,
  diffItemMoves,
  itemSelectionKey,
  moveSelectedItems,
  moveSelectedRegions,
  rectIntersects,
  regionSelectionKey,
  validateRegionPlacement,
  visibleRegions,
  type BoardWorld,
  type WorldMediaPlacement,
  type WorldPoint,
  type WorldRect,
  type WorldRegion,
} from "@/lib/world/world-model";
import { FarBlobCache, INK, NEAR_INTERACTIVE_WEIGHT, drawRegion, lodWeights, regionMediaRect, type LodFrame } from "@/lib/world/lod-renderer";
import { collectWorldGarbage, commitItemMoves, commitRegionChanges, loadOrCreateWorld, materializeRegionFile, readWorldMedia, saveWorld } from "@/lib/world/world-store";
import { importBoardAsRegion } from "@/lib/world/region-import";
import { WorldImageStore } from "./image-store";

type Camera = { x: number; y: number; zoom: number };
type Gesture = {
  kind: "pan" | "marquee" | "create" | "move-regions" | "move-items";
  pointerId: number;
  startClient: WorldPoint;
  startWorld: WorldPoint;
  startCamera: Camera;
  originalWorld: BoardWorld | null;
  moved: boolean;
};

/** What the page-level world overlay needs from one editor workspace. */
export type WorkspaceWorldApi = {
  isDirty: () => boolean;
  name: () => string;
  loadRegion: (file: File, region: WorldRegion) => Promise<boolean>;
};

export type WorldViewProps = {
  open: boolean;
  onClose: () => void;
  /** Runs before the zoom-in. Return false to cancel (unsaved-changes prompt, region already open elsewhere). */
  beforeOpenRegion?: (region: WorldRegion) => Promise<boolean>;
  onOpenRegion: (file: File, region: WorldRegion) => Promise<boolean>;
  /** Where the world lives. Defaults to the user's boards folder; the dev bench swaps in a scratch directory. */
  getDirectory?: (options: { prompt: boolean }) => Promise<FileSystemDirectoryHandle | null>;
  /** Deep link (`/board2?worldRegionId=…`): once the world has loaded, zoom straight into this region. */
  initialRegionId?: string | null;
  /** Dev bench only: lets a script drive the camera and read live metrics. */
  controlRef?: React.MutableRefObject<WorldViewControl | null>;
};

export type WorldViewControl = {
  getCamera: () => Camera;
  setCamera: (camera: Camera) => void;
  fitWorld: () => Camera | null;
  metrics: () => { fps: number; drawMs: number; resident: number; loading: number; failed: number; liveUrls: number; blobs: number; regions: number; media: number; firstPaintMs: number | null };
};

const ink = INK;
const paper = "#e9e1cf";
const accent = "#c8f135";

// The camera is view state, not document state: it lives in localStorage so panning never rewrites the .nbw.
const cameraStorageKey = (worldId: string) => `nb_world_camera:${worldId}`;
function readSavedCamera(worldId: string): Camera | null {
  try {
    const raw = JSON.parse(localStorage.getItem(cameraStorageKey(worldId)) ?? "null") as Partial<Camera> | null;
    if (raw && [raw.x, raw.y, raw.zoom].every((value) => typeof value === "number" && Number.isFinite(value)) && (raw.zoom as number) > 0) return raw as Camera;
  } catch { /* storage unavailable or corrupt: fall back to fitting the world */ }
  return null;
}
function writeSavedCamera(worldId: string, camera: Camera): void {
  try { localStorage.setItem(cameraStorageKey(worldId), JSON.stringify(camera)); } catch { /* best effort */ }
}

const selectionKey = regionSelectionKey;
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function normalizedRect(a: WorldPoint, b: WorldPoint): WorldRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** A region is a project, and a project's board is never smaller than this; the drawn rectangle grows to it (top-left kept). */
function atLeastOneBoard(rect: WorldRect): WorldRect {
  return { ...rect, width: Math.max(rect.width, REGION_MIN_WIDTH), height: Math.max(rect.height, REGION_MIN_HEIGHT) };
}

function fitCamera(rect: WorldRect, width: number, height: number, padding = 70): Camera {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    zoom: clamp(Math.min((width - padding * 2) / rect.width, (height - padding * 2) / rect.height), 0.018, 1.4),
  };
}

function worldBounds(regions: readonly WorldRegion[]): WorldRect {
  if (!regions.length) return { x: -2000, y: -1500, width: 4000, height: 3000 };
  const left = Math.min(...regions.map((region) => region.bounds.x));
  const top = Math.min(...regions.map((region) => region.bounds.y));
  const right = Math.max(...regions.map((region) => region.bounds.x + region.bounds.width));
  const bottom = Math.max(...regions.map((region) => region.bounds.y + region.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function WorldView({ open, onClose, beforeOpenRegion, onOpenRegion, getDirectory, initialRegionId, controlRef }: WorldViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<BoardWorld | null>(null);
  const directoryRef = useRef<FileSystemDirectoryHandle | null>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 0.12 });
  const overviewCameraRef = useRef<Camera | null>(null);
  const activeRegionRef = useRef<string | null>(null);
  const selectionRef = useRef<Set<string>>(new Set());
  const gestureRef = useRef<Gesture | null>(null);
  const marqueeRef = useRef<WorldRect | null>(null);
  const createDraftRef = useRef<WorldRect | null>(null);
  const frameTimesRef = useRef<number[]>([]);
  const loadStartRef = useRef(0);
  const drawTimeRef = useRef(0);
  const firstFrameDoneRef = useRef(false);
  const reportedErrorsRef = useRef<Set<string>>(new Set());
  const imageStore = useMemo(() => new WorldImageStore(), []);
  const blobCache = useMemo(() => new FarBlobCache(), []);
  useEffect(() => {
    imageStore.setReader(async (path) => {
      const directory = directoryRef.current;
      const currentWorld = worldRef.current;
      if (!directory || !currentWorld) throw new Error("World is not open.");
      return readWorldMedia(directory, currentWorld, path);
    });
  }, [imageStore]);
  const firstOpenRef = useRef(true);
  const openingRef = useRef(false);
  const metricsRef = useRef({ fps: 0, drawMs: 0, firstPaintMs: null as number | null });
  const initialRegionRef = useRef(initialRegionId ?? null);
  const openRegionTargetRef = useRef<(region: WorldRegion) => Promise<void>>(async () => undefined);
  const [world, setWorld] = useState<BoardWorld | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 0.12 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"select" | "create">("select");
  const [marquee, setMarquee] = useState<WorldRect | null>(null);
  const [createDraft, setCreateDraft] = useState<WorldRect | null>(null);
  const [message, setMessage] = useState("Opening the world…");
  const [busy, setBusy] = useState(false);
  const [fps, setFps] = useState(0);
  const [residentMedia, setResidentMedia] = useState(0);
  const [drawMs, setDrawMs] = useState(0);
  const [storeStats, setStoreStats] = useState({ resident: 0, loading: 0, failed: 0, liveUrls: 0 });
  const [firstPaintMs, setFirstPaintMs] = useState<number | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [hasDirectory, setHasDirectory] = useState(false);
  const [hasActiveRegion, setHasActiveRegion] = useState(false);

  useEffect(() => { worldRef.current = world; }, [world]);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { marqueeRef.current = marquee; }, [marquee]);
  useEffect(() => { createDraftRef.current = createDraft; }, [createDraft]);
  useEffect(() => {
    const worldId = world?.id;
    if (!worldId) return;
    const timer = window.setTimeout(() => writeSavedCamera(worldId, camera), 400);
    return () => window.clearTimeout(timer);
  }, [camera, world?.id]);

  const persist = useCallback(async (nextWorld: BoardWorld) => {
    const directory = directoryRef.current;
    if (!directory) return;
    try { await saveWorld(directory, nextWorld); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the world."); }
  }, []);

  const setNextWorld = useCallback((nextWorld: BoardWorld, write = false) => {
    worldRef.current = nextWorld;
    setWorld(nextWorld);
    if (write) void persist(nextWorld);
  }, [persist]);

  const load = useCallback(async (prompt: boolean) => {
    setBusy(true);
    const started = performance.now();
    loadStartRef.current = started;
    firstFrameDoneRef.current = false;
    try {
      const directory = await (getDirectory ? getDirectory({ prompt }) : getBoardsDirectory({ prompt, write: true }));
      if (!directory) { setMessage("Choose the local boards folder to create or open Neural Board World.nbw."); return; }
      directoryRef.current = directory;
      setHasDirectory(true);
      let loaded = await loadOrCreateWorld(directory);
      let importedNow = false;
      const pendingFileName = sessionStorage.getItem(WORLD_PENDING_IMPORT_FILE);
      if (pendingFileName) {
        sessionStorage.removeItem(WORLD_PENDING_IMPORT_FILE);
        const source = await (await directory.getFileHandle(pendingFileName)).getFile();
        const imported = await importBoardAsRegion(directory, source);
        loaded = imported.world;
        importedNow = true;
        setMessage(`Imported “${imported.region.name}” into the staging strip. The source .nbp was not changed.`);
      } else {
        setMessage(loaded.regions.length ? `${loaded.regions.length} regions · drag empty space to select · Space-drag to pan` : "Draw a region, or import a .nbp from Library → Boards.");
      }
      worldRef.current = loaded;
      setWorld(loaded);
      // Sweep orphaned files a little after the world is on screen; the grace period protects fresh writes.
      window.setTimeout(() => { void collectWorldGarbage(directory).catch(() => undefined); }, 4000);
      const canvas = canvasRef.current;
      if (canvas) {
        const saved = importedNow ? null : readSavedCamera(loaded.id);
        const nextCamera = saved ?? fitCamera(worldBounds(loaded.regions), canvas.clientWidth, canvas.clientHeight);
        cameraRef.current = nextCamera;
        setCamera(nextCamera);
      }
      const deepLinked = initialRegionRef.current ? loaded.regions.find((region) => region.id === initialRegionRef.current) : undefined;
      if (initialRegionRef.current) {
        initialRegionRef.current = null;
        if (deepLinked) window.setTimeout(() => { void openRegionTargetRef.current(deepLinked); }, 0);
        else setMessage("That region is no longer in the world.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the world.");
    } finally {
      setBusy(false);
    }
  }, [getDirectory]);

  useEffect(() => {
    if (!open || worldRef.current) return;
    void load(false);
  }, [load, open]);
  useEffect(() => {
    if (!open || !worldRef.current || !directoryRef.current) return;
    let cancelled = false;
    void loadOrCreateWorld(directoryRef.current).then((fresh) => {
      if (!cancelled) setNextWorld(fresh);
    }).catch((error) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not refresh the world.");
    });
    return () => { cancelled = true; };
  }, [open, setNextWorld]);

  // While the world is open it owns the keyboard and clipboard. The editor underneath registers
  // bubble-phase window listeners (undo, delete, space-to-play, live-mode keys, paste-to-board…);
  // a capture-phase listener that stops propagation keeps every one of them, present or future,
  // from seeing the event. Focus is moved off any hidden editor input so typing cannot reach it.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    containerRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (event.type === "keydown") {
        if (event.code === "Space") { event.preventDefault(); setSpaceDown(true); }
        if (event.key === "Escape") { setSelection(new Set()); setMode("select"); setMarquee(null); setCreateDraft(null); }
        if (event.key === "Tab" && container) {
          const focusable = [...container.querySelectorAll<HTMLElement>("button:not([disabled])")];
          const first = focusable[0];
          const last = focusable.at(-1);
          const inside = container.contains(document.activeElement) && document.activeElement !== container;
          if (!focusable.length) event.preventDefault();
          else if (!inside) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      } else if (event.type === "keyup" && event.code === "Space") setSpaceDown(false);
      event.stopImmediatePropagation();
    };
    const swallow = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("keypress", swallow, true);
    window.addEventListener("paste", swallow, true);
    window.addEventListener("copy", swallow, true);
    window.addEventListener("cut", swallow, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("keypress", swallow, true);
      window.removeEventListener("paste", swallow, true);
      window.removeEventListener("copy", swallow, true);
      window.removeEventListener("cut", swallow, true);
      setSpaceDown(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open || firstOpenRef.current || !activeRegionRef.current || !overviewCameraRef.current) { firstOpenRef.current = false; return; }
    const region = worldRef.current?.regions.find((candidate) => candidate.id === activeRegionRef.current);
    const canvas = canvasRef.current;
    if (!region || !canvas) return;
    const start = fitCamera(region.bounds, canvas.clientWidth, canvas.clientHeight, 25);
    const target = overviewCameraRef.current;
    cameraRef.current = start;
    setCamera(start);
    animateCamera(start, target, 520, (value) => { cameraRef.current = value; setCamera(value); });
  }, [open]);

  // Far-zoom blobs are built ahead of time in small idle slices, so the first FAR frame only blits.
  useEffect(() => {
    if (!open || !world) return;
    let cancelled = false;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      if (blobCache.prewarm(world.regions, 5, performance.now()) > 0) timer = window.setTimeout(step, 16);
    };
    timer = window.setTimeout(step, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [blobCache, open, world]);
  // The canvas draws region names in the hand-lettered font; make sure it is loaded before the first far frame.
  useEffect(() => {
    if (open) void document.fonts?.load("700 64px Caveat").catch(() => undefined);
  }, [open]);
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      getCamera: () => cameraRef.current,
      setCamera: (next) => { cameraRef.current = next; setCamera(next); },
      fitWorld: () => {
        const canvas = canvasRef.current;
        const current = worldRef.current;
        if (!canvas || !current) return null;
        const next = fitCamera(worldBounds(current.regions), canvas.clientWidth, canvas.clientHeight);
        cameraRef.current = next; setCamera(next);
        return next;
      },
      metrics: () => {
        const stats = imageStore.stats();
        const regions = worldRef.current?.regions ?? [];
        return { ...metricsRef.current, resident: stats.resident, loading: stats.loading, failed: stats.failed, liveUrls: stats.liveUrls, blobs: blobCache.stats().cached, regions: regions.length, media: regions.reduce((total, region) => total + region.lod.media.length, 0) };
      },
    };
    return () => { controlRef.current = null; };
  }, [blobCache, controlRef, imageStore]);

  const toWorld = useCallback((clientX: number, clientY: number): WorldPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const current = cameraRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: current.x + (clientX - rect.left - rect.width / 2) / current.zoom, y: current.y + (clientY - rect.top - rect.height / 2) / current.zoom };
  }, []);

  // Zoom level decides what a press means. Zoomed out (FAR/MID) a region is the unit: click selects it, drag moves it.
  // Zoomed in (NEAR) the items inside are the unit, so the region's empty background starts a box-select instead,
  // and the region is grabbed by its name label above the frame.
  const hit = useCallback((point: WorldPoint): { region: WorldRegion; item?: WorldMediaPlacement; background?: boolean } | null => {
    const current = worldRef.current;
    if (!current) return null;
    const probe = { ...point, width: 0.01, height: 0.01 };
    const itemLevel = lodWeights(cameraRef.current.zoom).near > NEAR_INTERACTIVE_WEIGHT;
    const labelBand = 64 / cameraRef.current.zoom;
    for (const region of [...current.regions].reverse()) {
      const inside = rectIntersects(region.bounds, probe);
      if (!inside) {
        if (itemLevel && rectIntersects({ x: region.bounds.x, y: region.bounds.y - labelBand, width: region.bounds.width, height: labelBand }, probe)) return { region };
        continue;
      }
      if (!itemLevel) return { region };
      const item = [...region.lod.media].reverse().find((media) => rectIntersects(regionMediaRect(region, media), probe));
      return item ? { region, item } : { region, background: true };
    }
    return null;
  }, []);

  const updateSelection = useCallback((next: Set<string>) => {
    selectionRef.current = next;
    setSelection(new Set(next));
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!worldRef.current || openingRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toWorld(event.clientX, event.clientY);
    const currentCamera = cameraRef.current;
    const target = hit(point);
    const pan = event.button === 1 || event.button === 2 || spaceDown || (event.pointerType === "touch" && mode === "select" && (!target || target.background));
    if (pan) {
      gestureRef.current = { kind: "pan", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: null, moved: false };
      return;
    }
    if (mode === "create") {
      gestureRef.current = { kind: "create", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: worldRef.current, moved: false };
      setCreateDraft({ ...point, width: 0, height: 0 });
      return;
    }
    if (target && !target.background) {
      const key = target.item ? itemSelectionKey(target.region.id, target.item.id) : selectionKey(target.region.id);
      const next = new Set(selectionRef.current);
      if (event.shiftKey) {
        if (next.has(key)) next.delete(key); else next.add(key);
        updateSelection(next);
      } else if (!next.has(key)) updateSelection(new Set([key]));
      const active = event.shiftKey ? next : selectionRef.current.has(key) ? selectionRef.current : new Set([key]);
      const kind = [...active].some((candidate) => candidate.startsWith("item:")) ? "move-items" : "move-regions";
      gestureRef.current = { kind, pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: worldRef.current, moved: false };
      return;
    }
    if (!event.shiftKey) updateSelection(new Set());
    gestureRef.current = { kind: "marquee", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: worldRef.current, moved: false };
    setMarquee({ ...point, width: 0, height: 0 });
  }, [hit, mode, spaceDown, toWorld, updateSelection]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const pixelDistance = Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y);
    if (pixelDistance > 3) gesture.moved = true;
    if (gesture.kind === "pan") {
      const next = { ...gesture.startCamera, x: gesture.startCamera.x - (event.clientX - gesture.startClient.x) / gesture.startCamera.zoom, y: gesture.startCamera.y - (event.clientY - gesture.startClient.y) / gesture.startCamera.zoom };
      cameraRef.current = next; setCamera(next); return;
    }
    const point = toWorld(event.clientX, event.clientY);
    const rect = normalizedRect(gesture.startWorld, point);
    if (gesture.kind === "marquee") {
      setMarquee(rect);
      const current = gesture.originalWorld;
      if (!current) return;
      const next = new Set<string>();
      const itemLevel = lodWeights(cameraRef.current.zoom).near > NEAR_INTERACTIVE_WEIGHT;
      for (const region of current.regions) {
        if (!itemLevel) { if (rectIntersects(rect, region.bounds)) next.add(selectionKey(region.id)); continue; }
        if (!rectIntersects(rect, region.bounds)) continue;
        for (const media of region.lod.media) if (rectIntersects(rect, regionMediaRect(region, media))) next.add(itemSelectionKey(region.id, media.id));
      }
      updateSelection(next); return;
    }
    if (gesture.kind === "create") { setCreateDraft(atLeastOneBoard(rect)); return; }
    if (!gesture.originalWorld) return;
    const dx = point.x - gesture.startWorld.x;
    const dy = point.y - gesture.startWorld.y;
    const moved = gesture.kind === "move-regions"
      ? moveSelectedRegions(gesture.originalWorld, selectionRef.current, dx, dy)
      : moveSelectedItems(gesture.originalWorld, selectionRef.current, dx, dy);
    setNextWorld(moved);
  }, [setNextWorld, toWorld, updateSelection]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.kind === "create") {
      const draft = createDraftRef.current;
      setCreateDraft(null);
      if (!draft || !worldRef.current || (Math.abs(gesture.startClient.x - event.clientX) < 6 && Math.abs(gesture.startClient.y - event.clientY) < 6)) { setMessage("Drag a rectangle on the world to draw a region."); return; }
      const problem = validateRegionPlacement(worldRef.current, draft);
      if (problem) { setMessage(problem); return; }
      const name = window.prompt("Name this region:", "Untitled region")?.trim();
      if (!name) { setMessage("Region creation cancelled."); return; }
      try {
        const { world: next, file } = createRegion(worldRef.current, name, draft);
        const directory = directoryRef.current;
        // Region file first, then the index that points at it; the region only appears once both are on disk.
        const written = directory ? commitRegionChanges(directory, next, [file]) : Promise.reject(new Error("Choose the world folder first."));
        void written.then(() => {
          setNextWorld(next);
          setMode("select");
          setMessage(`Created “${name}”. Double-click it to open the empty project.`);
        }).catch((error) => setMessage(error instanceof Error ? error.message : "Could not create region."));
      } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create region."); }
      return;
    }
    if (gesture.kind === "marquee") setMarquee(null);
    if (gesture.kind === "move-regions" && gesture.moved && worldRef.current) void persist(worldRef.current);
    if (gesture.kind === "move-items" && gesture.moved && worldRef.current && gesture.originalWorld) {
      const directory = directoryRef.current;
      const moved = worldRef.current;
      const original = gesture.originalWorld;
      const moves = diffItemMoves(original, moved);
      if (directory && moves.size) {
        commitItemMoves(directory, moved, moves).catch((error) => {
          setNextWorld(original);
          setMessage(`Move not saved, put back: ${error instanceof Error ? error.message : "could not write the region file."}`);
        });
      }
    }
  }, [persist, setNextWorld]);

  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const before = toWorld(event.clientX, event.clientY);
    const current = cameraRef.current;
    const zoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0012), 0.012, 2.4);
    const rect = event.currentTarget.getBoundingClientRect();
    const next = {
      x: before.x - (event.clientX - rect.left - rect.width / 2) / zoom,
      y: before.y - (event.clientY - rect.top - rect.height / 2) / zoom,
      zoom,
    };
    cameraRef.current = next;
    setCamera(next);
  }, [toWorld]);

  const openRegionTarget = useCallback(async (region: WorldRegion) => {
    const canvas = canvasRef.current;
    if (openingRef.current || !worldRef.current || !directoryRef.current || !canvas) return;
    openingRef.current = true;
    try {
      // The guard runs first: no zoom animation, no file work, until the user has agreed to
      // discard unsaved edits (or the region turns out to be open in another tab).
      if (beforeOpenRegion && !(await beforeOpenRegion(region))) return;
      overviewCameraRef.current = cameraRef.current;
      const targetCamera = fitCamera(region.bounds, canvas.clientWidth, canvas.clientHeight, 24);
      await animateCamera(cameraRef.current, targetCamera, 560, (value) => { cameraRef.current = value; setCamera(value); });
      setBusy(true);
      const file = await materializeRegionFile(directoryRef.current, worldRef.current, region);
      const opened = await onOpenRegion(file, region);
      if (opened) {
        activeRegionRef.current = region.id;
        setHasActiveRegion(true);
        onClose();
      } else if (overviewCameraRef.current) {
        cameraRef.current = overviewCameraRef.current;
        setCamera(overviewCameraRef.current);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not open this region."); }
    finally { setBusy(false); openingRef.current = false; }
  }, [beforeOpenRegion, onClose, onOpenRegion]);
  useEffect(() => { openRegionTargetRef.current = openRegionTarget; }, [openRegionTarget]);

  const openRegion = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const target = hit(toWorld(event.clientX, event.clientY));
    if (target) void openRegionTarget(target.region);
  }, [hit, openRegionTarget, toWorld]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let lastStats = performance.now();
    const reportError = (key: string, error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      if (reportedErrorsRef.current.has(key)) return;
      reportedErrorsRef.current.add(key);
      console.error(`[world] render error (${key})`, error);
      setMessage(`Rendering problem (${key}): ${text}`);
    };
    const renderFrame = (now: number) => {
      const canvas = canvasRef.current;
      const currentWorld = worldRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context || !currentWorld) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.globalAlpha = 1;
      context.setLineDash([]);
      context.fillStyle = paper;
      context.fillRect(0, 0, width, height);
      const currentCamera = cameraRef.current;
      const viewport = { x: currentCamera.x - width / (2 * currentCamera.zoom), y: currentCamera.y - height / (2 * currentCamera.zoom), width: width / currentCamera.zoom, height: height / currentCamera.zoom };
      const visible = visibleRegions(currentWorld, viewport);
      const frame: LodFrame = {
        camera: currentCamera,
        viewport,
        weights: lodWeights(currentCamera.zoom),
        now,
        images: imageStore,
        blobs: blobCache,
        isSelected: (key) => selectionRef.current.has(key),
      };
      context.save();
      context.translate(width / 2, height / 2);
      context.scale(currentCamera.zoom, currentCamera.zoom);
      context.translate(-currentCamera.x, -currentCamera.y);
      for (const region of visible) {
        // One malformed region must not blank the rest of the world; unwind whatever it left on the canvas stack.
        try { drawRegion(context, region, frame); }
        catch (error) {
          for (let depth = 0; depth < 6; depth += 1) context.restore();
          context.save();
          context.translate(width / 2, height / 2);
          context.scale(currentCamera.zoom, currentCamera.zoom);
          context.translate(-currentCamera.x, -currentCamera.y);
          reportError(`region “${region.name}”`, error);
        }
      }
      const drawOverlayRect = (rect: WorldRect | null, color: string) => {
        if (!rect) return;
        context.fillStyle = `${color}22`; context.strokeStyle = color; context.lineWidth = 2 / currentCamera.zoom; context.setLineDash([9 / currentCamera.zoom, 7 / currentCamera.zoom]); context.fillRect(rect.x, rect.y, rect.width, rect.height); context.strokeRect(rect.x, rect.y, rect.width, rect.height); context.setLineDash([]);
      };
      drawOverlayRect(marqueeRef.current, "#557100");
      const draft = createDraftRef.current;
      const draftProblem = draft ? validateRegionPlacement(currentWorld, draft) : null;
      drawOverlayRect(draft, draftProblem ? "#b42318" : "#557100");
      context.restore();
    };
    const draw = (now: number) => {
      const started = performance.now();
      try {
        renderFrame(now);
        // Runs outside renderFrame's canvas work so a drawing error can't strand loads or evictions.
        imageStore.pump(now, lodWeights(cameraRef.current.zoom).far <= .998);
      } catch (error) {
        const canvasContext = canvasRef.current?.getContext("2d");
        if (canvasContext) for (let depth = 0; depth < 8; depth += 1) canvasContext.restore();
        reportError("frame", error);
      } finally {
        frame = requestAnimationFrame(draw);
      }
      if (worldRef.current && !firstFrameDoneRef.current) {
        firstFrameDoneRef.current = true;
        metricsRef.current.firstPaintMs = performance.now() - loadStartRef.current;
        setFirstPaintMs(metricsRef.current.firstPaintMs);
      }
      const finished = performance.now();
      frameTimesRef.current.push(now);
      while (frameTimesRef.current.length && frameTimesRef.current[0] < now - 1000) frameTimesRef.current.shift();
      drawTimeRef.current += (finished - started - drawTimeRef.current) * 0.1;
      if (finished - lastStats > 400) {
        setFps(frameTimesRef.current.length);
        const stats = imageStore.stats();
        metricsRef.current.fps = frameTimesRef.current.length;
        metricsRef.current.drawMs = drawTimeRef.current;
        setResidentMedia(stats.resident);
        setStoreStats(stats);
        setDrawMs(drawTimeRef.current);
        lastStats = finished;
      }
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); imageStore.clear(); };
  }, [blobCache, imageStore, open]);

  useEffect(() => () => { imageStore.clear(); blobCache.clear(); }, [blobCache, imageStore]);

  const metricWeights = lodWeights(camera.zoom);
  const detailLevel = metricWeights.far >= metricWeights.mid && metricWeights.far >= metricWeights.near ? "FAR" : metricWeights.near > metricWeights.mid ? "NEAR" : "MID";

  return (
    <div ref={containerRef} tabIndex={-1} role="dialog" aria-label="Neural Board World" aria-hidden={!open} style={{ position: "fixed", inset: 0, zIndex: 5000, background: paper, opacity: open ? 1 : 0, visibility: open ? "visible" : "hidden", pointerEvents: open ? "auto" : "none", transition: `opacity 280ms ease, visibility 0s linear ${open ? 0 : 280}ms`, fontFamily: "monospace", outline: "none" }}>
      <style>{`@media (max-width: 720px) { .nb-world-title, .nb-world-metrics { display: none !important; } .nb-world-toolbar { flex-wrap: wrap; max-width: calc(100vw - 32px); } }`}</style>
      <canvas ref={canvasRef} aria-label="Neural Board World canvas" onContextMenu={(event) => event.preventDefault()} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={openRegion} style={{ width: "100%", height: "100%", display: "block", cursor: spaceDown ? "grab" : mode === "create" ? "crosshair" : "default", touchAction: "none" }} />
      <header style={{ position: "absolute", top: 16, left: 16, right: 16, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        <div className="nb-world-toolbar" style={{ pointerEvents: "auto", display: "flex", gap: 7, alignItems: "center", padding: "8px 10px", background: "rgba(255,253,245,.94)", border: `2px solid ${ink}`, boxShadow: `3px 3px 0 ${ink}` }}>
          <strong className="nb-world-title" style={{ font: "700 24px 'Caveat', Georgia, serif", marginRight: 5 }}>Neural Board World</strong>
          <button type="button" onClick={() => setMode("select")} style={button(mode === "select")}>↖ Select</button>
          <button type="button" onClick={() => setMode("create")} style={button(mode === "create")}>▭ Draw region</button>
          <button type="button" onClick={() => { const canvas = canvasRef.current; const current = worldRef.current; if (!canvas || !current) return; const next = fitCamera(worldBounds(current.regions), canvas.clientWidth, canvas.clientHeight); cameraRef.current = next; setCamera(next); }} style={button(false)}>Fit world</button>
          {!hasDirectory && <button type="button" onClick={() => void load(true)} disabled={busy} style={{ ...button(false), background: accent }}>Choose folder</button>}
          <button type="button" onClick={onClose} style={button(false)}>{hasActiveRegion ? "Return to region" : "Close world"}</button>
        </div>
        <div className="nb-world-metrics" data-fps={fps} data-draw-ms={drawMs.toFixed(2)} data-resident={residentMedia} data-loading={storeStats.loading} data-failed={storeStats.failed} data-live-urls={storeStats.liveUrls} data-zoom={camera.zoom} data-lod={detailLevel} data-first-paint={firstPaintMs ?? ""} style={{ marginLeft: "auto", pointerEvents: "auto", padding: "7px 10px", background: "rgba(40,37,31,.9)", color: "#fffdf5", fontSize: 10, lineHeight: 1.45 }}>
          {detailLevel} · {fps} fps · {drawMs.toFixed(1)}ms draw · {residentMedia} media resident{firstPaintMs != null ? ` · first paint ${Math.round(firstPaintMs)}ms` : ""}
        </div>
      </header>
      <div role="status" style={{ position: "absolute", left: 16, bottom: 16, maxWidth: "min(720px,calc(100vw - 32px))", padding: "8px 11px", background: "rgba(255,253,245,.94)", border: `1.5px solid ${ink}`, color: ink, fontSize: 11, boxShadow: `2px 2px 0 ${ink}` }}>
        {busy ? "Working… " : ""}{message} · Shift-click adds/removes · Escape clears · double-click opens · zoomed in: drag to box-select items, drag a region’s name to move it
      </div>
    </div>
  );
}

function button(active: boolean): React.CSSProperties {
  return { border: `1.5px solid ${ink}`, background: active ? accent : "#fffdf5", color: ink, padding: "7px 9px", cursor: "pointer", font: "11px monospace", boxShadow: active ? `2px 2px 0 ${ink}` : "none" };
}

function animateCamera(start: Camera, end: Camera, durationMs: number, update: (camera: Camera) => void): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const frame = (now: number) => {
      const raw = clamp((now - started) / durationMs, 0, 1);
      const t = raw < .5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      update({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, zoom: start.zoom + (end.zoom - start.zoom) * t });
      if (raw < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}
