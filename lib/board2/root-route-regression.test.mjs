import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootPage = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const boardPage = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("the root URL renders the board editor without redirecting to /board2", () => {
  assert.match(rootPage, /import Board2Page from "\.\/board2\/page"/);
  assert.match(rootPage, /return <Board2Page \/>/);
  assert.doesNotMatch(rootPage, /redirect\s*\(/);
});

test("the editor header does not show the old Board 2.0 label", () => {
  assert.doesNotMatch(boardPage, /BOARD 2\.0/);
});
