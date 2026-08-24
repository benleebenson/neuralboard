import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  drawTrenchCoatPropToCanvas,
  normalizeTrenchCoatRevealStartSeconds,
  sampleTrenchCoatReveal,
  fitRevealImage,
  trenchCoatRevealProgress,
  trenchCoatRevealPose,
  MIN_TRENCH_COAT_REVEAL_SECONDS,
  TRENCH_COAT_REVEAL_BEATS,
  TRENCH_COAT_REVEAL_DURATION,
} from "./trench-coat-reveal.ts";

function recordingCanvas() {
  const points = [];
  return {
    points,
    globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, fill() {}, stroke() {},
    moveTo(x, y) { points.push({ x, y }); },
    lineTo(x, y) { points.push({ x, y }); },
    quadraticCurveTo(cx, cy, x, y) { points.push({ x: cx, y: cy }, { x, y }); },
    arc(x, y, radius) { points.push({ x: x - radius, y }, { x: x + radius, y }); },
    fillRect(x, y, width, height) { points.push({ x, y }, { x: x + width, y: y + height }); },
    strokeRect(x, y, width, height) { points.push({ x, y }, { x: x + width, y: y + height }); },
    fillText() {},
  };
}

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

test("an editable hold keeps the coat closed until the chosen reveal time", () => {
  assert.equal(trenchCoatRevealProgress(0, 14.2, 10), 0);
  assert.equal(trenchCoatRevealProgress(9.99, 14.2, 10), 0);
  assert.equal(trenchCoatRevealProgress(10, 14.2, 10), 0);
  assert.ok(trenchCoatRevealProgress(12.1, 14.2, 10) > 0.49);
  assert.equal(trenchCoatRevealProgress(14.2, 14.2, 10), 1);
});

test("legacy and out-of-range reveal times normalize safely", () => {
  assert.equal(normalizeTrenchCoatRevealStartSeconds(undefined, 4.2), 0);
  assert.equal(normalizeTrenchCoatRevealStartSeconds(-5, 4.2), 0);
  assert.equal(
    normalizeTrenchCoatRevealStartSeconds(50, 4.2),
    4.2 - MIN_TRENCH_COAT_REVEAL_SECONDS,
  );
});

test("the coat drives only the shared character arm pose", () => {
  assert.deepEqual(trenchCoatRevealPose(0), {
    leftArmA: 0.45,
    rightArmA: -0.45,
    leftForeA: 0.35,
    rightForeA: -0.35,
  });
  const open = trenchCoatRevealPose(1);
  assert.deepEqual(Object.keys(open).sort(), ["leftArmA", "leftForeA", "rightArmA", "rightForeA"]);
  assert.ok(Object.values(open).every((value) => Number.isFinite(value)));
  assert.ok(open.leftArmA > 0);
  assert.ok(open.rightArmA < 0);
});

test("the coat module owns no bespoke character anatomy", () => {
  const source = readFileSync(new URL("./trench-coat-reveal.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ctx\.ellipse\(/);
  assert.doesNotMatch(source, /drawHand|drawLeg|roundedLine/);
  assert.match(source, /resolved torso\/arm joints/);
});

test("the coat keeps a tailored closed silhouette and spreads wide for the reveal", () => {
  const closed = recordingCanvas();
  const opened = recordingCanvas();
  const baseJoints = {
    hip: { x: 0, y: 0 },
    torsoTop: { x: 0, y: -53 },
    leftShoulder: { x: 0, y: -45 },
    rightShoulder: { x: 0, y: -45 },
    leftElbow: { x: -14, y: -12 },
    rightElbow: { x: 14, y: -12 },
    leftHand: { x: -25, y: 14 },
    rightHand: { x: 25, y: 14 },
  };
  drawTrenchCoatPropToCanvas(closed, { progress: 0, joints: baseJoints, torsoLength: 53, strokeWidth: 3 });
  drawTrenchCoatPropToCanvas(opened, {
    progress: 1,
    joints: {
      ...baseJoints,
      leftElbow: { x: -30, y: -34 },
      rightElbow: { x: 30, y: -34 },
      leftHand: { x: -52, y: -15 },
      rightHand: { x: 52, y: -15 },
    },
    torsoLength: 53,
    strokeWidth: 3,
  });
  const halfWidth = (canvas) => Math.max(...canvas.points.map(({ x }) => Math.abs(x)));
  assert.ok(halfWidth(closed) >= 28, "closed coat should retain proper shoulder and hem width");
  assert.ok(halfWidth(opened) > halfWidth(closed) * 1.6, "open panels should spread substantially wider than the idle coat");
});
