import test from "node:test";
import assert from "node:assert/strict";
import {
  boardDropMayContainMedia,
  centeredBoardDropPosition,
  droppedImageUrl,
  extensionForImageType,
  firstUriListEntry,
  imageBlobFromTransferItem,
  imageSourceFromHtml,
  normalizeDroppedImageUrl,
  stringFromTransferItem,
} from "./image-drop.ts";

test("centers a decoded image at the board drop point", () => {
  assert.deepEqual(centeredBoardDropPosition({
    dropX: 1200,
    dropY: 700,
    imageWidth: 800,
    imageHeight: 450,
    boardWidth: 4000,
    boardHeight: 2200,
  }), { boardX: 800, boardY: 475 });
});

test("clamps an edge drop inside the current board dimensions", () => {
  assert.deepEqual(centeredBoardDropPosition({
    dropX: 3990,
    dropY: 2190,
    imageWidth: 800,
    imageHeight: 450,
    boardWidth: 4000,
    boardHeight: 2200,
  }), { boardX: 3200, boardY: 1750 });
});

test("recognizes files, promised file items, and browser string payloads", () => {
  assert.equal(boardDropMayContainMedia({ files: [new Blob([], { type: "image/png" })] }), true);
  assert.equal(boardDropMayContainMedia({ items: [{ kind: "file", type: "" }] }), true);
  assert.equal(boardDropMayContainMedia({ types: ["text/html"] }), true);
  assert.equal(boardDropMayContainMedia({ files: [new Blob([], { type: "application/pdf" })] }), false);
});

test("reads the standard getAsFile image payload", async () => {
  const image = new Blob(["png"], { type: "image/png" });
  const result = await imageBlobFromTransferItem({ kind: "file", type: "image/png", getAsFile: () => image });
  assert.equal(result?.blob, image);
  assert.equal(result?.declaredType, "image/png");
});

test("captures and awaits a promised image blob when files is empty", async () => {
  const image = new Blob(["png"], { type: "image/png" });
  let accessorCalled = false;
  const pending = imageBlobFromTransferItem({
    kind: "file",
    type: "",
    getAsFile: () => null,
    getAsBlob: () => {
      accessorCalled = true;
      return Promise.resolve(image);
    },
  });
  assert.equal(accessorCalled, true, "protected item accessor must be called synchronously");
  assert.equal((await pending)?.blob, image);
});

test("rejects a promised non-image blob", async () => {
  const pending = imageBlobFromTransferItem({
    kind: "file",
    type: "",
    getAsBlob: () => Promise.resolve(new Blob(["pdf"], { type: "application/pdf" })),
  });
  assert.equal(await pending, null);
});

test("reads asynchronous HTML strings from a transfer item", async () => {
  const pending = stringFromTransferItem({
    kind: "string",
    type: "text/html",
    getAsString: (resolve) => queueMicrotask(() => resolve('<img src="https://example.com/a.png">')),
  });
  assert.deepEqual(await pending, { type: "text/html", value: '<img src="https://example.com/a.png">' });
});

test("extracts an image src from browser drag HTML", () => {
  assert.equal(
    imageSourceFromHtml('<a href="https://example.com"><img alt="Preview" src="https://cdn.example.com/cat.png?a=1&amp;b=2"></a>'),
    "https://cdn.example.com/cat.png?a=1&b=2",
  );
});

test("reads the first non-comment URI-list entry", () => {
  assert.equal(firstUriListEntry("# source\r\n\r\nhttps://example.com/image.webp\r\n"), "https://example.com/image.webp");
});

test("prefers an HTML image source over an enclosing browser URL", () => {
  assert.equal(
    droppedImageUrl({
      uriList: "https://example.com/article",
      html: '<a href="https://example.com/article"><img src="https://cdn.example.com/photo.jpg"></a>',
    }),
    "https://cdn.example.com/photo.jpg",
  );
});

test("accepts image data URLs and rejects executable or non-network URLs", () => {
  assert.equal(normalizeDroppedImageUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(normalizeDroppedImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeDroppedImageUrl("data:text/html,hello"), null);
});

test("normalizes common image filename extensions", () => {
  assert.equal(extensionForImageType("image/jpeg"), "jpg");
  assert.equal(extensionForImageType("image/svg+xml"), "svg");
});
