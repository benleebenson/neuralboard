import assert from "node:assert/strict";
import test from "node:test";
import {
  sampleTrenchCoatReveal,
  TRENCH_COAT_REVEAL_BEATS,
  TRENCH_COAT_REVEAL_DURATION,
} from "./trench-coat-reveal.ts";

test("trench coat reveal preserves the eight storyboard beats in order", () => {
  assert.equal(TRENCH_COAT_REVEAL_BEATS.length, 8);
  assert.equal(TRENCH_COAT_REVEAL_DURATION, 4.8);
  for (let index = 1; index < TRENCH_COAT_REVEAL_BEATS.length; index += 1) {
    assert.ok(TRENCH_COAT_REVEAL_BEATS[index].t > TRENCH_COAT_REVEAL_BEATS[index - 1].t);
  }
});

test("the coat starts closed, opens fully for reveal and hold, then closes for the loop", () => {
  const samples = TRENCH_COAT_REVEAL_BEATS.map((beat) => sampleTrenchCoatReveal(beat.t));
  assert.equal(samples[0].open, 0);
  assert.equal(samples[0].reach, 0);
  assert.equal(samples[1].reach, 1);
  assert.equal(samples[2].open, 0.12);
  assert.equal(samples[5].open, 1);
  assert.equal(samples[6].open, 1);
  assert.equal(samples[7].open, 0);
  assert.equal(samples[7].reach, 0);
  assert.equal(samples[7].beatIndex, 7);
});

test("the reveal stays hidden until the coat has begun to part", () => {
  assert.equal(sampleTrenchCoatReveal(TRENCH_COAT_REVEAL_BEATS[1].t).revealAlpha, 0);
  assert.equal(sampleTrenchCoatReveal(TRENCH_COAT_REVEAL_BEATS[5].t).revealAlpha, 1);
});
