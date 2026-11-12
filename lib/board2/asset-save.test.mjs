import test from "node:test";
import assert from "node:assert/strict";
import { AssetSaveError, assetSaveStatus, errorDetails, errorMessage, isStorageDuplicate, isUniqueViolation } from "./asset-save-errors.ts";
import { ASSET_UPLOAD_MAX_BYTES, createTaskQueue, imageForAssetUpload } from "./asset-autosave.ts";

test("a plain-object Postgres error keeps its message, code, details and hint for the log", () => {
  const postgrest = { message: 'duplicate key value violates unique constraint "nb_assets_image_unique"', code: "23505", details: "Key (email, url)=(…) already exists.", hint: null };
  assert.equal(errorMessage(postgrest), postgrest.message);
  assert.deepEqual(errorDetails(postgrest), { message: postgrest.message, code: "23505", details: postgrest.details });
  assert.ok(isUniqueViolation(postgrest));
  assert.equal(assetSaveStatus(postgrest), 500);
});

test("upstream and input failures carry their own status and cause", () => {
  const cause = new TypeError("fetch failed");
  const error = new AssetSaveError(502, "Could not download image (fetch failed)", { cause });
  assert.equal(assetSaveStatus(error), 502);
  assert.equal(errorDetails(error).cause.message, "fetch failed");
  assert.equal(errorDetails(error).name, "AssetSaveError");
});

test("Storage 409 / already-exists is recognised as a duplicate upload", () => {
  assert.ok(isStorageDuplicate({ statusCode: "409", message: "Duplicate" }));
  assert.ok(isStorageDuplicate({ message: "The resource already exists" }));
  assert.ok(!isStorageDuplicate({ statusCode: "413", message: "Payload too large" }));
});

test("the save queue never runs more than its limit at once and runs everything", async () => {
  const enqueue = createTaskQueue(2);
  let running = 0;
  let peak = 0;
  const results = await Promise.all(Array.from({ length: 9 }, (_, index) => enqueue(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    if (index === 4) throw new Error("one failure");
    return index;
  }).catch((error) => error.message)));
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3, "one failure", 5, 6, 7, 8]);
});

test("small images upload as-is; oversized ones are shrunk under the body limit or skipped", async () => {
  const small = new Blob([new Uint8Array(1000)], { type: "image/png" });
  assert.equal(await imageForAssetUpload(small, { reencode: () => assert.fail("should not re-encode") }), small);

  const big = new Blob([new Uint8Array(ASSET_UPLOAD_MAX_BYTES + 1)], { type: "image/png" });
  const edges = [];
  const shrunk = await imageForAssetUpload(big, { reencode: async (_blob, edge) => { edges.push(edge); return new Blob([new Uint8Array(500_000)], { type: "image/webp" }); } });
  assert.equal(shrunk.size, 500_000);
  assert.deepEqual(edges, [1800]);

  const stubborn = await imageForAssetUpload(big, { reencode: async () => new Blob([new Uint8Array(ASSET_UPLOAD_MAX_BYTES + 5)]) });
  assert.equal(stubborn, null, "never send a request that is certain to 413");
  assert.equal(await imageForAssetUpload(big, { reencode: async () => { throw new Error("decode failed"); } }), null);
});
