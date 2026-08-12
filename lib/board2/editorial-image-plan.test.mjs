import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditorialImagePlanPrompt,
  editorialImageTargetCount,
  parseEditorialImagePlan,
} from "./editorial-image-plan.ts";

test("computes the requested editorial image count from duration and interval", () => {
  assert.equal(editorialImageTargetCount(60, 4), 15);
  assert.equal(editorialImageTargetCount(60.1, 4), 16);
  assert.equal(editorialImageTargetCount(300, 4), 24);
});

test("the prompt includes the full narration, timestamps, and editorial constraints", () => {
  const prompt = buildEditorialImagePlanPrompt({
    transcript: "First we fall asleep. Then the dream becomes lucid.",
    segments: [
      { start: 0, end: 3.5, text: "First we fall asleep." },
      { start: 3.5, end: 7, text: "Then the dream becomes lucid." },
    ],
    durationSec: 7,
    secondsPerImage: 4,
    targetCount: 2,
  });

  assert.match(prompt.system, /Read the FULL narration/i);
  assert.match(prompt.system, /do not mechanically assign one literal search/i);
  assert.match(prompt.system, /quote cards/i);
  assert.match(prompt.system, /exactly 2 image moments/i);
  assert.match(prompt.user, /First we fall asleep\. Then the dream becomes lucid\./);
  assert.match(prompt.user, /\[3\.50s-7\.00s\] Then the dream becomes lucid\./);
});

test("parses a strict JSON array and normalizes the first timestamp", () => {
  const plan = parseEditorialImagePlan(JSON.stringify([
    { query: "sleeping woman moonlit bedroom real photo", startTime: 0.4, reason: "Establishes sleep as the doorway into the story." },
    { query: "person realizing dream surreal city photograph", startTime: 4, reason: "Turns the abstract moment of lucidity into a human scene." },
  ]), 8, 2);

  assert.equal(plan.length, 2);
  assert.equal(plan[0].startTime, 0);
  assert.equal(plan[1].startTime, 4);
});

test("recovers JSON from prose or markdown fences and accepts a wrapper defensively", () => {
  const fenced = parseEditorialImagePlan(`Here is the plan:\n\`\`\`json\n[
    {"query":"misty forest path dawn photograph","startTime":0,"reason":"Makes uncertainty tangible as a path into the unknown."}
  ]\n\`\`\``, 5);
  assert.equal(fenced[0]?.query, "misty forest path dawn photograph");

  const wrapped = parseEditorialImagePlan(JSON.stringify({
    images: [{ query: "empty school hallway night real photo", startTime: "2.5", reason: "Creates a recognizable but uncanny dream environment." }],
  }), 5);
  assert.deepEqual(wrapped, [{
    query: "empty school hallway night real photo",
    startTime: 0,
    reason: "Creates a recognizable but uncanny dream environment.",
  }]);
});

test("rejects malformed output and removes invalid or duplicate items", () => {
  assert.deepEqual(parseEditorialImagePlan("not json", 10), []);
  const plan = parseEditorialImagePlan(JSON.stringify([
    { query: "clock reflected in bedroom mirror photograph", startTime: -4, reason: "A reality check begins with an ordinary object." },
    { query: "CLOCK REFLECTED IN BEDROOM MIRROR PHOTOGRAPH", startTime: 3, reason: "Duplicate." },
    { query: "x", startTime: 5, reason: "Too vague." },
    { query: "person flying above coastal city dream photo", startTime: 50, reason: "Pays off the freedom promised by lucid dreaming." },
    { query: "missing reason", startTime: 7 },
  ]), 10);

  assert.equal(plan.length, 2);
  assert.equal(plan[0].startTime, 0);
  assert.equal(plan[1].startTime, 9.9);
});
