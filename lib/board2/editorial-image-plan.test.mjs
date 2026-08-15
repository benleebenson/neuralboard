import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditorialImagePlanPrompt,
  buildEditorialPlanningChunks,
  editorialImageTargetCount,
  parseEditorialImagePlan,
  parseEditorialTopicPlan,
} from "./editorial-image-plan.ts";

test("computes the requested editorial image count from duration and interval", () => {
  assert.equal(editorialImageTargetCount(60, 4), 15);
  assert.equal(editorialImageTargetCount(60.1, 4), 15);
  assert.equal(editorialImageTargetCount(300, 4), 75);
  assert.equal(editorialImageTargetCount(1800, 4), 450);
  assert.equal(editorialImageTargetCount(10_000, 3), 1000);
});

test("chunks large editorial plans without changing the requested total", () => {
  const chunks = buildEditorialPlanningChunks(1800, 450, 40);
  assert.equal(chunks.length, 12);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.targetCount, 0), 450);
  assert.deepEqual(chunks.at(-1), { index: 11, startTime: 1760, endTime: 1800, targetCount: 10 });
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
  assert.match(prompt.system, /NATURAL SUBJECT SHIFTS/i);
  assert.match(prompt.system, /2-4 word title/i);
  assert.match(prompt.system, /topicTitle/);
  assert.match(prompt.user, /First we fall asleep\. Then the dream becomes lucid\./);
  assert.match(prompt.user, /\[3\.50s-7\.00s\] Then the dream becomes lucid\./);
});

test("parses ordered topic groups while preserving absolute image timestamps", () => {
  const topics = parseEditorialTopicPlan(JSON.stringify([
    {
      topicTitle: "German Car Design",
      startTime: 0,
      endTime: 12,
      images: [
        { query: "BMW concept car studio photograph", startTime: 0, reason: "Introduces the design discussion." },
        { query: "automotive clay model workshop photo", startTime: 6, reason: "Shows how the form is developed." },
      ],
    },
    {
      topicTitle: "Lucid Dream Practice",
      startTime: 12,
      endTime: 24,
      images: [
        { query: "dream journal beside alarm clock photograph", startTime: 12, reason: "Makes the practice concrete." },
      ],
    },
  ]), 24, 3);

  assert.equal(topics.length, 2);
  assert.equal(topics[0].topicTitle, "German Car Design");
  assert.equal(topics[1].images[0].startTime, 12);
  assert.equal(topics[1].endTime, 24);
});

test("falls back to one implicit topic when grouping is malformed", () => {
  const topics = parseEditorialTopicPlan(JSON.stringify([
    {
      topicTitle: "Cars",
      startTime: 0,
      endTime: 5,
      images: [{ query: "classic BMW roadside photograph", startTime: 0, reason: "Establishes the first subject." }],
    },
    {
      topicTitle: "Sleep Research",
      startTime: 5,
      endTime: 10,
      images: [{ query: "sleep laboratory participant photograph", startTime: 5, reason: "Moves into the second subject." }],
    },
  ]), 10, 2);

  assert.equal(topics.length, 1);
  assert.equal(topics[0].topicTitle, "Narration Overview");
  assert.equal(topics[0].images.length, 2);
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
