export const TRENCH_COAT_REVEAL_DURATION = 4.2;

export const TRENCH_COAT_REVEAL_BEATS = [
  { t: 0, label: "Idle in coat", shortLabel: "Idle", reach: 0, open: 0 },
  { t: 0.14, label: "Hands to lapels", shortLabel: "Lapels", reach: 1, open: 0 },
  { t: 0.28, label: "Begins to pull", shortLabel: "Pull", reach: 1, open: 0.12 },
  { t: 0.42, label: "Coat opens a little", shortLabel: "A little", reach: 1, open: 0.3 },
  { t: 0.56, label: "Coat opens wider", shortLabel: "Wider", reach: 1, open: 0.62 },
  { t: 0.7, label: "Full open reveal", shortLabel: "Reveal", reach: 1, open: 1 },
  { t: 1, label: "Hold open pose", shortLabel: "Hold", reach: 1, open: 1 },
] as const;

export type TrenchCoatRevealSample = {
  beatIndex: number;
  beatLabel: string;
  open: number;
  reach: number;
  revealAlpha: number;
};

type Point = { x: number; y: number };

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => {
  const value = clamp(t);
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
};

export function sampleTrenchCoatReveal(progress: number): TrenchCoatRevealSample {
  const t = clamp(progress);
  let beatIndex = 0;
  while (beatIndex < TRENCH_COAT_REVEAL_BEATS.length - 1 && t >= TRENCH_COAT_REVEAL_BEATS[beatIndex + 1].t) {
    beatIndex += 1;
  }
  const left = TRENCH_COAT_REVEAL_BEATS[beatIndex];
  const right = TRENCH_COAT_REVEAL_BEATS[Math.min(beatIndex + 1, TRENCH_COAT_REVEAL_BEATS.length - 1)];
  const interval = easeInOut((t - left.t) / Math.max(0.0001, right.t - left.t));
  const open = lerp(left.open, right.open, interval);
  return {
    beatIndex,
    beatLabel: left.label,
    open,
    reach: lerp(left.reach, right.reach, interval),
    revealAlpha: clamp((open - 0.2) / 0.55),
  };
}

function roundedLine(ctx: CanvasRenderingContext2D, from: Point, via: Point, to: Point) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(via.x, via.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function drawSleeve(ctx: CanvasRenderingContext2D, side: -1 | 1, shoulder: Point, elbow: Point, hand: Point) {
  const widthAtShoulder = 10;
  const widthAtElbow = 7.5;
  const widthAtWrist = 5.5;
  const segmentNormal = (a: Point, b: Point) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.max(0.001, Math.hypot(dx, dy));
    return { x: -dy / length, y: dx / length };
  };
  const upperNormal = segmentNormal(shoulder, elbow);
  const lowerNormal = segmentNormal(elbow, hand);
  const normal = {
    x: (upperNormal.x + lowerNormal.x) / 2,
    y: (upperNormal.y + lowerNormal.y) / 2,
  };
  ctx.beginPath();
  ctx.moveTo(shoulder.x + upperNormal.x * widthAtShoulder, shoulder.y + upperNormal.y * widthAtShoulder);
  ctx.lineTo(elbow.x + normal.x * widthAtElbow, elbow.y + normal.y * widthAtElbow);
  ctx.lineTo(hand.x + lowerNormal.x * widthAtWrist, hand.y + lowerNormal.y * widthAtWrist);
  ctx.lineTo(hand.x - lowerNormal.x * widthAtWrist, hand.y - lowerNormal.y * widthAtWrist);
  ctx.lineTo(elbow.x - normal.x * widthAtElbow, elbow.y - normal.y * widthAtElbow);
  ctx.lineTo(shoulder.x - upperNormal.x * widthAtShoulder, shoulder.y - upperNormal.y * widthAtShoulder);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Reference cuff/watch: the small burnt-orange accent stays on the viewer's left wrist.
  if (side === -1) {
    const angle = Math.atan2(hand.y - elbow.y, hand.x - elbow.x);
    ctx.save();
    ctx.translate(lerp(elbow.x, hand.x, 0.88), lerp(elbow.y, hand.y, 0.88));
    ctx.rotate(angle);
    ctx.fillStyle = "#b9550c";
    ctx.fillRect(-5, -7, 9, 14);
    ctx.strokeRect(-5, -7, 9, 14);
    ctx.restore();
  }
}

