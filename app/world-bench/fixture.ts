import { zipSync } from "fflate";

export type FixtureOptions = { regionIndex: number; mediaCount: number; videos: number };

/** Deterministic PRNG so the same region index always produces the same bytes (that is what lets re-import dedupe). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 1600×1200 JPEG of layered gradients, shapes and grain, so it compresses like a photo rather than a flat fill. */
async function fixtureImage(seed: number): Promise<Uint8Array> {
  const random = mulberry32(seed);
  const canvas = new OffscreenCanvas(1600, 1200);
  const context = canvas.getContext("2d")!;
  const gradient = context.createLinearGradient(0, 0, 1600 * random(), 1200);
  gradient.addColorStop(0, `hsl(${Math.floor(random() * 360)} 60% 55%)`);
  gradient.addColorStop(1, `hsl(${Math.floor(random() * 360)} 55% 35%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1600, 1200);
  for (let index = 0; index < 260; index += 1) {
    context.fillStyle = `hsla(${Math.floor(random() * 360)} 65% ${30 + random() * 45}% / ${0.15 + random() * 0.5})`;
    context.beginPath();
    context.ellipse(random() * 1600, random() * 1200, 10 + random() * 130, 10 + random() * 130, random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }
  const grain = context.getImageData(0, 0, 1600, 1200);
  for (let offset = 0; offset < grain.data.length; offset += 4) {
    const noise = (random() - 0.5) * 34;
    grain.data[offset] += noise; grain.data[offset + 1] += noise; grain.data[offset + 2] += noise;
  }
  context.putImageData(grain, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildFixtureBoard({ regionIndex, mediaCount, videos }: FixtureOptions): Promise<File> {
  const files: Record<string, Uint8Array> = {};
  const media: Record<string, unknown>[] = [];
  for (let index = 0; index < mediaCount; index += 1) {
    const isVideo = index >= mediaCount - videos;
    const assetFile = `assets/${isVideo ? `clip_${index}.mp4` : `img_${index}.jpg`}`;
    // Unique junk bytes for the "video": the world must not try to decode it at any zoom.
    files[assetFile] = isVideo ? new Uint8Array(2048).map((_, byte) => (byte * 31 + regionIndex * 7 + index) & 255) : await fixtureImage(regionIndex * 1000 + index + 1);
    media.push({
      id: `clip_${regionIndex}_${index}`,
      type: isVideo ? "video" : "image",
      assetFile,
      boardX: (index % 8) * 440 + 60,
      boardY: Math.floor(index / 8) * 520 + 80,
      boardW: 380,
      boardH: 300,
    });
  }
  const now = "2026-01-01T00:00:00.000Z";
  const manifest = {
    schemaVersion: 6,
    meta: { id: `fixture_${regionIndex}`, projectId: `fixture_${regionIndex}`, title: `Fixture ${regionIndex + 1}`, aspectRatio: "16:9", duration: 30, createdAt: now, modifiedAt: now },
    board: { media, dimensions: { width: 4000, height: 3000 }, pxPerSec: 20, boardZoom: 1, boardPan: { x: 0, y: 0 } },
    timeline: { blocks: [], customZoomDurationSeconds: 3 },
    annotations: Array.from({ length: 6 }, (_, index) => ({ id: `ann_${regionIndex}_${index}`, type: "text", boardX: index * 500 + 100, boardY: 30, boardW: 300, boardH: 60, color: "#222", text: `Note ${index + 1}` })),
    camera: { mode: "clips", keyframes: Array.from({ length: 4 }, (_, index) => ({ time: index * 3, x: 400 + index * 900, y: 500, zoom: 1.2, beatId: `beat_${index}` })) },
  };
  files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = zipSync(files, { level: 0 });
  return new File([bytes.slice().buffer], `fixture-${regionIndex + 1}.nbp`, { type: "application/zip" });
}
