import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSourceKey, imageContentFingerprint, planMediaReferences } from "./auto-build-media.ts";

test("repeated visual subjects retain timeline appearances but resolve to one media", () => {
  const refs = planMediaReferences([
    { query: "Ada Lovelace historical portrait photograph", characterName: "Ada Lovelace" },
    { query: "Babbage mechanical difference engine photograph" },
    { query: "Ada Lovelace historical portrait photograph", characterName: "Ada Lovelace", characterCallback: true },
    { query: "portrait of Ada Lovelace historical photograph", characterName: "Ada Lovelace", characterCallback: true },
    { query: "Ada Lovelace surprised reaction portrait", characterName: "Ada Lovelace", reactionShot: true },
  ]);
  assert.deepEqual(refs, [0, 1, 0, 0, 2]);
  assert.equal(new Set(refs).size, 3);
  assert.equal(canonicalSourceKey("https://example.com/a.jpg?utm_source=search&w=500"), "https://example.com/a.jpg");
});

test("identical image bytes resolve to the same fingerprint across source URLs", async () => {
  const left = new Blob(["same image"]);
  const right = new Blob(["same image"]);
  assert.equal(await imageContentFingerprint(left), await imageContentFingerprint(right));
});
