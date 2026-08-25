import test from "node:test";
import assert from "node:assert/strict";
import {
  AutoBuildImageSearchError,
  describeImageSkip,
  describeImageSuccess,
  requestAutoBuildImage,
} from "./auto-build-images.ts";

globalThis.window ??= globalThis;

const image = {
  dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
  sourceUrl: "https://example.com/image.jpg",
  width: 1200,
  height: 800,
  source: "bing",
};

test("reports cooldown fallback sources returned by the bridge", async () => {
  const fetchImpl = async () => Response.json({
    ok: true,
    images: [image],
    failures: [{ source: "google", code: "cooldown", message: "Google cooldown active" }],
  });
  const result = await requestAutoBuildImage({
    query: "moon landing",
    signal: new AbortController().signal,
    fetchImpl,
    retryDelayMs: 1,
  });
  assert.equal(describeImageSuccess(7, result), "Slot 7: Google cooldown, used Bing");
});

test("collapses repeated bot-check retries into one readable source reason", () => {
  assert.equal(describeImageSuccess(1, {
    image,
    attempt: 1,
    failures: [
      { source: "google", code: "blocked", message: "blocked once" },
      { source: "google", code: "blocked", message: "blocked twice" },
      { source: "google", code: "blocked", message: "blocked three times" },
    ],
  }), "Slot 1: Google bot-check, used Bing");
});

test("retries one failed slot once before succeeding", async () => {
  let calls = 0;
  const attempts = [];
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ error: "Image finder bridge timed out", code: "timeout" }, { status: 504 })
      : Response.json({ ok: true, images: [image], failures: [] });
  };
  const result = await requestAutoBuildImage({
    query: "mission control",
    signal: new AbortController().signal,
    fetchImpl,
    retryDelayMs: 1,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.attempt, 2);
  assert.equal(describeImageSuccess(3, result), "Slot 3: used Bing on retry");
});

test("reports a final timeout as skipped after two attempts", () => {
  const error = new AutoBuildImageSearchError("Image finder timed out", "timeout");
  assert.equal(describeImageSkip(9, error), "Slot 9: timed out after 2 attempts, skipped");
});
