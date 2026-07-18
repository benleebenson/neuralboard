import { isStreamActionType, resolveStreamSkin, type CharacterSkin, type GuestCharacterFrame, type SpawnDoor, type StreamCamera, type StreamCharacterFrame, type StreamEliminationMessage } from "./stream";

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
  airborneAt?: number;
  spawnX: number;
  spawnY: number;
  action: "none" | "dance" | "emote" | "pullups" | "mirror" | "forceChoke";
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
  const choked = state.action === "forceChoke";
  const landingAge = time - state.landedAt;
  const landingSquash = state.grounded && landingAge >= 0 && landingAge < 0.18
    ? Math.sin((1 - landingAge / 0.18) * Math.PI) * 0.12
    : 0;
  const bodyY = idleBob - lift + (pull ? -Math.abs(Math.sin(time * 6)) * 20 : 0) + (choked ? -28 + Math.sin(time * 9) * 3 : 0);
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
  const chokeKick = choked ? Math.sin(time * 13) : 0;
  const leftFootX = (choked ? -26 + chokeKick * 12 : -18 + legSwing * 37) * S * (1 - tuck * 0.45);
  const rightFootX = (choked ? 26 + chokeKick * 10 : 18 - legSwing * 37) * S * (1 - tuck * 0.45);
  const footY = (choked ? -12 + Math.abs(chokeKick) * 10 : -4 - tuck * 34) * S;
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
  const leftHandX = (choked ? -13 + Math.sin(time * 8) * 2 : -40 + armSwing * 28) * S;
  const rightHandX = (choked ? 13 - Math.sin(time * 8) * 2 : 40 - armSwing * 28) * S;
  const handY = (pull ? -190 : choked ? -135 : -62 + Math.abs(armSwing) * 6) * S;
  limb(-13 * S, shoulderY + 8 * S, choked ? -24 * S : (-34 + armSwing * 14) * S, choked ? -132 * S : -92 * S, leftHandX, handY, 9 * S);
  limb(13 * S, shoulderY + 8 * S, choked ? 24 * S : (34 - armSwing * 14) * S, choked ? -132 * S : -92 * S, rightHandX, handY, 9 * S);

  if (choked) {
    ctx.save();
    ctx.strokeStyle = "rgba(39,34,31,.48)";
    ctx.lineWidth = Math.max(1, 1.4 * S);
    for (const [mx, my] of [[-38, -18], [38, -20], [-28, 4], [30, 6]] as const) {
      ctx.beginPath();
      ctx.moveTo(mx * S, my * S);
      ctx.quadraticCurveTo((mx + Math.sign(mx) * 9) * S, (my - 5) * S, (mx + Math.sign(mx) * 18) * S, my * S);
      ctx.stroke();
    }
    ctx.restore();
  }

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

// Stream/render adapter exports live in this shared renderer module so /board2 and /stream cannot drift.
export const RENDERER_VERSION = "board2-shared-renderer-2026-07-18-c";

export type SharedCharacter = {
  id: string;
  name?: string;
  isHost?: boolean;
  enabled: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  physique: "slim" | "jacked";
  skin: CharacterSkin;
  actionType: string;
  progress: number;
  actionStartTime?: number;
  actionDuration?: number;
  clockOffsetMs?: number;
  emoji?: string;
  faceAspect?: number;
  signActive?: boolean;
  signDataUrl?: string;
};

const ELIMINATION_LAUNCH_AT = 0.58;
const ELIMINATION_DESPAWN_AT = 1.04;
export const STREAM_PROJECTILE_SPEED = 1400;

export function hostCharacterForRender(frame: StreamCharacterFrame, faceAspect = 1, clockOffsetMs = 0): SharedCharacter {
  const skin = resolveStreamSkin(frame.skin, { isHost: true, sourceIfPublished: "presence", warnContext: `host:${frame.id}` }).skin;
  return {
    id: frame.id,
    name: frame.id === "c1" ? "HOST" : "HOST 2",
    isHost: true,
    enabled: frame.enabled,
    x: frame.x,
    y: frame.y,
    vx: frame.velocity?.x ?? 0,
    vy: frame.velocity?.y ?? 0,
    facing: frame.facing,
    physique: frame.physique,
    skin,
    actionType: frame.actionType,
    progress: frame.progress,
    actionStartTime: frame.actionStartTime,
    actionDuration: frame.actionDuration,
    clockOffsetMs,
    emoji: frame.emoji,
    faceAspect,
    signActive: false,
  };
}

