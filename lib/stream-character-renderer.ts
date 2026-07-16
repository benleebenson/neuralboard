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
  const moving = ch.actionType === "walk" || ch.actionType === "run" || ch.actionType === "walkTo";
  const stride = moving ? Math.sin(ch.progress * Math.PI * 2) : 0;
  const jumping = ch.actionType === "jump" || ["jumpTo", "flip", "grapple", "zipline"].includes(ch.actionType);
  const air = jumping ? Math.sin(Math.min(1, ch.progress) * Math.PI) * 36 * S : 0;
  const headR = 21 * S;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = ch.isHost ? "#8b2bd1" : "#27221f";
  ctx.fillStyle = "#f6d4b4";
  ctx.lineWidth = Math.max(1.5, 3.2 * S);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(x, y - air);
  ctx.scale(ch.facing, 1);
  const hipY = -58 * S, shoulderY = -101 * S, headY = -151 * S;
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(side * 8 * S, hipY); ctx.quadraticCurveTo(side * (20 + stride * 8) * S, -30 * S, side * (18 + stride * 25) * S, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(side * 13 * S, shoulderY + 8 * S); ctx.quadraticCurveTo(side * (30 - stride * 10) * S, -84 * S, side * (38 - stride * 22) * S, -58 * S); ctx.stroke();
  }
  ctx.fillStyle = ch.isHost ? "#efe0ff" : "#f4f1e8";
  ctx.beginPath(); ctx.moveTo(-19 * S, hipY); ctx.quadraticCurveTo(-24 * S, -90 * S, -16 * S, shoulderY); ctx.quadraticCurveTo(0, -119 * S, 16 * S, shoulderY); ctx.quadraticCurveTo(24 * S, -90 * S, 19 * S, hipY); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.ellipse(0, headY, headR, headR * (ch.faceAspect ?? 1), 0, 0, Math.PI * 2); ctx.clip();
  if (face?.complete && face.naturalWidth > 0) ctx.drawImage(face, -headR, headY - headR * (ch.faceAspect ?? 1), headR * 2, headR * 2 * (ch.faceAspect ?? 1)); else { ctx.fillStyle = "#f6d4b4"; ctx.fill(); }
  ctx.restore(); ctx.beginPath(); ctx.ellipse(0, headY, headR, headR * (ch.faceAspect ?? 1), 0, 0, Math.PI * 2); ctx.stroke();
  ctx.scale(ch.facing, 1);
  if (ch.name) { ctx.font = `700 ${Math.max(9, 13 * S)}px 'Caveat', monospace`; ctx.textAlign = "center"; ctx.fillStyle = ch.isHost ? "#8b2bd1" : "#27221f"; ctx.fillText(ch.name, 0, headY - headR * 1.65); }
  if (ch.emoji) { ctx.font = `${Math.max(18, 30 * S)}px system-ui`; ctx.textAlign = "center"; ctx.fillText(ch.emoji, 0, headY - headR * 2.8); }
  ctx.restore();
}
