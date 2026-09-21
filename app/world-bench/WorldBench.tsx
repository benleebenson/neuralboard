"use client";

/*
 * Dev harness for measuring the world view on a synthetic fixture. Not available in production builds.
 *
 *   1. `npm run dev`, open /world-bench (setup mode). The world lives in the browser's private file
 *      system (OPFS), so nothing touches the real boards folder.
 *   2. In the console:  await __bench.reset();  await __bench.generate({ regions: 40, media: 40, videos: 4 });
 *      (each region is a real .nbp imported through the same code path as the Library's Import action)
 *      then  await __bench.disk()  for on-disk bytes per folder.
 *   3. Open /world-bench?view=1 and, once the world has drawn:
 *        __bench.snapshot()                        // first-paint ms, resident media, far blobs
 *        await __bench.measure({ zoom: 0.03 })     // FAR
 *        await __bench.measure({ zoom: 0.2 })      // MID
 *        await __bench.measure({ zoom: 0.8 })      // NEAR
 *      Each run pans for 5 s and returns fps, frame-time percentiles, draw ms, resident media, heap.
 *      Run on a real display with the tab focused: background tabs throttle requestAnimationFrame.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { collectWorldGarbage, loadOrCreateWorld } from "@/lib/world/world-store";
import { importBoardAsRegion } from "@/lib/world/region-import";
import { WorldView, type WorldViewControl } from "@/app/board2/world/WorldView";
import { buildFixtureBoard } from "./fixture";

const BENCH_DIRECTORY = "world-bench-boards";

type Entries = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };

async function benchDirectory(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(BENCH_DIRECTORY, { create });
}

async function sizeOf(directory: FileSystemDirectoryHandle): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for await (const [, handle] of (directory as Entries).entries()) {
    if (handle.kind === "file") { bytes += (await (handle as FileSystemFileHandle).getFile()).size; files += 1; }
    else { const inner = await sizeOf(handle as FileSystemDirectoryHandle); bytes += inner.bytes; files += inner.files; }
  }
  return { bytes, files };
}

export type BenchApi = {
  reset: () => Promise<void>;
  generate: (options: { regions: number; media: number; videos: number }) => Promise<{ importMs: number; imported: number; assetsWritten: number; assetsReused: number; bytesWritten: number; bytesReused: number }>;
  disk: () => Promise<Record<string, { bytes: number; files: number }>>;
  gc: (graceMs?: number) => Promise<{ removedFiles: number; removedBytes: number; keptYoung: number }>;
  regionIds: () => Promise<string[]>;
  readText: (path: string) => Promise<string>;
  /** View mode only (`?view=1`). Pans across the world at a fixed zoom for `seconds` and reports frame timing and memory. */
  measure: (options: { zoom: number; seconds?: number }) => Promise<MeasureResult>;
  /** View mode only. Current metrics without moving the camera (resident media, blobs, first paint). */
  snapshot: () => ReturnType<WorldViewControl["metrics"]> | null;
};

export type MeasureResult = {
  zoom: number; seconds: number; frames: number; avgFps: number; p50FrameMs: number; p95FrameMs: number; worstFrameMs: number;
  avgDrawMs: number; residentMedia: number; loadingMedia: number; liveObjectUrls: number; farBlobs: number;
  regions: number; mediaTotal: number; firstPaintMs: number | null; jsHeapMB: number | null;
};

declare global { interface Window { __bench?: BenchApi } }

