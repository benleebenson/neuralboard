import type { GuestCharacterFrame, StreamCamera, StreamCharacterFrame } from "./stream";

export type SharedCharacter = {
  id: string;
  name?: string;
  isHost?: boolean;
  enabled: boolean;
  x: number;
  y: number;
  facing: 1 | -1;
  actionType: string;
  progress: number;
  emoji?: string;
  faceAspect?: number;
};

export function hostCharacterForRender(frame: StreamCharacterFrame, faceAspect = 1): SharedCharacter {
  return { id: frame.id, name: frame.id === "c1" ? "HOST" : "HOST 2", isHost: true, enabled: frame.enabled, x: frame.x, y: frame.y, facing: frame.facing, actionType: frame.actionType, progress: frame.progress, emoji: frame.emoji, faceAspect };
}

export function guestCharacterForRender(frame: GuestCharacterFrame): SharedCharacter {
  return { id: frame.guestId, name: frame.name, enabled: true, x: frame.position.x, y: frame.position.y, facing: frame.facing, actionType: frame.actionType, progress: frame.actionProgress, emoji: frame.emote };
}

export function drawSharedStreamCharacter(ctx: CanvasRenderingContext2D, ch: SharedCharacter, face: HTMLImageElement | null, cam: StreamCamera, sf: number, W: number, H: number, alpha = 1) {
  if (!ch.enabled) return;
  const x = (ch.x - cam.cameraX) * sf + W / 2;
  const y = (ch.y - cam.cameraY) * sf + H / 2;
  const S = sf;
  const moving = ch.actionType === "walk" || ch.actionType === "run" || ch.actionType === "walkTo" || ch.actionType === "runTo";
  const stride = moving ? Math.sin(ch.progress * Math.PI * 2.6) : 0;
  const jumping = ch.actionType === "jump" || ["jumpTo", "flip", "grapple", "zipline"].includes(ch.actionType);
  const dance = ch.actionType === "dance" ? Math.sin(ch.progress * Math.PI * 8) : 0;
  const air = jumping ? Math.sin(Math.min(1, ch.progress) * Math.PI) * 38 * S : 0;
  const headRX = 58 * S;
  const headRY = 42 * S;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = ch.isHost ? "#8b2bd1" : "#27221f";
  ctx.fillStyle = "#f6d4b4";
  ctx.lineWidth = Math.max(1.5, 3.1 * S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(x, y - air);
  ctx.scale(ch.facing, 1);

  const hipY = -61 * S, shoulderY = -103 * S, headY = -160 * S;
  const actionWave = ch.actionType === "dance" ? dance * 0.65 : 0;
  const limb = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, endR: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(x2, y2, x3, y3); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x3, y3, endR * 1.35, endR, -0.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };

  const tuck = jumping ? 0.35 : 0;
  limb(-8 * S, hipY, (-24 + stride * 12) * S, (-34 - tuck * 10) * S, (-18 + stride * 37) * S * (1 - tuck * 0.45), (-4 - tuck * 34) * S, 8 * S);
  limb(8 * S, hipY, (24 - stride * 12) * S, (-34 - tuck * 10) * S, (18 - stride * 37) * S * (1 - tuck * 0.45), (-4 - tuck * 34) * S, 8 * S);

  ctx.fillStyle = ch.isHost ? "#efe0ff" : "#f4f1e8";
  ctx.beginPath();
  ctx.moveTo(-20 * S, hipY);
  ctx.quadraticCurveTo(-25 * S, -92 * S, -17 * S, shoulderY);
  ctx.quadraticCurveTo(0, -124 * S, 17 * S, shoulderY);
  ctx.quadraticCurveTo(25 * S, -92 * S, 20 * S, hipY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f6d4b4";
  const armSwing = -stride * 0.78 + actionWave;
  const pull = ch.actionType === "pullUps" || ch.actionType === "pullups";
  limb(-13 * S, shoulderY + 8 * S, (-34 + armSwing * 14) * S, -92 * S, (-40 + armSwing * 28) * S, (pull ? -190 : -62 + Math.abs(armSwing) * 6) * S, 9 * S);
  limb(13 * S, shoulderY + 8 * S, (34 - armSwing * 14) * S, -92 * S, (40 - armSwing * 28) * S, (pull ? -190 : -62 + Math.abs(armSwing) * 6) * S, 9 * S);

  ctx.fillStyle = "#f6d4b4";
  ctx.beginPath();
  ctx.ellipse(0, headY, headRX, headRY, -0.015, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save(); ctx.beginPath(); ctx.ellipse(0, headY, headRX * 0.93, headRY * 0.93 * (ch.faceAspect ?? 1), 0, 0, Math.PI * 2); ctx.clip();
  if (face?.complete && face.naturalWidth > 0 && face.naturalHeight > 0) {
    try {
      const fw = headRX * 1.86;
      const fh = fw * (ch.faceAspect ?? 1);
      ctx.drawImage(face, -fw / 2, headY - fh / 2, fw, fh);
    } catch {
      ctx.fillStyle = "#f6d4b4"; ctx.fill();
    }
  } else { ctx.fillStyle = "#f6d4b4"; ctx.fill(); }
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
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#5b554d"; ctx.lineWidth = Math.max(1.5, 3 * S);
    ctx.beginPath(); ctx.ellipse(eye.x * S, headY - 13 * S, eye.rx * S, eye.ry * S, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc((eye.x + 2) * S, headY - 13 * S, 6.5 * S, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "#80564a"; ctx.lineWidth = Math.max(1, 2.1 * S); ctx.beginPath(); ctx.moveTo(-19 * S, headY + 24 * S); ctx.quadraticCurveTo(12 * S, headY + 29 * S, 33 * S, headY + 13 * S); ctx.stroke();

  if (ch.name) { ctx.font = `700 ${Math.max(9, 13 * S)}px 'Caveat', monospace`; ctx.textAlign = "center"; ctx.fillStyle = ch.isHost ? "#8b2bd1" : "#27221f"; ctx.fillText(ch.name, 0, headY - headRY * 1.75); }
  if (ch.emoji) { ctx.font = `${Math.max(18, 30 * S)}px system-ui`; ctx.textAlign = "center"; ctx.fillText(ch.emoji, 0, headY - headRY * 2.8); }
  ctx.restore();
}