export function guestCharacterForRender(frame: GuestCharacterFrame, clockOffsetMs = 0, options?: { guestSkinOverride?: CharacterSkin }): SharedCharacter {
  const skin = resolveStreamSkin(frame.skin, { isHost: false, sourceIfPublished: "presence", guestSkinOverride: options?.guestSkinOverride, warnContext: `guest:${frame.guestId}` }).skin;
  return {
    id: frame.guestId,
    name: frame.name,
    enabled: true,
    x: frame.position.x,
    y: frame.position.y,
    vx: frame.velocity?.x ?? 0,
    vy: frame.velocity?.y ?? 0,
    facing: frame.facing,
    physique: frame.physique ?? "slim",
    skin,
    actionType: frame.actionType,
    progress: frame.actionProgress,
    actionStartTime: frame.actionStartTime,
    actionDuration: frame.actionDuration,
    clockOffsetMs,
    emoji: frame.emote,
    signActive: frame.signActive,
    signDataUrl: frame.signDataUrl,
  };
}

function actionProgress(ch: SharedCharacter, renderTimeMs: number): number {
  if (ch.actionStartTime !== undefined && ch.actionDuration && ch.actionDuration > 0) {
    const senderNow = renderTimeMs - (ch.clockOffsetMs ?? 0);
    return clamp((senderNow - ch.actionStartTime) / (ch.actionDuration * 1000), 0, 1.4);
  }
  return ch.progress;
}

function sharedToPlayState(ch: SharedCharacter, renderTimeMs: number): PlayCharacterState {
  if (!isStreamActionType(ch.actionType) && typeof console !== "undefined") {
    console.warn("[stream:state] unknown actionType; rendering idle fallback", { id: ch.id, actionType: ch.actionType });
  }
  const progress = actionProgress(ch, renderTimeMs);
  const actionType = isStreamActionType(ch.actionType) ? ch.actionType : "idle";
  const moving = ["walk", "run", "walkTo", "runTo"].includes(actionType) || Math.abs(ch.vx) > 45;
  const airborne = ["jump", "jumpTo", "flip", "grapple", "zipline", "skateTo", "wallClimb", "eliminated"].includes(actionType) || Math.abs(ch.vy) > 40;
  const action: PlayCharacterState["action"] =
    actionType === "dance" ? "dance" :
    actionType === "emote" ? "emote" :
    actionType === "forceChoke" ? "forceChoke" :
    actionType === "pullUps" || actionType === "pullups" ? "pullups" :
    actionType === "mirrorCheck" ? "mirror" :
    "none";
  const flipSpin = actionType === "flip"
    ? progress * Math.PI * 2 * ch.facing
    : actionType === "eliminated"
      ? progress < ELIMINATION_LAUNCH_AT
        ? lerp(0, Math.PI / 2.6, clamp((progress - 0.35) / 0.18, 0, 1))
        : Math.PI / 2.6 + (progress - ELIMINATION_LAUNCH_AT) * Math.PI * 7.5
      : airborne
        ? clamp(ch.vy / 850, -0.55, 0.8)
        : 0;
  return {
    x: ch.x,
    y: ch.y,
    vx: ch.vx,
    vy: ch.vy,
    facing: ch.facing,
    grounded: !airborne,
    surfaceId: null,
    stride: moving ? progress * Math.PI * 2 : 0,
    spin: flipSpin,
    spawnX: ch.x,
    spawnY: ch.y,
    action,
    actionUntil: progress < 1 ? renderTimeMs / 1000 + Math.max(0.1, 1 - progress) : 0,
    landedAt: airborne ? -999 : renderTimeMs / 1000,
    grappleX: null,
    grappleY: null,
    grappleLength: 0,
  };
}

