"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBoardsDirectory } from "@/lib/board-library";
import {
  WORLD_PENDING_IMPORT_FILE,
  createRegion,
  lodWeights,
  moveSelectedItems,
  moveSelectedRegions,
  rectIntersects,
  validateRegionPlacement,
  visibleRegions,
  type BoardWorld,
  type WorldMediaPlacement,
  type WorldPoint,
  type WorldRect,
  type WorldRegion,
} from "@/lib/board-world";
import { importBoardAsRegion, loadOrCreateWorld, materializeRegionFile, saveWorld, worldMediaUrl } from "@/lib/board-world-storage";

type Camera = { x: number; y: number; zoom: number };
type CachedImage = { image: HTMLImageElement; objectUrl: string; lastUsed: number };
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
};

const ink = "#28251f";
const paper = "#e9e1cf";
const accent = "#c8f135";

function selectionKey(regionId: string): string { return `region:${regionId}`; }
function itemSelectionKey(regionId: string, mediaId: string): string { return `item:${regionId}:${mediaId}`; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function regionMediaRect(region: WorldRegion, media: WorldMediaPlacement): WorldRect {
  return { x: region.bounds.x + media.x, y: region.bounds.y + media.y, width: media.width, height: media.height };
}

function normalizedRect(a: WorldPoint, b: WorldPoint): WorldRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
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

export function WorldView({ open, onClose, beforeOpenRegion, onOpenRegion }: WorldViewProps) {
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
  const imageCacheRef = useRef<Map<string, CachedImage>>(new Map());
  const pendingImagesRef = useRef<Set<string>>(new Set());
  const frameTimesRef = useRef<number[]>([]);
  const firstOpenRef = useRef(true);
  const openingRef = useRef(false);
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
  const [firstPaintMs, setFirstPaintMs] = useState<number | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [hasDirectory, setHasDirectory] = useState(false);
  const [hasActiveRegion, setHasActiveRegion] = useState(false);

  useEffect(() => { worldRef.current = world; }, [world]);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { marqueeRef.current = marquee; }, [marquee]);
  useEffect(() => { createDraftRef.current = createDraft; }, [createDraft]);

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
    try {
      const directory = await getBoardsDirectory({ prompt, write: true });
      if (!directory) { setMessage("Choose the local boards folder to create or open Neural Board World.nbw."); return; }
      directoryRef.current = directory;
      setHasDirectory(true);
      let loaded = await loadOrCreateWorld(directory);
      const pendingFileName = sessionStorage.getItem(WORLD_PENDING_IMPORT_FILE);
      if (pendingFileName) {
        sessionStorage.removeItem(WORLD_PENDING_IMPORT_FILE);
        const source = await (await directory.getFileHandle(pendingFileName)).getFile();
        const imported = await importBoardAsRegion(directory, loaded, source);
        loaded = imported.world;
        setMessage(`Imported “${imported.region.name}” into the staging strip. The source .nbp was not changed.`);
      } else {
        setMessage(loaded.regions.length ? `${loaded.regions.length} regions · drag empty space to select · Space-drag to pan` : "Draw a region, or import a .nbp from Library → Boards.");
      }
      worldRef.current = loaded;
      setWorld(loaded);
      const canvas = canvasRef.current;
      if (canvas) {
        const nextCamera = loaded.regions.length ? fitCamera(worldBounds(loaded.regions), canvas.clientWidth, canvas.clientHeight) : loaded.camera;
        cameraRef.current = nextCamera;
        setCamera(nextCamera);
      }
      requestAnimationFrame(() => setFirstPaintMs(performance.now() - started));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the world.");
    } finally {
      setBusy(false);
    }
  }, []);

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

  const toWorld = useCallback((clientX: number, clientY: number): WorldPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const current = cameraRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: current.x + (clientX - rect.left - rect.width / 2) / current.zoom, y: current.y + (clientY - rect.top - rect.height / 2) / current.zoom };
  }, []);

  const hit = useCallback((point: WorldPoint): { region: WorldRegion; item?: WorldMediaPlacement } | null => {
    const current = worldRef.current;
    if (!current) return null;
    for (const region of [...current.regions].reverse()) {
      if (!rectIntersects(region.bounds, { ...point, width: 0.01, height: 0.01 })) continue;
      if (lodWeights(cameraRef.current.zoom).near > 0.18) {
        const item = [...region.lod.media].reverse().find((media) => rectIntersects(regionMediaRect(region, media), { ...point, width: 0.01, height: 0.01 }));
        if (item) return { region, item };
      }
      return { region };
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
    const pan = event.button === 1 || event.button === 2 || spaceDown || (event.pointerType === "touch" && mode === "select" && !target);
    if (pan) {
      gestureRef.current = { kind: "pan", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: null, moved: false };
      return;
    }
    if (mode === "create") {
      gestureRef.current = { kind: "create", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, startCamera: currentCamera, originalWorld: worldRef.current, moved: false };
      setCreateDraft({ ...point, width: 0, height: 0 });
      return;
    }
    if (target) {
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
      for (const region of current.regions) {
        if (rectIntersects(rect, region.bounds)) next.add(selectionKey(region.id));
        if (lodWeights(cameraRef.current.zoom).near > 0.18) for (const media of region.lod.media) if (rectIntersects(rect, regionMediaRect(region, media))) next.add(itemSelectionKey(region.id, media.id));
      }
      updateSelection(next); return;
    }
    if (gesture.kind === "create") { setCreateDraft(rect); return; }
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
      if (!draft || draft.width < 400 || draft.height < 300 || !worldRef.current) { setMessage("Draw at least 400 × 300 world units for a region."); return; }
      const problem = validateRegionPlacement(worldRef.current, draft);
      if (problem) { setMessage(problem); return; }
      const name = window.prompt("Name this region:", "Untitled region")?.trim();
      if (!name) { setMessage("Region creation cancelled."); return; }
      try {
        const next = createRegion(worldRef.current, name, draft);
        setNextWorld(next, true);
        setMode("select");
        setMessage(`Created “${name}”. Double-click it to open the empty project.`);
      } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create region."); }
      return;
    }
    if (gesture.kind === "marquee") setMarquee(null);
    if ((gesture.kind === "move-items" || gesture.kind === "move-regions") && gesture.moved && worldRef.current) void persist(worldRef.current);
    if (gesture.kind === "pan" && worldRef.current) {
      const next = { ...worldRef.current, camera: cameraRef.current, modifiedAt: new Date().toISOString() };
      setNextWorld(next); void persist(next);
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

  const openRegion = useCallback(async (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (openingRef.current || !worldRef.current || !directoryRef.current) return;
    const target = hit(toWorld(event.clientX, event.clientY));
    const canvas = canvasRef.current;
    if (!target || !canvas) return;
    openingRef.current = true;
    try {
      // The guard runs first: no zoom animation, no file work, until the user has agreed to
      // discard unsaved edits (or the region turns out to be open in another tab).
      if (beforeOpenRegion && !(await beforeOpenRegion(target.region))) return;
      overviewCameraRef.current = cameraRef.current;
      const targetCamera = fitCamera(target.region.bounds, canvas.clientWidth, canvas.clientHeight, 24);
      await animateCamera(cameraRef.current, targetCamera, 560, (value) => { cameraRef.current = value; setCamera(value); });
      setBusy(true);
      const file = await materializeRegionFile(directoryRef.current, worldRef.current, target.region);
      const opened = await onOpenRegion(file, target.region);
      if (opened) {
        activeRegionRef.current = target.region.id;
        setHasActiveRegion(true);
        onClose();
      } else if (overviewCameraRef.current) {
        cameraRef.current = overviewCameraRef.current;
        setCamera(overviewCameraRef.current);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not open this region."); }
    finally { setBusy(false); openingRef.current = false; }
  }, [beforeOpenRegion, hit, onClose, onOpenRegion, toWorld]);

  const loadImage = useCallback((path: string) => {
    const directory = directoryRef.current;
    const currentWorld = worldRef.current;
    if (!directory || !currentWorld || imageCacheRef.current.has(path) || pendingImagesRef.current.has(path)) return;
    pendingImagesRef.current.add(path);
    void worldMediaUrl(directory, currentWorld, path).then((objectUrl) => {
      const image = new Image();
      image.onload = () => {
        if (lodWeights(cameraRef.current.zoom).far > .998) URL.revokeObjectURL(objectUrl);
        else imageCacheRef.current.set(path, { image, objectUrl, lastUsed: performance.now() });
        pendingImagesRef.current.delete(path);
      };
      image.onerror = () => { URL.revokeObjectURL(objectUrl); pendingImagesRef.current.delete(path); };
      image.src = objectUrl;
    }).catch(() => pendingImagesRef.current.delete(path));
  }, []);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let lastStats = performance.now();
    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const currentWorld = worldRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context || !currentWorld) { frame = requestAnimationFrame(draw); return; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = paper;
      context.fillRect(0, 0, width, height);
      const currentCamera = cameraRef.current;
      const viewport = { x: currentCamera.x - width / (2 * currentCamera.zoom), y: currentCamera.y - height / (2 * currentCamera.zoom), width: width / currentCamera.zoom, height: height / currentCamera.zoom };
      const visible = visibleRegions(currentWorld, viewport);
      const weights = lodWeights(currentCamera.zoom);
      const desiredPaths = new Set<string>();
      context.save();
      context.translate(width / 2, height / 2);
      context.scale(currentCamera.zoom, currentCamera.zoom);
      context.translate(-currentCamera.x, -currentCamera.y);
      for (const region of visible) {
        const selected = selectionRef.current.has(selectionKey(region.id));
        context.fillStyle = "rgba(255,253,245,.38)";
        context.strokeStyle = selected ? "#688600" : "rgba(40,37,31,.35)";
        context.lineWidth = (selected ? 5 : 2) / currentCamera.zoom;
        context.setLineDash(selected ? [16 / currentCamera.zoom, 10 / currentCamera.zoom] : []);
        context.fillRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
        context.strokeRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
        context.setLineDash([]);
        if (weights.far > 0.002) {
          context.save(); context.globalAlpha = weights.far;
          for (const cell of region.lod.far.cells) {
            context.fillStyle = `rgba(53,66,53,${0.08 + cell.density * 0.18})`;
            context.beginPath();
            context.ellipse(region.bounds.x + cell.x + cell.width / 2, region.bounds.y + cell.y + cell.height / 2, cell.width * .62, cell.height * .62, 0, 0, Math.PI * 2);
            context.fill();
          }
          const labelSize = clamp(250 + region.lod.media.length * 10, 280, Math.min(760, region.bounds.width * .18));
          context.fillStyle = ink; context.textAlign = "center"; context.textBaseline = "middle"; context.font = `700 ${labelSize}px 'Caveat', Georgia, serif`;
          context.fillText(region.name, region.bounds.x + region.bounds.width / 2, region.bounds.y + region.bounds.height / 2, region.bounds.width * .82);
          context.restore();
        }
        const drawMedia = (detail: "mid" | "near", alpha: number) => {
          if (alpha <= 0.002) return;
          context.save(); context.globalAlpha = alpha;
          for (const media of region.lod.media) {
            const rect = regionMediaRect(region, media);
            if (!rectIntersects(viewport, rect)) continue;
            const path = detail === "near" ? media.assetPath : media.previewPath;
            if (path) { desiredPaths.add(path); loadImage(path); }
            const cached = path ? imageCacheRef.current.get(path) : undefined;
            context.save();
            context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
            context.rotate(media.rotation * Math.PI / 180);
            if (cached?.image.complete) { cached.lastUsed = now; context.drawImage(cached.image, -rect.width / 2, -rect.height / 2, rect.width, rect.height); }
            else { context.fillStyle = detail === "mid" ? "#b9b4a8" : "#d2cdc2"; context.fillRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height); }
            if (selectionRef.current.has(itemSelectionKey(region.id, media.id))) { context.strokeStyle = "#688600"; context.lineWidth = 5 / currentCamera.zoom; context.strokeRect(-rect.width / 2, -rect.height / 2, rect.width, rect.height); }
            context.restore();
          }
          context.restore();
        };
        drawMedia("mid", weights.mid);
        drawMedia("near", weights.near);
        if (weights.far < .72) {
          context.fillStyle = ink; context.font = `700 ${clamp(48 / currentCamera.zoom, 42, 180)}px 'Caveat', Georgia, serif`; context.textAlign = "left"; context.textBaseline = "bottom";
          context.fillText(region.name, region.bounds.x + 30 / currentCamera.zoom, region.bounds.y - 12 / currentCamera.zoom);
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
      if (weights.far > .998) {
        for (const cached of imageCacheRef.current.values()) URL.revokeObjectURL(cached.objectUrl);
        imageCacheRef.current.clear();
      } else {
        for (const [path, cached] of imageCacheRef.current) if (!desiredPaths.has(path) && now - cached.lastUsed > 1200) { URL.revokeObjectURL(cached.objectUrl); imageCacheRef.current.delete(path); }
      }
      frameTimesRef.current.push(now);
      while (frameTimesRef.current.length && frameTimesRef.current[0] < now - 1000) frameTimesRef.current.shift();
      if (now - lastStats > 400) {
        setFps(frameTimesRef.current.length);
        setResidentMedia(imageCacheRef.current.size);
        lastStats = now;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [loadImage, open]);

  useEffect(() => () => {
    for (const cached of imageCacheRef.current.values()) URL.revokeObjectURL(cached.objectUrl);
    imageCacheRef.current.clear();
  }, []);

  const metricWeights = lodWeights(camera.zoom);
  const detailLevel = metricWeights.far >= metricWeights.mid && metricWeights.far >= metricWeights.near ? "FAR" : metricWeights.near > metricWeights.mid ? "NEAR" : "MID";

  return (
    <div ref={containerRef} tabIndex={-1} role="dialog" aria-label="Neural Board World" aria-hidden={!open} style={{ position: "fixed", inset: 0, zIndex: 5000, background: paper, opacity: open ? 1 : 0, visibility: open ? "visible" : "hidden", pointerEvents: open ? "auto" : "none", transition: `opacity 280ms ease, visibility 0s linear ${open ? 0 : 280}ms`, fontFamily: "monospace", outline: "none" }}>
      <style>{`@media (max-width: 720px) { .nb-world-title, .nb-world-metrics { display: none !important; } .nb-world-toolbar { flex-wrap: wrap; max-width: calc(100vw - 32px); } }`}</style>
      <canvas ref={canvasRef} aria-label="Neural Board World canvas" onContextMenu={(event) => event.preventDefault()} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={(event) => void openRegion(event)} style={{ width: "100%", height: "100%", display: "block", cursor: spaceDown ? "grab" : mode === "create" ? "crosshair" : "default", touchAction: "none" }} />
      <header style={{ position: "absolute", top: 16, left: 16, right: 16, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        <div className="nb-world-toolbar" style={{ pointerEvents: "auto", display: "flex", gap: 7, alignItems: "center", padding: "8px 10px", background: "rgba(255,253,245,.94)", border: `2px solid ${ink}`, boxShadow: `3px 3px 0 ${ink}` }}>
          <strong className="nb-world-title" style={{ font: "700 24px 'Caveat', Georgia, serif", marginRight: 5 }}>Neural Board World</strong>
          <button type="button" onClick={() => setMode("select")} style={button(mode === "select")}>↖ Select</button>
          <button type="button" onClick={() => setMode("create")} style={button(mode === "create")}>▭ Draw region</button>
          <button type="button" onClick={() => { const canvas = canvasRef.current; const current = worldRef.current; if (!canvas || !current) return; const next = fitCamera(worldBounds(current.regions), canvas.clientWidth, canvas.clientHeight); cameraRef.current = next; setCamera(next); }} style={button(false)}>Fit world</button>
          {!hasDirectory && <button type="button" onClick={() => void load(true)} disabled={busy} style={{ ...button(false), background: accent }}>Choose folder</button>}
          <button type="button" onClick={onClose} style={button(false)}>{hasActiveRegion ? "Return to region" : "Close world"}</button>
        </div>
        <div className="nb-world-metrics" style={{ marginLeft: "auto", pointerEvents: "auto", padding: "7px 10px", background: "rgba(40,37,31,.9)", color: "#fffdf5", fontSize: 10, lineHeight: 1.45 }}>
          {detailLevel} · {fps} fps · {residentMedia} media resident{firstPaintMs != null ? ` · first paint ${Math.round(firstPaintMs)}ms` : ""}
        </div>
      </header>
      <div role="status" style={{ position: "absolute", left: 16, bottom: 16, maxWidth: "min(720px,calc(100vw - 32px))", padding: "8px 11px", background: "rgba(255,253,245,.94)", border: `1.5px solid ${ink}`, color: ink, fontSize: 11, boxShadow: `2px 2px 0 ${ink}` }}>
        {busy ? "Working… " : ""}{message} · Shift-click adds/removes · Escape clears · double-click opens
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
