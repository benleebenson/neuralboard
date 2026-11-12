import test from "node:test";
import assert from "node:assert/strict";
import { brokenExportMediaMessage, collectExportMedia, findBrokenExportMedia, probeMediaUrl } from "./export-preflight.ts";

test("collects every media URL the export loads, deduplicated, with the names that use it", () => {
  const { refs, missing } = collectExportMedia([
    { type: "image", name: "cat.jpg", sourceUrl: "blob:x/1" },
    { type: "image", name: "cat copy", sourceUrl: "blob:x/1" },
    { type: "video", name: "clip.mp4", sourceUrl: "https://cdn/v.mp4" },
    { type: "narration", name: "voice", sourceUrl: "blob:x/2", audioBlob: new Blob(["a"]) },
    { type: "narration", name: "remote voice", sourceUrl: "https://cdn/n.mp3" },
    { type: "flash", name: "boom", flashImageUrl: "/flash/images/a.png", flashSoundUrl: "/flash/sounds/b.mp3" },
    { type: "cutto", name: "cut", cutToMedia: "image", sourceUrl: "blob:x/3" },
    { type: "cutto", name: "cut to narration video", cutToMedia: "video", cutToSourceClipId: "v1" },
    { type: "pan", name: "pan" },
    { type: "video", name: "youtube (needs redownload)", sourceUrl: "" },
  ], [{ name: "character face", url: "blob:x/4", kind: "image" }]);
  assert.deepEqual(refs.map((ref) => [ref.url, ref.kind, ref.names]), [
    ["blob:x/1", "image", ["cat.jpg", "cat copy"]],
    ["https://cdn/v.mp4", "video", ["clip.mp4"]],
    ["https://cdn/n.mp3", "audio", ["remote voice"]],
    ["/flash/images/a.png", "image", ["boom"]],
    ["/flash/sounds/b.mp3", "sound", ["boom"]],
    ["blob:x/3", "image", ["cut"]],
    ["blob:x/4", "image", ["character face"]],
  ]);
  assert.deepEqual(missing.map((item) => item.names[0]), ["youtube (needs redownload)"]);
});

function fakeFetch(table) {
  const requested = [];
  const fetch = async (url, init) => {
    requested.push(url);
    const entry = table[url];
    if (entry === "reject") throw new TypeError("Failed to fetch");
    if (entry === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    let cancelled = false;
    return { ok: entry >= 200 && entry < 300, status: entry, body: { cancel: async () => { cancelled = true; } }, get cancelled() { return cancelled; } };
  };
  return { fetch, requested };
}

test("a revoked blob URL, a 404 and a hung request are reported; good and data: URLs pass", async () => {
  const { fetch, requested } = fakeFetch({ "blob:ok": 200, "blob:gone": "reject", "https://a/404": 404, "https://a/slow": "hang" });
  assert.equal(await probeMediaUrl("blob:ok", { fetch }), null);
  assert.match(await probeMediaUrl("blob:gone", { fetch }), /no longer available/);
  assert.match(await probeMediaUrl("https://a/404", { fetch }), /404/);
  assert.match(await probeMediaUrl("https://a/slow", { fetch, timeoutMs: 10 }), /no response/);
  assert.equal(await probeMediaUrl("data:image/png;base64,AAAA", { fetch }), null);
  assert.ok(!requested.includes("data:image/png;base64,AAAA"));
});

test("broken items come back by name in timeline order, with bounded concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const refs = Array.from({ length: 10 }, (_, index) => ({ url: `u${index}`, kind: "image", names: [`item ${index}`] }));
  const broken = await findBrokenExportMedia(refs, async (url) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, url === "u7" ? 1 : 5));
    inFlight--;
    return url === "u2" || url === "u7" ? "gone" : null;
  }, { concurrency: 3 });
  assert.ok(peak <= 3);
  assert.deepEqual(broken.map((item) => item.names[0]), ["item 2", "item 7"]);
});

test("the message names each broken item and says no file was created", () => {
  const message = brokenExportMediaMessage([
    { names: ["cat.jpg", "cat copy"], kind: "image", url: "blob:1", reason: "its local file is no longer available in this browser session" },
    { names: ["clip.mp4"], kind: "video", url: "https://x", reason: "file not found (404)" },
  ]);
  assert.match(message, /^2 media items can't be loaded, so the export was not started and no file was created/);
  assert.match(message, /“cat\.jpg”, “cat copy” \(image\)/);
  assert.match(message, /“clip\.mp4” \(video\): file not found \(404\)/);
});
