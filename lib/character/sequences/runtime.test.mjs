import assert from "node:assert/strict";
import test from "node:test";
import { kneeToFaceSequence, sampleSequence, sequenceSetupMarks } from "./index.ts";

const setup = { centerX: 500, groundY: 800, direction: 1 };

test("knee-to-face starts on its declared marks facing inward", () => {
  const marks = sequenceSetupMarks(kneeToFaceSequence, setup);
  const sampled = sampleSequence(kneeToFaceSequence, 0, setup);
  assert.deepEqual(sampled.characters.attacker.position, marks.attacker);
  assert.deepEqual(sampled.characters.victim.position, marks.victim);
  assert.equal(sampled.characters.attacker.facing, 1);
  assert.equal(sampled.characters.victim.facing, -1);
});

test("impact frame holds stars, shake, knee, and victim head snap", () => {
  const sampled = sampleSequence(kneeToFaceSequence, 0.5, setup);
  assert.ok(sampled.effects.some((effect) => effect.type === "impactStars"));
  assert.ok(sampled.effects.some((effect) => effect.type === "screenShake"));
  assert.ok(sampled.characters.attacker.pose.rightLegA < -1);
  assert.ok(sampled.characters.victim.pose.headTilt < -0.5);
  assert.notEqual(sampled.shake.x, 0);
});

test("victim ends on their back while attacker advances to stand over them", () => {
  const sampled = sampleSequence(kneeToFaceSequence, 1, setup);
  assert.ok(sampled.characters.victim.pose.poseRotation < -1.5);
  assert.ok(sampled.characters.attacker.position.x < sampled.characters.victim.position.x);
  assert.equal(sampled.characters.victim.position.y, setup.groundY);
});

test("harness spacing override changes the setup marks", () => {
  const sampled = sampleSequence(kneeToFaceSequence, 0, { ...setup, distance: 300 });
  assert.equal(sampled.characters.victim.position.x - sampled.characters.attacker.position.x, 300);
});
