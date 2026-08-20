import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExportEncodingCandidates,
  exportFallbackMessage,
  exportOutputDimensions,
  forceEven,
} from "./export-encoding.ts";

test("export dimensions are standard output sizes, portrait-aware, and even", () => {
  assert.deepEqual(exportOutputDimensions("1080p", "16:9"), { width: 1920, height: 1080 });
  assert.deepEqual(exportOutputDimensions("1440p", "9:16"), { width: 1440, height: 2560 });
  assert.equal(forceEven(1919), 1918);
});

test("encoder ladder tries hardware, software, profile, fps, resolution, then VP9", () => {
  const candidates = buildExportEncodingCandidates({ quality: "1080p", aspect: "16:9", fps: 60 });
  assert.equal(candidates[0].videoConfig.codec, "avc1.64002a");
  assert.equal(candidates[0].videoConfig.hardwareAcceleration, "prefer-hardware");
  assert.equal(candidates[1].videoConfig.hardwareAcceleration, "prefer-software");
  assert.equal(candidates[2].videoConfig.codec, "avc1.4d002a");
  assert.ok(candidates.find((candidate) => candidate.container === "mp4" && candidate.fps === 30));
  assert.ok(candidates.find((candidate) => candidate.container === "mp4" && candidate.quality === "720p"));
  assert.equal(candidates.at(-1)?.container, "webm");
  assert.match(exportFallbackMessage(candidates[0], candidates[1]) ?? "", /Encoder fallback/);
});
