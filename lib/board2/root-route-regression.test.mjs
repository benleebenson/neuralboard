import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootPage = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const boardPage = readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("the root URL renders the app shell without a server redirect", () => {
  assert.match(rootPage, /import \{ AppShell \} from "@\/app\/components\/AppShell"/);
  assert.match(rootPage, /return <AppShell \/>/);
  assert.doesNotMatch(rootPage, /redirect\s*\(/);
});

test("the editor header does not show the old Board 2.0 label", () => {
  assert.doesNotMatch(boardPage, /BOARD 2\.0/);
});
