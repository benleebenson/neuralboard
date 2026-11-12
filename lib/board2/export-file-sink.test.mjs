import test from "node:test";
import assert from "node:assert/strict";
import { describeExportFailure, discardPartialExport } from "./export-file-sink.ts";

function fakeExportFile({ canRemove = true, removeFails = false, abortFails = false } = {}) {
  const calls = [];
  const writable = {
    async abort(reason) { calls.push(["abort", reason]); if (abortFails) throw new TypeError("stream errored"); },
    async close() { calls.push(["close"]); },
  };
  const fileHandle = { name: "board2-export.mp4" };
  if (canRemove) fileHandle.remove = async () => { calls.push(["remove"]); if (removeFails) throw new DOMException("gone", "NotFoundError"); };
  return { calls, writable, fileHandle };
}

// Mirrors the export's try/catch: an encode that throws mid-stream must never reach close().
async function runExport({ fileHandle, writable }, encode) {
  try {
    await encode(writable);
    await writable.close();
    return { ok: true };
  } catch (error) {
    const cleanup = await discardPartialExport(fileHandle, writable, error);
    return { ok: false, error, cleanup };
  }
}

test("a throw mid-encode aborts the stream instead of closing it, then deletes the picker-created file", async () => {
  const file = fakeExportFile();
  const failure = new Error("Could not load full-resolution image “cat.jpg”");
  const result = await runExport(file, async () => { throw failure; });
  assert.equal(result.ok, false);
  assert.equal(result.error, failure, "the original error is kept, not swallowed or replaced");
  assert.equal(result.cleanup, "removed");
  assert.deepEqual(file.calls, [["abort", failure], ["remove"]]);
  assert.ok(!file.calls.some(([name]) => name === "close"), "close() would commit a partial/empty file");
});

test("a successful encode closes the stream and never aborts or removes", async () => {
  const file = fakeExportFile();
  const result = await runExport(file, async () => {});
  assert.equal(result.ok, true);
  assert.deepEqual(file.calls, [["close"]]);
});

test("the file is still removed when abort itself rejects", async () => {
  const file = fakeExportFile({ abortFails: true });
  assert.equal(await discardPartialExport(file.fileHandle, file.writable), "removed");
  assert.deepEqual(file.calls.map(([name]) => name), ["abort", "remove"]);
});

test("a failure before the writable exists still removes the empty file the picker created", async () => {
  const file = fakeExportFile();
  assert.equal(await discardPartialExport(file.fileHandle, null), "removed");
  assert.deepEqual(file.calls, [["remove"]]);
});

test("without FileSystemHandle.remove, or when it fails, the empty file is reported as left behind", async () => {
  const noRemove = fakeExportFile({ canRemove: false });
  assert.equal(await discardPartialExport(noRemove.fileHandle, noRemove.writable), "left-empty");
  const failingRemove = fakeExportFile({ removeFails: true });
  assert.equal(await discardPartialExport(failingRemove.fileHandle, failingRemove.writable), "left-empty");
});

test("in-memory exports (no picker) have nothing to clean", async () => {
  assert.equal(await discardPartialExport(null, null), "nothing-to-clean");
});

test("only a dismissed save dialog is silent; an AbortError mid-encode is a real failure", () => {
  const abort = new DOMException("The user aborted a request.", "AbortError");
  assert.deepEqual(describeExportFailure(abort, { userCancelled: false, pickerDismissed: true, cleanup: "nothing-to-clean" }), { kind: "silent" });
  const midEncode = describeExportFailure(abort, { userCancelled: false, pickerDismissed: false, cleanup: "removed", fileName: "a.mp4" });
  assert.equal(midEncode.kind, "error");
  assert.match(midEncode.message, /The user aborted a request/);
});

test("failure messages carry the real error and say what happened to the file", () => {
  const removed = describeExportFailure(new Error("Video metadata could not be decoded"), { userCancelled: false, pickerDismissed: false, cleanup: "removed", fileName: "a.mp4" });
  assert.equal(removed.message, "Export failed: Video metadata could not be decoded. The unfinished file was deleted.");
  const leftEmpty = describeExportFailure(new Error("boom."), { userCancelled: false, pickerDismissed: false, cleanup: "left-empty", fileName: "a.mp4" });
  assert.match(leftEmpty.message, /^Export failed: boom\. An empty “a\.mp4” was left/);
  const cancelled = describeExportFailure(new DOMException("Export cancelled", "AbortError"), { userCancelled: true, pickerDismissed: false, cleanup: "removed" });
  assert.deepEqual(cancelled, { kind: "cancelled", message: "Export cancelled" });
});
