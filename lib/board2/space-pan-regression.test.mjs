import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../../app/board2/page.tsx", import.meta.url), "utf8");

test("file inputs cannot consume the board space-to-pan shortcut", () => {
  assert.match(source, /!\["file", "button", "checkbox", "radio", "range"\]\.includes\(inputType\)/);
  assert.match(source, /async function handleMediaUpload[\s\S]*?e\.currentTarget\.blur\(\)/);
  assert.match(source, /if \(e\.code === "Space"\)[\s\S]*?e\.preventDefault\(\)/);
});