function drawStickStreamCharacter(
  ctx: CanvasRenderingContext2D,
  state: PlayCharacterState,
  ch: SharedCharacter,
  face: HTMLImageElement | null,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  renderTimeMs: number,
) {
  const sx = (state.x - cam.cameraX) * sf + W / 2;
  const sy = (state.y - cam.cameraY) * sf + H / 2;
  const speed01 = clamp(Math.abs(state.vx) / 760, 0, 1);
  const moving = speed01 > 0.08 && state.grounded;
  const phase = state.stride;
  const choked = state.action === "forceChoke";
  const chokeKick = choked ? Math.sin(renderTimeMs / 70 + ch.id.length) : 0;
  const bob = choked
    ? -48 + Math.sin(renderTimeMs / 120) * 4
    : state.grounded ? (moving ? Math.abs(Math.sin(phase)) * -5 : Math.sin(renderTimeMs / 430) * 2.5) : 0;
  const actionWave = state.action === "dance" ? Math.sin(renderTimeMs / 100) * 0.55 : 0;
  const S = sf;
  ctx.save();
  ctx.translate(sx, sy + bob * S);
  ctx.scale(state.facing, 1);
  if (!state.grounded) {
    ctx.translate(0, -92 * S);
    ctx.rotate(state.spin);
    ctx.translate(0, 92 * S);
  }
  ctx.strokeStyle = "#27221f";
  ctx.fillStyle = "#fffdf4";
  ctx.lineWidth = Math.max(1.5, 4 * S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const hipY = -58 * S;
  const shoulderY = -118 * S;
  const headY = -158 * S;
  const stride = moving ? Math.sin(phase) * 44 * S : 0;
  const signRaise = ch.signActive && ch.signDataUrl;
  ctx.beginPath();
  ctx.moveTo(0, hipY);
  ctx.lineTo(0, shoulderY);
  ctx.stroke();
  const limb = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(x2, y2, x3, y3);
    ctx.stroke();
  };
  if (choked) {
    limb(-8 * S, hipY, -34 * S + chokeKick * 8 * S, -30 * S, (-34 + chokeKick * 18) * S, -8 * S);
    limb(8 * S, hipY, 34 * S + chokeKick * 7 * S, -32 * S, (34 - chokeKick * 16) * S, -9 * S);
  } else {
    limb(-8 * S, hipY, (-20 * S) + stride * 0.25, -35 * S, (-24 * S) + stride, -2 * S);
    limb(8 * S, hipY, (20 * S) - stride * 0.25, -35 * S, (24 * S) - stride, -2 * S);
  }
  const armSwing = moving ? -Math.sin(phase) * 28 * S : actionWave * 24 * S;
  if (choked) {
    limb(-2 * S, shoulderY, -20 * S, -135 * S, -9 * S, -142 * S);
    limb(2 * S, shoulderY, 20 * S, -135 * S, 9 * S, -142 * S);
    ctx.save();
    ctx.strokeStyle = "rgba(39,34,31,.48)";
    ctx.lineWidth = Math.max(1, 1.25 * S);
    for (const [mx, my] of [[-42, -24], [42, -20], [-31, 6], [35, 8]] as const) {
      ctx.beginPath();
      ctx.moveTo(mx * S, my * S);
      ctx.quadraticCurveTo((mx + Math.sign(mx) * 10) * S, (my - 5) * S, (mx + Math.sign(mx) * 20) * S, my * S);
      ctx.stroke();
    }
    ctx.restore();
  } else if (signRaise) {
    limb(-2 * S, shoulderY, -36 * S, -162 * S, -62 * S, -205 * S);
    limb(2 * S, shoulderY, 36 * S, -162 * S, 62 * S, -205 * S);
  } else {
    limb(-2 * S, shoulderY, -34 * S - armSwing * 0.2, -94 * S, -38 * S - armSwing, -57 * S);
    limb(2 * S, shoulderY, 34 * S + armSwing * 0.2, -94 * S, 38 * S + armSwing, -57 * S);
  }
  ctx.beginPath();
  ctx.ellipse(0, headY, 31 * S, 37 * S, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (face) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, headY, 29 * S, 35 * S, 0, 0, Math.PI * 2);
    ctx.clip();
    const fw = 62 * S;
    const fh = fw / clamp(ch.faceAspect ?? 1, 0.75, 1.6);
    ctx.drawImage(face, -fw / 2, headY - fh / 2, fw, fh);
    ctx.restore();
  }
  ctx.restore();
}