function drawHand(ctx: CanvasRenderingContext2D, point: Point, side: -1 | 1, gripping: boolean) {
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.fillStyle = "#fffdf7";
  ctx.lineWidth = 2.4;
  if (gripping) {
    ctx.beginPath();
    ctx.roundRect(-5, -8, 10, 16, 4);
    ctx.fill();
    ctx.stroke();
    for (const y of [-4, 0, 4]) {
      ctx.beginPath();
      ctx.moveTo(side * -4, y);
      ctx.lineTo(side * 3, y + 1);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(side * -3, -7);
    ctx.lineTo(side * -2, 7);
    ctx.stroke();
    for (const offset of [-4, 0, 4]) {
      ctx.beginPath();
      ctx.moveTo(side * -1, 4);
      ctx.lineTo(side * (3 + offset * 0.18), 11 + Math.abs(offset) * 0.18);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawCoatBack(ctx: CanvasRenderingContext2D) {
  // The back stays on the body while the two front panels are pulled apart.
  // Drawing it as its own lower layer keeps the figure from reading as two
  // disconnected pieces of fabric at the full-open pose.
  ctx.beginPath();
  ctx.moveTo(-27, -168);
  ctx.quadraticCurveTo(-43, -146, -45, -111);
  ctx.quadraticCurveTo(-51, -84, -50, -67);
  ctx.quadraticCurveTo(0, -56, 50, -67);
  ctx.quadraticCurveTo(51, -84, 45, -111);
  ctx.quadraticCurveTo(43, -146, 27, -168);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // A restrained hem/fold detail distinguishes the coat body from the moving
  // front panels without competing with the reveal in the middle.
  ctx.beginPath();
  ctx.moveTo(-31, -72);
  ctx.quadraticCurveTo(0, -65, 31, -72);
  ctx.stroke();
}

function drawCoatPanel(ctx: CanvasRenderingContext2D, side: -1 | 1, open: number, hand: Point) {
  const innerTopX = side * lerp(2, 10, open);
  const innerHemX = side * lerp(4, 31, open);
  const outerHemX = side * lerp(39, 92, open);
  const shoulderX = side * 27;
  const lapelX = side * lerp(19, 31, open);
  const heldX = lerp(side * 37, hand.x, open);
  const heldY = lerp(-139, hand.y + 4, open);

  ctx.beginPath();
  ctx.moveTo(side * 8, -176);
  ctx.lineTo(shoulderX, -168);
  ctx.quadraticCurveTo(side * 42, -145, heldX, heldY);
  ctx.quadraticCurveTo(outerHemX, -91, outerHemX, -64);
  ctx.quadraticCurveTo(side * 58, -69, innerHemX, -72);
  ctx.lineTo(innerTopX, -147);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Notched lapel and long fold mirror the storyboard silhouette.
  ctx.beginPath();
  ctx.moveTo(side * 7, -174);
  ctx.lineTo(side * 19, -158);
  ctx.lineTo(lapelX, -162);
  ctx.lineTo(side * lerp(24, 36, open), -145);
  ctx.lineTo(side * lerp(8, 18, open), -128);
  ctx.lineTo(innerTopX, -147);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(innerTopX, -147);
  ctx.lineTo(innerHemX, -72);
  ctx.stroke();
}

export function drawTrenchCoatRevealToCanvas(
  ctx: CanvasRenderingContext2D,
  args: { x: number; groundY: number; scale?: number; progress: number },
) {
  const sample = sampleTrenchCoatReveal(args.progress);
  const { open, reach } = sample;
  const scale = args.scale ?? 1;
  const ink = "#20201e";
  const paper = "#fffdf7";
  const coat = "#f7f5ee";
  const coatBack = "#eeece4";
  const grip = reach > 0.7;

  ctx.save();
  ctx.translate(args.x, args.groundY);
  ctx.scale(scale, scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink;
  ctx.fillStyle = paper;
  ctx.lineWidth = 3;

  // The stationary back panel establishes one continuous coat silhouette.
  ctx.fillStyle = coatBack;
  drawCoatBack(ctx);

  // Legs and the simple stick body sit in front of the coat back and remain
  // visible below and through the opening between the front panels.
  ctx.fillStyle = paper;
  roundedLine(ctx, { x: 0, y: -76 }, { x: -11, y: -39 }, { x: -16, y: -3 });
  roundedLine(ctx, { x: -16, y: -3 }, { x: -25, y: -1 }, { x: -29, y: 0 });
  roundedLine(ctx, { x: 0, y: -76 }, { x: 12, y: -39 }, { x: 17, y: -3 });
  roundedLine(ctx, { x: 17, y: -3 }, { x: 25, y: -1 }, { x: 29, y: 0 });
  ctx.beginPath();
  ctx.moveTo(0, -169);
  ctx.lineTo(0, -76);
  ctx.stroke();

  // A small board-colored card stands in for whatever the final reveal will become.
  ctx.save();
  ctx.globalAlpha *= sample.revealAlpha;
  ctx.fillStyle = "#c8f135";
  ctx.beginPath();
  ctx.roundRect(-25, -139, 50, 55, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = "800 13px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("REVEAL", 0, -111);
  ctx.restore();

  const lapelHandX = 15;
  const downHand: Point = { x: 47, y: -78 };
  const lapelHand: Point = { x: lapelHandX, y: -137 };
  const openHand: Point = { x: lerp(21, 96, open), y: lerp(-136, -122, open) };
  const handMagnitude: Point = {
    x: lerp(downHand.x, open > 0.02 ? openHand.x : lapelHand.x, reach),
    y: lerp(downHand.y, open > 0.02 ? openHand.y : lapelHand.y, reach),
  };
  const hands: Record<-1 | 1, Point> = {
    [-1]: { x: -handMagnitude.x, y: handMagnitude.y },
    [1]: { x: handMagnitude.x, y: handMagnitude.y },
  };

  // These are the separate front flaps that the hands pull away from the back.
  ctx.fillStyle = coat;
  drawCoatPanel(ctx, -1, open, hands[-1]);
  drawCoatPanel(ctx, 1, open, hands[1]);

  for (const side of [-1, 1] as const) {
    const shoulder = { x: side * 31, y: -163 };
    const elbowDown = { x: side * 44, y: -118 };
    const elbowLapel = { x: side * 31, y: -130 };
    const elbowOpen = { x: side * lerp(42, 66, open), y: lerp(-136, -142, open) };
    const targetElbow = open > 0.02 ? elbowOpen : elbowLapel;
    const elbow = { x: lerp(elbowDown.x, targetElbow.x, reach), y: lerp(elbowDown.y, targetElbow.y, reach) };
    drawSleeve(ctx, side, shoulder, elbow, hands[side]);
  }

  // Collar, neck, and blank oval head match the clean line-art reference.
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.moveTo(-23, -170);
  ctx.lineTo(-10, -180);
  ctx.lineTo(0, -169);
  ctx.lineTo(10, -180);
  ctx.lineTo(23, -170);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -220, 37, 42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  for (const side of [-1, 1] as const) drawHand(ctx, hands[side], side, grip);
  ctx.restore();
  return sample;
}
