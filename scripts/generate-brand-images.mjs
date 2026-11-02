// Regenerates the brand images derived from public/logo.svg (the Neural Board node mark):
//   public/favicon.svg — the mark cropped to a square around its nodes, for SVG favicons
//   public/og-image.png — 1200×630 share image: the mark and "Neural Board" on parchment
// Run with: node scripts/generate-brand-images.mjs
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const logo = readFileSync(new URL("../public/logo.svg", import.meta.url), "utf8");
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Bounds of the circles (cx ± r, cy ± r), padded and squared, so small favicons aren't mostly empty.
const circles = [...logo.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(([, cx, cy, r]) => [Number(cx), Number(cy), Number(r)]);
const minX = Math.min(...circles.map(([cx, , r]) => cx - r)), maxX = Math.max(...circles.map(([cx, , r]) => cx + r));
const minY = Math.min(...circles.map(([, cy, r]) => cy - r)), maxY = Math.max(...circles.map(([, cy, r]) => cy + r));
const side = Math.max(maxX - minX, maxY - minY) * 1.06;
const viewBox = [(minX + maxX) / 2 - side / 2, (minY + maxY) / 2 - side / 2, side, side].map((value) => value.toFixed(1)).join(" ");
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner.replace(/\s*<rect[^>]*fill="none"\/>/, "")}</svg>\n`;
writeFileSync(new URL("../public/favicon.svg", import.meta.url), favicon);

const BACKGROUND = "#f7e5c1";
const INK = "#2a2a2a";
const markSize = 330;
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BACKGROUND}"/>
  <svg x="${(1200 - markSize) / 2}" y="70" width="${markSize}" height="${markSize}" viewBox="${viewBox}">${inner}</svg>
  <text x="600" y="520" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="84" font-weight="700" fill="${INK}" letter-spacing="-1">Neural Board</text>
</svg>`;
await sharp(Buffer.from(og)).png().toFile(new URL("../public/og-image.png", import.meta.url).pathname);
console.log("wrote public/favicon.svg and public/og-image.png", { viewBox });
