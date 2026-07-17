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

function drawStyledFace(
  ctx: CanvasRenderingContext2D,
  face: HTMLImageElement | null,
  S: number,
  headY: number,
  headRX: number,
  headRY: number,
  faceAspect = 1,
) {
  ctx.fillStyle = "#f6d4b4";
  ctx.beginPath();
  ctx.ellipse(0, headY, headRX, headRY, -0.015, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, headY, headRX * 0.93, headRY * 0.93, 0, 0, Math.PI * 2);
  ctx.clip();
  if (face?.complete && face.naturalWidth > 0 && face.naturalHeight > 0) {
    try {
      const fw = headRX * 1.86;
      const fh = fw * clamp(faceAspect, 0.75, 1.6);
      ctx.drawImage(face, -fw / 2, headY - fh / 2, fw, fh);
    } catch {
      ctx.fillStyle = "#f6d4b4";
      ctx.fill();
    }
  } else {
    ctx.fillStyle = "#f6d4b4";
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = "#191b1d";
  ctx.beginPath();
  ctx.moveTo(-54 * S, headY - 25 * S);
  ctx.lineTo(-68 * S, headY - 51 * S);
  ctx.lineTo(-38 * S, headY - 40 * S);
  ctx.lineTo(-28 * S, headY - 61 * S);
  ctx.lineTo(-8 * S, headY - 42 * S);
  ctx.lineTo(10 * S, headY - 60 * S);
  ctx.lineTo(24 * S, headY - 38 * S);
  ctx.lineTo(51 * S, headY - 45 * S);
  ctx.lineTo(55 * S, headY - 19 * S);
  ctx.closePath();
  ctx.fill();
  for (const eye of [{ x: -22, rx: 20, ry: 25 }, { x: 18, rx: 28, ry: 31 }]) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#5b554d";
    ctx.lineWidth = Math.max(1.5, 3 * S);
    ctx.beginPath();
    ctx.ellipse(eye.x * S, headY - 13 * S, eye.rx * S, eye.ry * S, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc((eye.x + 2) * S, headY - 13 * S, 6.5 * S, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#80564a";
  ctx.lineWidth = Math.max(1, 2.1 * S);
  ctx.beginPath();
  ctx.moveTo(-19 * S, headY + 24 * S);
  ctx.quadraticCurveTo(12 * S, headY + 29 * S, 33 * S, headY + 13 * S);
  ctx.stroke();
}

function drawStickFace(
  ctx: CanvasRenderingContext2D,
  face: HTMLImageElement | null,
  S: number,
  headY: number,
  faceAspect = 1,
) {
  const headR = 24 * S;
  const rx = headR / Math.sqrt(clamp(faceAspect, 0.75, 1.6));
  const ry = headR * Math.sqrt(clamp(faceAspect, 0.75, 1.6));
  ctx.fillStyle = "#fffdf5";
  ctx.beginPath();
  ctx.ellipse(0, headY, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  if (face?.complete && face.naturalWidth > 0 && face.naturalHeight > 0) {
    ctx.save();
    ctx.clip();
    try {
      ctx.drawImage(face, -rx, headY - ry, rx * 2, ry * 2);
    } catch {}
    ctx.restore();
  }
  ctx.stroke();
  ctx.fillStyle = "#2a2a2a";
  ctx.beginPath();
  ctx.arc(-7 * S, headY - 4 * S, 2.4 * S, 0, Math.PI * 2);
  ctx.arc(8 * S, headY - 4 * S, 2.4 * S, 0, Math.PI * 2);
  ctx.fill();
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
  const progress = actionProgress(ch, renderTimeMs);
  const x = (ch.x - cam.cameraX) * sf + W / 2;
  const y = (ch.y - cam.cameraY) * sf + H / 2;
  const S = sf;
  const speed = Math.hypot(ch.vx, ch.vy);
  const moving = ["walk", "run", "walkTo", "runTo"].includes(ch.actionType) || speed > 45;
  const running = ["run", "runTo"].includes(ch.actionType) || speed > 520;
  const stride = moving ? Math.sin(progress * Math.PI * (running ? 9 : 6.2)) : 0;
  const airborne = ["jump", "jumpTo", "flip", "grapple", "zipline"].includes(ch.actionType) || Math.abs(ch.vy) > 40;
  const eliminated = ch.actionType === "eliminated";
  const dance = ch.actionType === "dance" ? Math.sin(progress * Math.PI * 7.2) : 0;
  const squash = !airborne && speed < 60 ? Math.sin(renderTimeMs * 0.006 + ch.id.length) * 0.018 : 0;
  const bob = !airborne ? (moving ? Math.abs(stride) * -4 : Math.sin(renderTimeMs * 0.003) * 2.5) : 0;
  const flipAngle = ch.actionType === "flip" ? progress * Math.PI * 2 : airborne ? clamp(ch.vy / 850, -0.55, 0.8) : 0;
  const hitJolt = eliminated ? Math.sin(progress * Math.PI * 10) * (1 - clamp(progress, 0, 1)) : 0;
  const poof = eliminated && progress > 0.72;

  ctx.save();
  ctx.globalAlpha = poof ? alpha * clamp(1 - (progress - 0.72) / 0.22, 0, 1) : alpha;
  ctx.translate(x + hitJolt * 16 * S, y + bob * S);
  ctx.scale(ch.facing * (1 + squash), 1 - squash);
  if (flipAngle || eliminated) {
    ctx.translate(0, -86 * S);
    ctx.rotate(eliminated ? lerp(0, Math.PI / 2.4, clamp((progress - 0.48) / 0.26, 0, 1)) : flipAngle);
    ctx.translate(0, 86 * S);
  }
  ctx.strokeStyle = ch.isHost ? "#8b2bd1" : "#27221f";
  ctx.fillStyle = "#f6d4b4";
  ctx.lineWidth = Math.max(1.5, 3.1 * S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const hipY = -61 * S;
  const shoulderY = -103 * S;
  const headY = -160 * S;
  const styled = ch.skin !== "stick";
  const jacked = ch.physique === "jacked";
  const legReach = airborne ? 0.38 : 1;
  const legLift = airborne ? 34 : 0;
  const armWave = -stride * 0.75 + dance * 0.8;
  const limb = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, endR: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(x2, y2, x3, y3);
    ctx.stroke();
    if (styled) {
      ctx.beginPath();
      ctx.ellipse(x3, y3, endR * 1.35, endR, -0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  };

  limb(-8 * S, hipY, (-24 + stride * 12) * S, (-34 - legLift * 0.2) * S, (-18 + stride * 37) * S * legReach, (-4 - legLift) * S, 8 * S);
  limb(8 * S, hipY, (24 - stride * 12) * S, (-34 - legLift * 0.2) * S, (18 - stride * 37) * S * legReach, (-4 - legLift) * S, 8 * S);

  ctx.fillStyle = ch.isHost ? "#efe0ff" : styled ? "#f4f1e8" : "transparent";
  if (jacked) {
    ctx.beginPath();
    ctx.moveTo(-28 * S, hipY);
    ctx.quadraticCurveTo(-54 * S, -87 * S, -25 * S, shoulderY - 7 * S);
    ctx.quadraticCurveTo(0, -122 * S, 25 * S, shoulderY - 7 * S);
    ctx.quadraticCurveTo(54 * S, -87 * S, 28 * S, hipY);
    ctx.closePath();
    if (styled) ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-14 * S, -82 * S);
    ctx.quadraticCurveTo(0, -70 * S, 14 * S, -82 * S);
    ctx.moveTo(0, -74 * S);
    ctx.lineTo(0, -41 * S);
    ctx.moveTo(-11 * S, -61 * S);
    ctx.lineTo(11 * S, -61 * S);
    ctx.moveTo(-10 * S, -51 * S);
    ctx.lineTo(10 * S, -51 * S);
    ctx.stroke();
  } else if (styled) {
    ctx.beginPath();
    ctx.moveTo(-20 * S, hipY);
    ctx.quadraticCurveTo(-25 * S, -92 * S, -17 * S, shoulderY);
    ctx.quadraticCurveTo(0, -124 * S, 17 * S, shoulderY);
    ctx.quadraticCurveTo(25 * S, -92 * S, 20 * S, hipY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(0, hipY);
    ctx.lineTo(0, shoulderY);
    ctx.stroke();
  }

  ctx.fillStyle = "#f6d4b4";
  const pull = ch.actionType === "pullUps" || ch.actionType === "pullups";
  const handY = (pull ? -190 : -62 + Math.abs(armWave) * 6) * S;
  limb(-13 * S, shoulderY + 8 * S, (-34 + armWave * 14) * S, -92 * S, (-40 + armWave * 28) * S, handY, jacked ? 12 * S : 9 * S);
  limb(13 * S, shoulderY + 8 * S, (34 - armWave * 14) * S, -92 * S, (40 - armWave * 28) * S, handY, jacked ? 12 * S : 9 * S);
  if (pull) {
    ctx.beginPath();
    ctx.moveTo(-68 * S, -198 * S);
    ctx.lineTo(68 * S, -198 * S);
    ctx.stroke();
  }

  if (styled) drawStyledFace(ctx, face, S, headY, 58 * S, 42 * S, ch.faceAspect);
  else drawStickFace(ctx, face, S, headY, ch.faceAspect);

  if (poof) {
    ctx.strokeStyle = "#2a2a2a";
    ctx.fillStyle = "rgba(255,253,245,0.9)";
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const r = (18 + i * 3) * S * clamp((progress - 0.72) / 0.18, 0, 1);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, -78 * S + Math.sin(a) * r * 0.55, (9 + (i % 3) * 4) * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (ch.name) {
    ctx.font = `700 ${Math.max(9, 13 * S)}px 'Caveat', monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = ch.isHost ? "#8b2bd1" : "#27221f";
    ctx.fillText(ch.name, 0, headY - 73 * S);
  }
  if (ch.emoji) {
    ctx.font = `${Math.max(18, 30 * S)}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillText(ch.emoji, 0, headY - 118 * S);
  }
  ctx.restore();
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
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#27221f";
  ctx.fillStyle = "#fffdf5";
  ctx.lineWidth = Math.max(1.5, 2.5 * sf);
  const handX = sx + event.shooter.facing * 48 * sf;
  const handY = sy - 104 * sf;
  ctx.translate(handX, handY);
  ctx.rotate(event.shooter.facing > 0 ? -0.12 : Math.PI + 0.12);
  ctx.beginPath();
  ctx.roundRect(0, -8 * sf, 46 * sf, 16 * sf, 5 * sf);
  ctx.moveTo(14 * sf, 8 * sf);
  ctx.lineTo(21 * sf, 25 * sf);
  ctx.moveTo(37 * sf, -9 * sf);
  ctx.lineTo(51 * sf, -16 * sf);
  ctx.stroke();
  ctx.restore();

  const shotStarts = [0.18, 0.36, 0.54];
  shotStarts.forEach((start, index) => {
    const shotT = clamp((t - start) / 0.12, 0, 1);
    if (shotT <= 0 || shotT >= 1) return;
    const ex = lerp(handX, tx, shotT);
    const ey = lerp(handY, ty - 95 * sf, shotT);
    ctx.save();
    ctx.strokeStyle = ["#9be7ff", "#f4b942", "#ff5e87"][index];
    ctx.setLineDash([8 * sf, 5 * sf]);
    ctx.lineWidth = Math.max(2, 4 * sf);
    ctx.beginPath();
    ctx.moveTo(handX, handY);
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
        const px = tx + Math.cos(a) * r;
        const py = ty - 95 * sf + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  });
}
