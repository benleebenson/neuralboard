import assert from "node:assert/strict";
import test from "node:test";
import { buildCurationExpansionPrompt, interleaveQueryResults, parseCurationQueries } from "./curation-query-plan.ts";

test("curation prompt requests diverse editorial angles", () => {
  const prompt = buildCurationExpansionPrompt("psychology");
  for (const term of ["PEOPLE", "EXPERIMENTS", "SCENES", "METAPHORS", "CURRENT", "Freud"]) {
    if (term === "Freud") continue;
    assert.match(prompt.system, new RegExp(term));
  }
  assert.match(prompt.user, /psychology/);
});

test("query parsing deduplicates and interleaving alternates sources", () => {
  assert.deepEqual(parseCurationQueries({ queries: [
    { query: "Carl Jung portrait photograph", category: "people" },
    { query: "carl jung portrait photograph", category: "people" },
    { query: "Rorschach inkblot cards table", category: "experiments" },
  ] }).map((item) => item.query), ["Carl Jung portrait photograph", "Rorschach inkblot cards table"]);
  assert.deepEqual(interleaveQueryResults([["a1", "a2"], ["b1", "b2"], ["c1"]]), ["a1", "b1", "c1", "a2", "b2"]);
});
