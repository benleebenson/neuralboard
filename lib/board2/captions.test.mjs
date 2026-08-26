import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAPTION_FADE_SECONDS,
  buildPhraseCaptionTrack,
  captionLayout,
  captionOpacityAt,
  drawScreenSpaceCaption,
  isCaptionTrack,
} from "./captions.ts";

test("splits Whisper segments into timestamped 3-7 word phrases at punctuation", () => {
  const track = buildPhraseCaptionTrack([
    { start: 1, end: 7, text: "First we set the scene, then reveal the surprising final answer." },
  ], 2);
  assert.deepEqual(track.map((cue) => cue.text), [
    "First we set the scene,",
    "then reveal the surprising final answer.",
  ]);
  assert.deepEqual(track.map((cue) => cue.text.split(/\s+/).length), [5, 6]);
  assert.equal(track[0].start, 3);
  assert.equal(track.at(-1).end, 9);
});

test("preserves pauses between Whisper segments and avoids a short trailing fragment", () => {
  const track = buildPhraseCaptionTrack([
    { start: 0, end: 4, text: "one two three four five six seven eight nine" },
    { start: 5, end: 6, text: "brief pause" },
  ]);
  assert.deepEqual(track.slice(0, 2).map((cue) => cue.text.split(/\s+/).length), [5, 4]);
  assert.ok(track[1].end <= 4);
  assert.equal(track[2].start, 5);
  assert.equal(track[2].text, "brief pause");
  assert.ok(isCaptionTrack(track));
});

test("fades phrases over 150ms and leaves gaps transparent", () => {
  const cue = { text: "hello there", start: 1, end: 2 };
  assert.equal(CAPTION_FADE_SECONDS, 0.15);
  assert.equal(captionOpacityAt(cue, 0.9), 0);
  assert.ok(Math.abs(captionOpacityAt(cue, 1.075) - 0.5) < 1e-9);
  assert.equal(captionOpacityAt(cue, 1.5), 1);
  assert.ok(Math.abs(captionOpacityAt(cue, 1.925) - 0.5) < 1e-9);
  assert.equal(captionOpacityAt(cue, 2), 0);
});

test("uses aspect-aware safe-area anchors and medium 44px type at 1080 short edge", () => {
  const landscape = captionLayout(1920, 1080, "medium", "lower");
  const portrait = captionLayout(1080, 1920, "medium", "lower");
  assert.equal(landscape.fontSizePx, 44);
  assert.equal(landscape.centerY, 1080 * 0.91);
  assert.equal(landscape.maxWidth, 1920 * 0.78);
  assert.equal(landscape.lineHeight, 44 * 1.16);
  assert.equal(portrait.fontSizePx, 44);
  assert.equal(portrait.centerY, 1920 * 0.88);
  assert.equal(portrait.maxWidth, 1080 * 0.84);
  assert.equal(captionLayout(1920, 1080, "medium", "upper").centerY, 97.2);
  assert.equal(captionLayout(1080, 1920, "medium", "upper").centerY, 230.39999999999998);
});

test("draws plain white outlined sans-serif text at the fixed frame anchor", () => {
  const calls = [];
  const context = {
    save() {},
    restore() {},
    measureText(text) { return { width: text.length * 20 }; },
    strokeText(text, x, y, maxWidth) { calls.push({ kind: "stroke", text, x, y, maxWidth }); },
    fillText(text, x, y, maxWidth) { calls.push({ kind: "fill", text, x, y, maxWidth }); },
  };
  drawScreenSpaceCaption(
    context,
    1.5,
    [{ text: "A readable caption phrase", start: 1, end: 2 }],
    1920,
    1080,
    "medium",
    "lower",
  );
  assert.match(context.font, /Arial, Helvetica, sans-serif/);
  assert.equal(context.fillStyle, "#ffffff");
  assert.equal(context.strokeStyle, "rgba(0, 0, 0, 0.72)");
  assert.deepEqual(calls.map((call) => call.kind), ["stroke", "fill"]);
  assert.equal(calls[0].x, 960);
  assert.equal(calls[0].y, 1080 * 0.91);
});

test("board2 keeps captions in the shared screen-space preview/export renderer and recipe", () => {
  const source = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
  const renderer = source.slice(source.indexOf("const renderToCtx"), source.indexOf("const drawFrame ="));
  assert.match(renderer, /ctx\.restore\(\);[\s\S]*drawScreenSpaceCaption\(/);
  assert.match(renderer, /captionTrackSourceRef\.current === narrationVisemeSourceSignature\(currentClips\)/);
  assert.match(source, /renderToCtx\(exportCtx, elapsed,[\s\S]*"realtime-export"\)/);
  assert.match(source, /renderToCtx\(exportCtx, frameTime,[\s\S]*"export"\)/);
  assert.match(source, /captions: \{[\s\S]*trackFingerprint: captionTrackSourceRef\.current,[\s\S]*source: "autoDerived"/);
  assert.match(source, /data-caption-enabled-toggle/);
});
