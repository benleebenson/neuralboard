import test from "node:test";
import assert from "node:assert/strict";
import { dragCarriesFiles, isNarrationFile, narrationDragVerdict } from "./narration-drop.ts";

test("narration files match the Upload narration input", () => {
  for (const type of ["audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/flac", "video/mp4", "video/quicktime", "video/webm"]) {
    assert.equal(isNarrationFile({ type, name: "clip" }), true, type);
  }
  for (const name of ["a.mp3", "a.WAV", "a.m4a", "a.aac", "a.ogg", "a.flac", "a.mp4", "a.mov", "a.webm"]) {
    assert.equal(isNarrationFile({ type: "", name }), true, name);
  }
  assert.equal(isNarrationFile({ type: "image/png", name: "a.png" }), false);
  assert.equal(isNarrationFile({ type: "application/pdf", name: "a.pdf" }), false);
  assert.equal(isNarrationFile({ type: "video/x-matroska", name: "a.mkv" }), false);
});

test("drag verdict rejects only files known to be non-narration", () => {
  assert.equal(narrationDragVerdict({ items: [{ kind: "file", type: "audio/mpeg" }] }), "accept");
  assert.equal(narrationDragVerdict({ items: [{ kind: "file", type: "" }] }), "accept");
  assert.equal(narrationDragVerdict({ items: [{ kind: "file", type: "image/png" }] }), "reject");
  assert.equal(narrationDragVerdict({ items: [{ kind: "file", type: "image/png" }, { kind: "file", type: "audio/wav" }] }), "accept");
});

test("only OS file drags count", () => {
  assert.equal(dragCarriesFiles({ types: ["Files"] }), true);
  assert.equal(dragCarriesFiles({ types: ["mediaitemid"] }), false);
  assert.equal(dragCarriesFiles({ types: ["text/uri-list", "text/html"] }), false);
});
