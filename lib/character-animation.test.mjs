import assert from "node:assert/strict";
import test from "node:test";
import { sampleAnimation, starterAnimations } from "./characterAnimations.ts";

const walk = starterAnimations("test").find((animation) => animation.name === "walk");

test("starter walk uses eight alternating stride poses", () => {
  assert.ok(walk);
  assert.equal(walk.keyframes.length, 9);
  assert.deepEqual(walk.keyframes.map((keyframe) => keyframe.t), [
    0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1,
  ]);

  const firstContact = sampleAnimation(walk, 0);
  const oppositeContact = sampleAnimation(walk, 0.5);
  assert.ok(firstContact && oppositeContact);
  assert.equal(firstContact.leftLegA, -oppositeContact.leftLegA);
  assert.equal(firstContact.rightLegA, -oppositeContact.rightLegA);
  assert.equal(firstContact.leftShinA, -oppositeContact.leftShinA);
  assert.equal(firstContact.rightShinA, -oppositeContact.rightShinA);
});

test("walk passing poses bend the lifted leg without collapsing the stride", () => {
  assert.ok(walk);
  const passing = sampleAnimation(walk, 0.25);
  const oppositePassing = sampleAnimation(walk, 0.75);
  assert.ok(passing && oppositePassing);
  assert.notEqual(passing.leftLegA, passing.leftShinA);
  assert.notEqual(oppositePassing.rightLegA, oppositePassing.rightShinA);
  assert.deepEqual(sampleAnimation(walk, 0), sampleAnimation(walk, 1));
});
