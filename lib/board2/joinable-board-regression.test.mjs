import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editor = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");
const joinPage = readFileSync(new URL("../../app/public/page.tsx", import.meta.url), "utf8");
const retiredApi = readFileSync(new URL("../../app/api/public-board/route.ts", import.meta.url), "utf8");

test("the board header exposes code-based sharing and owner shutdown", () => {
  assert.match(editor, /Make board joinable/);
  assert.match(editor, /Code: \{joinCode\}/);
  assert.match(editor, /stopBoardJoinability/);
});

test("joined editors poll shared state and publish edits", () => {
  assert.match(editor, /initialJoinCode/);
  assert.match(editor, /method: "PATCH"/);
  assert.match(editor, /setInterval\(\(\) => \{ void pull\(\); \}, 1200\)/);
  assert.match(editor, /uploadJoinableImage/);
});

test("the former public board is now a private code entry point", () => {
  assert.match(joinPage, /Join a board/);
  assert.match(joinPage, /router\.push\(`\/\?join=\$\{normalized\}`\)/);
  assert.match(retiredApi, /status: 410/);
});
