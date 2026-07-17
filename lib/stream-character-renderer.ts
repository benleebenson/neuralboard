import { PlayCharacterState, PlayHairStyle, PlayOutfitStyle, drawPoptropicaPlayCharacter } from "./play-character-renderer";
import type { GuestCharacterFrame, StreamCamera, StreamCharacterFrame, StreamEliminationMessage } from "./stream";

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
  skin: "stick" | "styled";
  actionType: string;
  progress: number;
  actionStartTime?: number;
  actionDuration?: number;
  clockOffsetMs?: number;
  emoji?: string;
  faceAspect?: number;
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ELIMINATION_LAUNCH_AT = 0.58;
const ELIMINATION_DESPAWN_AT = 1.04;

export function hostCharacterForRender(frame: StreamCharacterFrame, faceAspect = 1, clockOffsetMs = 0): SharedCharacter {
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
    skin: frame.skin ?? "styled",
    actionType: frame.actionType,
    progress: frame.progress,
    actionStartTime: frame.actionStartTime,
    actionDuration: frame.actionDuration,
    clockOffsetMs,
    emoji: frame.emoji,
    faceAspect,
  };
}

export function guestCharacterForRender(frame: GuestCharacterFrame, clockOffsetMs = 0): SharedCharacter {
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
    skin: frame.skin ?? "styled",
    actionType: frame.actionType,
    progress: frame.actionProgress,
    actionStartTime: frame.actionStartTime,
    actionDuration: frame.actionDuration,
    clockOffsetMs,
    emoji: frame.emote,
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
  const progress = actionProgress(ch, renderTimeMs);
  const moving = ["walk", "run", "walkTo", "runTo"].includes(ch.actionType) || Math.abs(ch.vx) > 45;
  const airborne = ["jump", "jumpTo", "flip", "grapple", "zipline", "eliminated"].includes(ch.actionType) || Math.abs(ch.vy) > 40;
  const action: PlayCharacterState["action"] =
    ch.actionType === "dance" ? "dance" :
    ch.actionType === "emote" ? "emote" :
    ch.actionType === "pullUps" || ch.actionType === "pullups" ? "pullups" :
    ch.actionType === "mirrorCheck" ? "mirror" :
    "none";
  const flipSpin = ch.actionType === "flip"
    ? progress * Math.PI * 2
    : ch.actionType === "eliminated"
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

export function drawSharedStreamCharacter(
  ctx: CanvasRenderingContext2D,
  ch: SharedCharacter,
  face: HTMLImageElement | null,
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
  const hair: PlayHairStyle = ch.skin === "stick" ? "crop" : "spikes";
  const outfit: PlayOutfitStyle = ch.isHost ? "varsity" : "tee";
  drawPoptropicaPlayCharacter(ctx, state, renderTimeMs / 1000, cam, sf, W, H, face ? { image: face, aspect: ch.faceAspect ?? 1 } : null, cursor, hair, outfit);
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