function drawHeldSign(
  ctx: CanvasRenderingContext2D,
  ch: SharedCharacter,
  sign: HTMLImageElement | null,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  renderTimeMs: number,
) {
  if (!ch.signActive || !sign) return;
  const sx = (ch.x - cam.cameraX) * sf + W / 2;
  const sy = (ch.y - cam.cameraY) * sf + H / 2;
  const sway = Math.sin(renderTimeMs / 420 + ch.id.length) * 4 * sf;
  const w = 132 * sf;
  const h = 88 * sf;
  ctx.save();
  ctx.translate(sx + sway, sy - 250 * sf);
  ctx.rotate(Math.sin(renderTimeMs / 650) * 0.025);
  ctx.fillStyle = "#fffdf4";
  ctx.strokeStyle = "#27221f";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 6 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-w / 2 + 6 * sf, -h / 2 + 6 * sf, w - 12 * sf, h - 12 * sf, 4 * sf);
  ctx.clip();
  ctx.drawImage(sign, -w / 2 + 6 * sf, -h / 2 + 6 * sf, w - 12 * sf, h - 12 * sf);
  ctx.restore();
  ctx.restore();
}

export function drawSharedStreamCharacter(
  ctx: CanvasRenderingContext2D,
  ch: SharedCharacter,
  face: HTMLImageElement | null,
  sign: HTMLImageElement | null,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  alpha = 1,
  renderTimeMs = Date.now(),
) {
  if (!ch.enabled) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const state = sharedToPlayState(ch, renderTimeMs);
  const cursor = { x: ch.x + ch.facing * 120, y: ch.y - 145 };
  if (ch.skin === "stick") {
    drawStickStreamCharacter(ctx, state, ch, face, cam, sf, W, H, renderTimeMs);
  } else {
    const hair: PlayHairStyle = "spikes";
    const outfit: PlayOutfitStyle = ch.isHost ? "varsity" : "tee";
    drawPoptropicaPlayCharacter(ctx, state, renderTimeMs / 1000, cam, sf, W, H, face ? { image: face, aspect: ch.faceAspect ?? 1 } : null, cursor, hair, outfit);
  }
  drawHeldSign(ctx, ch, sign, cam, sf, W, H, renderTimeMs);
  if (ch.name) {
    const sx = (ch.x - cam.cameraX) * sf + W / 2;
    const sy = (ch.y - cam.cameraY) * sf + H / 2;
    ctx.font = `700 ${Math.max(9, 13 * sf)}px 'Caveat', monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = ch.isHost ? "#8b2bd1" : "#27221f";
    ctx.fillText(ch.name, sx, sy - 230 * sf);
  }
  if (ch.emoji) {
    const sx = (ch.x - cam.cameraX) * sf + W / 2;
    const sy = (ch.y - cam.cameraY) * sf + H / 2;
    ctx.font = `${Math.max(18, 30 * sf)}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillText(ch.emoji, sx, sy - 280 * sf);
  }
  ctx.restore();
}

export function projectilePoint(origin: { x: number; y: number }, dir: { x: number; y: number }, startMs: number, nowMs: number, speed = STREAM_PROJECTILE_SPEED) {
  const age = Math.max(0, (nowMs - startMs) / 1000);
  return { x: origin.x + dir.x * speed * age, y: origin.y + dir.y * speed * age };
}

