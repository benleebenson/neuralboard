import { readdir } from "node:fs/promises";
import path from "node:path";

// Flash-cut assets are whatever files sit in public/flash/images and public/flash/sounds.
// force-static: the listing is generated at build time in production (no runtime filesystem
// access on Vercel) and re-read on every request in `next dev`, so dropping a file into either
// folder makes it available without a code change.
export const dynamic = "force-static";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const SOUND_EXT = /\.(mp3|wav|ogg|m4a|aac|webm)$/i;

async function listFolder(folder: "images" | "sounds", pattern: RegExp) {
  const dir = path.join(process.cwd(), "public", "flash", folder);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => !name.startsWith(".") && pattern.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name: name.replace(/\.[^.]+$/, ""),
      url: `/flash/${folder}/${encodeURIComponent(name)}`,
    }));
}

export async function GET() {
  const [images, sounds] = await Promise.all([
    listFolder("images", IMAGE_EXT),
    listFolder("sounds", SOUND_EXT),
  ]);
  return Response.json({ images, sounds });
}
