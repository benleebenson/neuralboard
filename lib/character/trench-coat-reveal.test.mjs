import assert from "node:assert/strict";
import test from "node:test";
import {
  sampleTrenchCoatReveal,
  fitRevealImage,
  TRENCH_COAT_REVEAL_BEATS,
  TRENCH_COAT_REVEAL_DURATION,
} from "./trench-coat-reveal.ts";

test("trench coat reveal preserves the seven storyboard beats in order", () => {
  assert.equal(TRENCH_COAT_REVEAL_BEATS.length, 7);
  assert.equal(TRENCH_COAT_REVEAL_DURATION, 4.2);
  for (let index = 1; index < TRENCH_COAT_REVEAL_BEATS.length; index += 1) {
    assert.ok(TRENCH_COAT_REVEAL_BEATS[index].t > TRENCH_COAT_REVEAL_BEATS[index - 1].t);
  }
});

test("reveal images preserve aspect ratio inside the opening", () => {
  const wide = fitRevealImage(1600, 900, { x: 0, y: 0, width: 80, height: 80 });
  assert.equal(wide.width, 80);
  assert.equal(wide.height, 45);
  assert.equal(wide.y, 17.5);
  const tall = fitRevealImage(400, 800, { x: 0, y: 0, width: 80, height: 80 });
  assert.equal(tall.width, 40);
  assert.equal(tall.height, 80);
  assert.equal(tall.x, 20);
});

test("the coat starts closed and stays fully open until the loop resets", () => {
  const samples = TRENCH_COAT_REVEAL_BEATS.map((beat) => sampleTrenchCoatReveal(beat.t));
  assert.equal(samples[0].open, 0);
  assert.equal(samples[0].reach, 0);
  assert.equal(samples[1].reach, 1);
  assert.equal(samples[2].open, 0.12);
  assert.equal(samples[5].open, 1);
  assert.equal(samples[6].open, 1);
  assert.equal(samples[6].reach, 1);
  assert.equal(samples[6].beatIndex, 6);
  assert.equal(sampleTrenchCoatReveal(0).open, 0);
  assert.ok(!TRENCH_COAT_REVEAL_BEATS.some((beat) => beat.shortLabel === "Relax"));
});

test("the reveal stays hidden until the coat has begun to part", () => {
  assert.equal(sampleTrenchCoatReveal(TRENCH_COAT_REVEAL_BEATS[1].t).revealAlpha, 0);
  assert.equal(sampleTrenchCoatReveal(TRENCH_COAT_REVEAL_BEATS[5].t).revealAlpha, 1);
});