export function WorldBench() {
  const control = useRef<WorldViewControl | null>(null);
  const view = useSyncExternalStore(() => () => undefined, () => new URLSearchParams(window.location.search).get("view") === "1", () => null);
  useEffect(() => {
    window.__bench = {
      async reset() { const root = await navigator.storage.getDirectory(); await root.removeEntry(BENCH_DIRECTORY, { recursive: true }).catch(() => undefined); },
      async generate({ regions, media, videos }) {
        const directory = await benchDirectory();
        await loadOrCreateWorld(directory);
        const totals = { importMs: 0, imported: 0, assetsWritten: 0, assetsReused: 0, bytesWritten: 0, bytesReused: 0 };
        const started = performance.now();
        for (let index = 0; index < regions; index += 1) {
          const file = await buildFixtureBoard({ regionIndex: index, mediaCount: media, videos });
          const { stats } = await importBoardAsRegion(directory, file);
          totals.imported += 1;
          totals.assetsWritten += stats.assetsWritten; totals.assetsReused += stats.assetsReused;
          totals.bytesWritten += stats.bytesWritten; totals.bytesReused += stats.bytesReused;
        }
        totals.importMs = performance.now() - started;
        return totals;
      },
      async disk() {
        const directory = await benchDirectory();
        const result: Record<string, { bytes: number; files: number }> = { index: { bytes: 0, files: 0 } };
        for await (const [, handle] of (directory as Entries).entries()) {
          if (handle.kind === "file") { result.index.bytes += (await (handle as FileSystemFileHandle).getFile()).size; result.index.files += 1; continue; }
          for await (const [inner, innerHandle] of (handle as Entries).entries()) if (innerHandle.kind === "directory") result[inner] = await sizeOf(innerHandle as FileSystemDirectoryHandle);
        }
        return result;
      },
      async gc(graceMs) { return collectWorldGarbage(await benchDirectory(), { graceMs }); },
      async regionIds() {
        const world = await loadOrCreateWorld(await benchDirectory());
        return world.regions.map((region) => region.id);
      },
      async measure({ zoom, seconds = 5 }) {
        const handle = control.current;
        if (!handle) throw new Error("Open /world-bench?view=1 first: the camera is only scriptable in view mode.");
        const fit = handle.fitWorld();
        if (!fit) throw new Error("The world has not loaded yet.");
        // Settle: let previews for the starting view begin loading so the run measures steady-state panning.
        handle.setCamera({ x: fit.x, y: fit.y, zoom });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const viewportWidth = window.innerWidth / zoom;
        const viewportHeight = window.innerHeight / zoom;
        const times: number[] = [];
        const drawSamples: number[] = [];
        const started = performance.now();
        await new Promise<void>((resolve) => {
          const tick = (now: number) => {
            times.push(now);
            const elapsed = (now - started) / 1000;
            if (elapsed >= seconds) { resolve(); return; }
            // Two viewport-widths of horizontal sweep and one of vertical drift per cycle: enough to keep new regions entering view.
            handle.setCamera({ x: fit.x + Math.sin(elapsed * Math.PI * 0.8) * viewportWidth * 1.2, y: fit.y + Math.sin(elapsed * Math.PI * 0.5) * viewportHeight * 0.6, zoom });
            if (times.length % 10 === 0) drawSamples.push(handle.metrics().drawMs);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const deltas = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
        const at = (fraction: number) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * fraction))] ?? 0;
        const metrics = handle.metrics();
        const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
        const totalMs = times[times.length - 1] - times[0];
        return {
          zoom, seconds, frames: times.length, avgFps: totalMs > 0 ? (times.length - 1) / (totalMs / 1000) : 0,
          p50FrameMs: at(0.5), p95FrameMs: at(0.95), worstFrameMs: deltas.at(-1) ?? 0,
          avgDrawMs: drawSamples.length ? drawSamples.reduce((sum, value) => sum + value, 0) / drawSamples.length : 0,
          residentMedia: metrics.resident, loadingMedia: metrics.loading, liveObjectUrls: metrics.liveUrls, farBlobs: metrics.blobs,
          regions: metrics.regions, mediaTotal: metrics.media, firstPaintMs: metrics.firstPaintMs, jsHeapMB: heap ? heap / 1e6 : null,
        };
      },
      snapshot() { return control.current?.metrics() ?? null; },
      async readText(path) {
        let current: FileSystemDirectoryHandle = await benchDirectory();
        const parts = path.split("/");
        const name = parts.pop()!;
        for (const part of parts) current = await current.getDirectoryHandle(part);
        return (await (await current.getFileHandle(name)).getFile()).text();
      },
    };
    return () => { delete window.__bench; };
  }, []);
  if (!view) return <main style={{ font: "13px monospace", padding: 24 }}>World bench {view === null ? "" : "— setup mode (drive window.__bench)"}</main>;
  return <WorldView open onClose={() => undefined} onOpenRegion={async () => false} getDirectory={() => benchDirectory()} controlRef={control} />;
}
