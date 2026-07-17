import type { SpawnDoor } from "./stream";

export type PlayCharacterState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  surfaceId: string | null;
  stride: number;
  spin: number;
  spawnX: number;
  spawnY: number;
  action: "none" | "dance" | "emote" | "pullups" | "mirror";
  actionUntil: number;
  landedAt: number;
  grappleX: number | null;
  grappleY: number | null;
  grappleLength: number;
};

export type PlayHairStyle = "crop" | "spikes" | "curls" | "none";
export type PlayOutfitStyle = "tee" | "varsity" | "adventure";

export const PLAY_GRAVITY = 1850;
export const PLAY_JUMP_SPEED = 720;
export const PLAY_MAX_FALL_SPEED = 1350;
export const PLAY_CHARACTER_HEIGHT = 168;
export const PLAY_RESPAWN_BELOW_LOWEST_SURFACE = 650;

const PLAY_RUN_SPEED_FOR_RENDER = 760;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function drawPlaySpawnDoor(
  ctx: CanvasRenderingContext2D,
  state: PlayCharacterState,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number
) {
  const x = (state.spawnX - cam.cameraX) * sf + W / 2;
  const y = (state.spawnY - cam.cameraY) * sf + H / 2;
  const dw = 72 * sf;
  const dh = 126 * sf;
  ctx.save();
  ctx.fillStyle = "#f4b942";
  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.beginPath();
  ctx.roundRect(x - dw / 2, y - dh, dw, dh, [dw * 0.5, dw * 0.5, 4 * sf, 4 * sf]);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff8df";
  ctx.beginPath();
  ctx.arc(x + dw * 0.23, y - dh * 0.45, 4.5 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `700 ${Math.max(8, 11 * sf)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("START", x, y - dh - 10 * sf);
  ctx.restore();
}

export function drawPlacedSpawnDoor(ctx: CanvasRenderingContext2D, door: SpawnDoor, cam: { cameraX: number; cameraY: number; boardZoom: number }, sf: number, W: number, H: number) {
  const x = (door.x - cam.cameraX) * sf + W / 2, y = (door.y - cam.cameraY) * sf + H / 2;
  const dw = 90 * sf, dh = 150 * sf;
  ctx.save(); ctx.fillStyle = "#f4b942"; ctx.strokeStyle = "#2b2520"; ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.beginPath(); ctx.roundRect(x - dw / 2, y - dh, dw, dh, [dw * .5, dw * .5, 4, 4]); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + dw * .23, y - dh * .45, 4.5 * sf, 0, Math.PI * 2); ctx.fillStyle = "#fff8df"; ctx.fill(); ctx.stroke(); ctx.restore();
}

export function drawPoptropicaPlayCharacter(
  ctx: CanvasRenderingContext2D,
  state: PlayCharacterState,
  time: number,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number,
  face: { image: HTMLImageElement | null; aspect: number } | null,
  cursor: { x: number; y: number } | null,
  hairStyle: PlayHairStyle,
  outfitStyle: PlayOutfitStyle
) {
  const x = (state.x - cam.cameraX) * sf + W / 2;
  const y = (state.y - cam.cameraY) * sf + H / 2;
  if (state.grappleX !== null && state.grappleY !== null) {
    const anchorX = (state.grappleX - cam.cameraX) * sf + W / 2;
    const anchorY = (state.grappleY - cam.cameraY) * sf + H / 2;
    ctx.save();
    ctx.strokeStyle = "#4d3827";
    ctx.lineWidth = Math.max(1.5, 2.4 * sf);
    ctx.beginPath();
    ctx.moveTo(x, y - 105 * sf);
    ctx.lineTo(anchorX, anchorY);
    ctx.stroke();
    ctx.fillStyle = "#4d3827";
    ctx.beginPath(); ctx.arc(anchorX, anchorY, 5 * sf, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(anchorX, anchorY); ctx.lineTo(anchorX - 9 * sf, anchorY + 7 * sf); ctx.moveTo(anchorX, anchorY); ctx.lineTo(anchorX + 9 * sf, anchorY + 7 * sf); ctx.stroke();
    ctx.restore();
  }
  const speed01 = clamp(Math.abs(state.vx) / PLAY_RUN_SPEED_FOR_RENDER, 0, 1);
  const moving = speed01 > 0.08 && state.grounded;
  const idleBob = state.grounded && !moving ? Math.sin(time * 2.8) * 4 + Math.sin(time * 1.35) * 1.5 : 0;
  const phase = state.stride;
  const stride = moving ? Math.sin(phase) * lerp(0.38, 0.82, speed01) : 0;
  const lift = moving ? Math.abs(Math.sin(phase)) * 3 : 0;
  const actionWave = state.action === "dance" ? Math.sin(time * 9) * 0.65 : 0;
  const pull = state.action === "pullups";
  const landingAge = time - state.landedAt;
  const landingSquash = state.grounded && landingAge >= 0 && landingAge < 0.18
    ? Math.sin((1 - landingAge / 0.18) * Math.PI) * 0.12
    : 0;
  const bodyY = idleBob - lift + (pull ? -Math.abs(Math.sin(time * 6)) * 20 : 0);
  const S = sf;
  ctx.save();
  ctx.translate(x, y + bodyY * S);
  ctx.scale(state.facing * (1 + landingSquash), 1 - landingSquash);
  if (!state.grounded) {
    const centerY = -82 * S;
    ctx.translate(0, centerY);
    ctx.rotate(state.spin);
    ctx.translate(0, -centerY);
  }
  ctx.strokeStyle = "#27221f";
  ctx.fillStyle = "#f6d4b4";
  ctx.lineWidth = Math.max(1.5, 3.2 * S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const hipY = -61 * S;
  const shoulderY = -103 * S;
  const headY = -160 * S;
  const legSwing = stride;
  const armSwing = -stride * 0.78 + actionWave;
  const limb = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, endR: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(x2, y2, x3, y3);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x3, y3, endR * 1.35, endR, -0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };

  const tuck = state.grounded ? 0 : clamp((Math.abs(state.spin) + Math.max(0, -state.vy) / 500) * 0.2, 0.25, 1);
  const leftFootX = (-18 + legSwing * 37) * S * (1 - tuck * 0.45);
  const rightFootX = (18 - legSwing * 37) * S * (1 - tuck * 0.45);
  const footY = (-4 - tuck * 34) * S;
  limb(-8 * S, hipY, (-24 + legSwing * 12) * S, (-34 - tuck * 10) * S, leftFootX, footY, 8 * S);
  limb(8 * S, hipY, (24 - legSwing * 12) * S, (-34 - tuck * 10) * S, rightFootX, footY, 8 * S);

  ctx.fillStyle = outfitStyle === "varsity" ? "#fffdf4" : outfitStyle === "adventure" ? "#8cb8cf" : "#f4f1e8";
  ctx.beginPath();
  ctx.moveTo(-20 * S, hipY);
  ctx.quadraticCurveTo(-25 * S, -92 * S, -17 * S, shoulderY);
  ctx.quadraticCurveTo(0, -124 * S, 17 * S, shoulderY);
  ctx.quadraticCurveTo(25 * S, -92 * S, 20 * S, hipY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (outfitStyle === "tee") {
    ctx.fillStyle = "#f2b51d";
    ctx.beginPath();
    ctx.moveTo(-7 * S, -91 * S); ctx.lineTo(3 * S, -91 * S); ctx.lineTo(-3 * S, -78 * S); ctx.lineTo(8 * S, -78 * S); ctx.lineTo(-7 * S, -65 * S); ctx.lineTo(-2 * S, -76 * S); ctx.lineTo(-13 * S, -76 * S); ctx.closePath(); ctx.fill();
  } else if (outfitStyle === "varsity") {
    ctx.strokeStyle = "#285ca8"; ctx.lineWidth = Math.max(2, 5 * S); ctx.beginPath(); ctx.arc(0, -103 * S, 16 * S, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.fillStyle = "#174fb8"; ctx.font = `700 ${27 * S}px sans-serif`; ctx.textAlign = "center"; ctx.fillText("8", 0, -70 * S);
  } else {
    ctx.fillStyle = "#332f24"; ctx.beginPath(); ctx.moveTo(-18 * S, -100 * S); ctx.lineTo(-4 * S, -61 * S); ctx.lineTo(5 * S, -61 * S); ctx.lineTo(-9 * S, -104 * S); ctx.closePath(); ctx.fill();
  }

  ctx.fillStyle = "#f6d4b4";
  const leftHandX = (-40 + armSwing * 28) * S;
  const rightHandX = (40 - armSwing * 28) * S;
  const handY = (pull ? -190 : -62 + Math.abs(armSwing) * 6) * S;
  limb(-13 * S, shoulderY + 8 * S, (-34 + armSwing * 14) * S, -92 * S, leftHandX, handY, 9 * S);
  limb(13 * S, shoulderY + 8 * S, (34 - armSwing * 14) * S, -92 * S, rightHandX, handY, 9 * S);

  if (pull) {
    ctx.beginPath();
    ctx.moveTo(-68 * S, -198 * S);
    ctx.lineTo(68 * S, -198 * S);
    ctx.stroke();
  }

  const headLagX = moving ? -state.vx / PLAY_RUN_SPEED_FOR_RENDER * 4 * S : Math.sin(time * 2.8 + 0.35) * 1.5 * S;
  const headLagY = idleBob * 0.35 * S;
  ctx.save();
  ctx.translate(headLagX, headLagY);
  ctx.fillStyle = "#f6d4b4";
  ctx.beginPath();
  ctx.ellipse(0, headY, 61 * S, 43 * S, -0.015, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (face?.image) {
    const aspect = clamp(face.aspect, 0.75, 1.6);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, headY, 57 * S, 39 * S, 0, 0, Math.PI * 2);
    ctx.clip();
    const fw = 116 * S;
    const fh = fw / aspect;
    ctx.drawImage(face.image, -fw / 2, headY - fh / 2, fw, fh);
    ctx.restore();
  }
  ctx.fillStyle = "#191b1d";
  if (hairStyle === "crop") {
    ctx.beginPath(); ctx.ellipse(-4 * S, headY - 35 * S, 51 * S, 17 * S, -0.05, Math.PI, Math.PI * 2); ctx.fill();
  } else if (hairStyle === "spikes") {
    ctx.beginPath(); ctx.moveTo(-55 * S, headY - 24 * S); ctx.lineTo(-70 * S, headY - 53 * S); ctx.lineTo(-39 * S, headY - 42 * S); ctx.lineTo(-33 * S, headY - 68 * S); ctx.lineTo(-10 * S, headY - 43 * S); ctx.lineTo(11 * S, headY - 65 * S); ctx.lineTo(25 * S, headY - 39 * S); ctx.lineTo(52 * S, headY - 48 * S); ctx.lineTo(55 * S, headY - 19 * S); ctx.closePath(); ctx.fill();
  } else if (hairStyle === "curls") {
    for (const [hx, hy, hr] of [[-45,-30,18],[-24,-43,20],[0,-46,21],[25,-42,20],[46,-28,18]] as const) { ctx.beginPath(); ctx.arc(hx * S, headY + hy * S, hr * S, 0, Math.PI * 2); ctx.fill(); }
  }
  const localCursorX = cursor ? (cursor.x - state.x) * state.facing : 80;
  const localCursorY = cursor ? cursor.y - (state.y - 150) : 0;
  const lookLen = Math.max(1, Math.hypot(localCursorX, localCursorY));
  const lookX = clamp(localCursorX / lookLen, -1, 1);
  const lookY = clamp(localCursorY / lookLen, -1, 1);
  const eyes = [{ x: -22, rx: 20, ry: 25 }, { x: 18, rx: 28, ry: 31 }];
  for (const eye of eyes) {
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#5b554d"; ctx.lineWidth = Math.max(1.5, 3 * S);
    ctx.beginPath(); ctx.ellipse(eye.x * S, headY - 13 * S, eye.rx * S, eye.ry * S, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc((eye.x + lookX * eye.rx * 0.42) * S, headY + (-13 + lookY * eye.ry * 0.38) * S, 6.5 * S, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "#80564a"; ctx.lineWidth = Math.max(1, 2.1 * S); ctx.beginPath(); ctx.moveTo(-19 * S, headY + 24 * S); ctx.quadraticCurveTo(12 * S, headY + 29 * S, 33 * S, headY + 13 * S); ctx.stroke();
  if (state.action === "emote") {
    ctx.font = `${30 * S}px sans-serif`;
    ctx.fillText("!", 48 * S, headY - 25 * S);
  }
  ctx.restore();
  ctx.restore();
}