export function drawWeaponProjectile(
  ctx: CanvasRenderingContext2D,
  shot: { origin: { x: number; y: number }; dir: { x: number; y: number }; sentAt: number; seed: number },
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  nowMs = Date.now(),
) {
  const head = projectilePoint(shot.origin, shot.dir, shot.sentAt, nowMs);
  const tail = projectilePoint(shot.origin, shot.dir, shot.sentAt - 85, nowMs);
  const sx = (head.x - cam.cameraX) * sf + W / 2;
  const sy = (head.y - cam.cameraY) * sf + H / 2;
  const tx = (tail.x - cam.cameraX) * sf + W / 2;
  const ty = (tail.y - cam.cameraY) * sf + H / 2;
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([10 * sf, 7 * sf]);
  ctx.strokeStyle = "#f4b942";
  ctx.lineWidth = Math.max(2, 4 * sf);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff45f";
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(3, 5 * sf), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawTommyGunHeld(
  ctx: CanvasRenderingContext2D,
  shooter: { x: number; y: number; facing: 1 | -1 },
  aimBoard: { x: number; y: number },
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  recoilPx = 0,
) {
  const sx = (shooter.x - cam.cameraX) * sf + W / 2;
  const sy = (shooter.y - cam.cameraY) * sf + H / 2;
  const ax = (aimBoard.x - cam.cameraX) * sf + W / 2;
  const ay = (aimBoard.y - cam.cameraY) * sf + H / 2;
  const rawDx = ax - sx;
  const dir = Math.abs(rawDx) < Math.tan((8 * Math.PI) / 180) * Math.abs(ay - (sy - 104 * sf))
    ? shooter.facing
    : rawDx >= 0 ? 1 : -1;
  const localAim = Math.atan2(ay - (sy - 104 * sf), Math.abs(rawDx));
  const aimUxLocal = Math.cos(localAim);
  const aimUy = Math.sin(localAim);
  const aimUx = aimUxLocal * dir;
  const perpX = -aimUy;
  const perpY = aimUx;
  const chest = { x: sx, y: sy - 108 * sf };
  const recoil = recoilPx * sf;
  const rearGrip = {
    x: chest.x + aimUx * 34 * sf - aimUx * recoil,
    y: chest.y + aimUy * 34 * sf - aimUy * recoil,
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#27221f";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.translate(rearGrip.x - aimUx * 18 * sf - perpX * 1.5 * sf, rearGrip.y - aimUy * 18 * sf - perpY * 1.5 * sf);
  ctx.rotate(localAim);
  ctx.scale(dir, 1);
  ctx.fillStyle = "#595f66";
  ctx.beginPath();
  ctx.roundRect(0, -9 * sf, 58 * sf, 18 * sf, 4 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(56 * sf, -3 * sf, 30 * sf, 6 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(82 * sf, -9 * sf);
  ctx.lineTo(89 * sf, -9 * sf);
  ctx.stroke();
  ctx.fillStyle = "#8B5A2B";
  ctx.beginPath();
  ctx.moveTo(-1 * sf, 1 * sf);
  ctx.lineTo(-38 * sf, 18 * sf);
  ctx.lineTo(-43 * sf, 9 * sf);
  ctx.lineTo(-8 * sf, -6 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(17 * sf, 9 * sf, 10 * sf, 26 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(36 * sf, 7 * sf, 9 * sf, 24 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#6d7379";
  ctx.beginPath();
  ctx.arc(31 * sf, 20 * sf, 16 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function eliminationFrameForGuest(
  frame: GuestCharacterFrame,
  event: StreamEliminationMessage,
  renderTimeMs = Date.now(),
  clockOffsetMs = 0,
): GuestCharacterFrame | null {
  const hostNow = renderTimeMs - clockOffsetMs;
  const t = clamp((hostNow - event.startTime) / Math.max(1, event.duration * 1000), 0, 1.2);
  if (t >= ELIMINATION_DESPAWN_AT) return null;
  const dir: 1 | -1 = event.target.x >= event.shooter.x ? 1 : -1;
  const hitShake =
    Math.sin(t * Math.PI * 54 + event.seed) *
    (t < ELIMINATION_LAUNCH_AT ? Math.max(0, 1 - Math.abs(t - 0.35) * 2.4) : 0);
  let position = {
    x: event.target.x + dir * hitShake * 18,
    y: event.target.y - Math.abs(hitShake) * 10,
  };
  let velocity = { x: dir * 80, y: -30 };
  if (t >= ELIMINATION_LAUNCH_AT) {
    const u = clamp((t - ELIMINATION_LAUNCH_AT) / (ELIMINATION_DESPAWN_AT - ELIMINATION_LAUNCH_AT), 0, 1.15);
    const horizontal = 520 * u + 5200 * u * u;
    const lift = -Math.sin(clamp(u, 0, 1) * Math.PI) * 660;
    const fall = 260 * u * u;
    position = {
      x: event.target.x + dir * horizontal,
      y: event.target.y + lift + fall,
    };
    velocity = {
      x: dir * (650 + 3200 * u),
      y: -820 + 2100 * u,
    };
  }
  return {
    ...frame,
    actionType: "eliminated",
    actionStartTime: event.startTime,
    actionDuration: event.duration,
    actionProgress: t,
    facing: dir > 0 ? -1 : 1,
    position,
    velocity,
    receivedAt: renderTimeMs,
  };
}

export function drawEliminationSequence(
  ctx: CanvasRenderingContext2D,
  event: StreamEliminationMessage,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  renderTimeMs = Date.now(),
  clockOffsetMs = 0,
) {
  const hostNow = renderTimeMs - clockOffsetMs;
  const t = clamp((hostNow - event.startTime) / Math.max(1, event.duration * 1000), 0, 1.1);
  const sx = (event.shooter.x - cam.cameraX) * sf + W / 2;
  const sy = (event.shooter.y - cam.cameraY) * sf + H / 2;
  const tx = (event.target.x - cam.cameraX) * sf + W / 2;
  const ty = (event.target.y - cam.cameraY) * sf + H / 2;
  const dir = event.shooter.facing;
  const aim = Math.atan2((ty - 92 * sf) - (sy - 104 * sf), tx - sx);
  const recoil = Math.sin(t * Math.PI * 36 + event.seed) * (t > 0.14 && t < 0.58 ? 3 * sf : 0);
  const aimUx = Math.cos(aim);
  const aimUy = Math.sin(aim);
  const perpX = -aimUy;
  const perpY = aimUx;
  const chest = { x: sx, y: sy - 108 * sf };
  const rearGrip = {
    x: chest.x + aimUx * 34 * sf - aimUx * Math.abs(recoil),
    y: chest.y + aimUy * 34 * sf - aimUy * Math.abs(recoil),
  };
  const frontGrip = {
    x: rearGrip.x + aimUx * 52 * sf,
    y: rearGrip.y + aimUy * 52 * sf,
  };
  const shoulderTrigger = { x: sx + dir * 14 * sf, y: sy - 118 * sf };
  const shoulderSupport = { x: sx - dir * 14 * sf, y: sy - 116 * sf };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#27221f";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.fillStyle = "#fff3dc";
  ctx.beginPath();
  ctx.moveTo(sx - 16 * sf, sy - 122 * sf);
  ctx.lineTo(sx + 18 * sf, sy - 120 * sf);
  ctx.lineTo(sx + 10 * sf, sy - 54 * sf);
  ctx.lineTo(sx - 10 * sf, sy - 54 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 12 * sf, sy - 54 * sf);
  ctx.lineTo(sx - 24 * sf, sy - 5 * sf);
  ctx.moveTo(sx + 12 * sf, sy - 54 * sf);
  ctx.lineTo(sx + 24 * sf, sy - 5 * sf);
  ctx.stroke();
  const solveArm = (shoulder: { x: number; y: number }, hand: { x: number; y: number }, bend: 1 | -1) => {
    const upper = 44 * sf;
    const fore = 42 * sf;
    const dx = hand.x - shoulder.x;
    const dy = hand.y - shoulder.y;
    const rawD = Math.max(0.001, Math.hypot(dx, dy));
    const d = clamp(rawD, 8 * sf, upper + fore - 0.01);
    const ux = dx / rawD;
    const uy = dy / rawD;
    const along = (upper * upper - fore * fore + d * d) / (2 * d);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const base = { x: shoulder.x + ux * along, y: shoulder.y + uy * along };
    return { x: base.x + (-uy) * height * bend, y: base.y + ux * height * bend };
  };
  const armTo = (shoulder: { x: number; y: number }, hand: { x: number; y: number }, bend: 1 | -1) => {
    const elbow = solveArm(shoulder, hand, bend);
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(elbow.x, elbow.y);
    ctx.lineTo(hand.x, hand.y);
    ctx.stroke();
    ctx.fillStyle = "#f6d4b4";
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, 7 * sf, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };
  armTo(shoulderSupport, frontGrip, dir > 0 ? 1 : -1);
  armTo(shoulderTrigger, rearGrip, dir > 0 ? -1 : 1);
  ctx.translate(rearGrip.x - aimUx * 18 * sf - perpX * 1.5 * sf, rearGrip.y - aimUy * 18 * sf - perpY * 1.5 * sf);
  ctx.rotate(aim);
  ctx.fillStyle = "#595f66";
  ctx.beginPath();
  ctx.roundRect(0, -9 * sf, 58 * sf, 18 * sf, 4 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(56 * sf, -3 * sf);
  ctx.lineTo(86 * sf, -3 * sf);
  ctx.lineTo(86 * sf, 3 * sf);
  ctx.lineTo(56 * sf, 3 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(82 * sf, -9 * sf);
  ctx.lineTo(89 * sf, -9 * sf);
  ctx.stroke();
  ctx.fillStyle = "#8B5A2B";
  ctx.beginPath();
  ctx.moveTo(-1 * sf, 1 * sf);
  ctx.lineTo(-38 * sf, 18 * sf);
  ctx.lineTo(-43 * sf, 9 * sf);
  ctx.lineTo(-8 * sf, -6 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(17 * sf, 9 * sf, 10 * sf, 26 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(36 * sf, 7 * sf, 9 * sf, 24 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#6d7379";
  ctx.beginPath();
  ctx.arc(31 * sf, 20 * sf, 16 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (t > 0.14 && t < 0.58) {
    for (let i = 0; i < 3; i += 1) {
      const casingT = (t * 16 + i * 0.31 + event.seed * 0.001) % 1;
      ctx.beginPath();
      ctx.moveTo((35 - casingT * 18) * sf, (-13 - i * 4 - casingT * 9) * sf);
      ctx.lineTo((39 - casingT * 18) * sf, (-15 - i * 4 - casingT * 9) * sf);
      ctx.stroke();
    }
  }
  ctx.restore();

  [0.18, 0.33, 0.48].forEach((start, index) => {
    const shotT = clamp((t - start) / 0.14, 0, 1);
    if (shotT <= 0 || shotT >= 1) return;
    const muzzleX = rearGrip.x + Math.cos(aim) * 116 * sf;
    const muzzleY = rearGrip.y + Math.sin(aim) * 116 * sf;
    const targetX = tx + Math.sin(event.seed + index) * 14 * sf;
    const targetY = ty - (96 + index * 8) * sf;
    const ex = lerp(muzzleX, targetX, shotT);
    const ey = lerp(muzzleY, targetY, shotT);
    ctx.save();
    ctx.strokeStyle = ["#9be7ff", "#f4b942", "#ff5e87"][index];
    ctx.setLineDash([8 * sf, 5 * sf]);
    ctx.lineWidth = Math.max(2, 4 * sf);
    ctx.beginPath();
    ctx.moveTo(muzzleX, muzzleY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    const burst = (1 - Math.abs(shotT - 0.78)) * 16 * sf;
    if (shotT > 0.62) {
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const a = (i / 10) * Math.PI * 2;
        const r = i % 2 ? burst * 0.45 : burst;
        const px = targetX + Math.cos(a) * r;
        const py = targetY + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (shotT < 0.22) {
      ctx.fillStyle = "#fff45f";
      ctx.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        const r = (i % 2 ? 10 : 21) * sf * (1 - shotT);
        const px = muzzleX + Math.cos(a) * r;
        const py = muzzleY + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  });
  if (t >= ELIMINATION_LAUNCH_AT) {
    const u = clamp((t - ELIMINATION_LAUNCH_AT) / (ELIMINATION_DESPAWN_AT - ELIMINATION_LAUNCH_AT), 0, 1.15);
    const trailDir = event.target.x >= event.shooter.x ? 1 : -1;
    ctx.save();
    ctx.strokeStyle = "rgba(39,34,31,0.62)";
    ctx.fillStyle = "rgba(255,244,95,0.9)";
    ctx.lineWidth = Math.max(1, 2 * sf);
    for (let i = 0; i < 5; i += 1) {
      const px = tx + trailDir * (90 + i * 58 + u * 260) * sf;
      const py = ty - (120 + Math.sin(u * Math.PI + i) * 80 - i * 14) * sf;
      ctx.beginPath();
      for (let j = 0; j < 5; j += 1) {
        const a = (j / 5) * Math.PI * 2 - Math.PI / 2;
        const r = (j % 2 ? 5 : 12) * sf * (1 - Math.min(0.75, u * 0.5));
        const x = px + Math.cos(a) * r;
        const y = py + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
