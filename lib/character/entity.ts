import { drawBoardCharacterToCanvas, type BoardCharPoseResult } from "./board-renderer";
import { FORWARD_TUCK_FLIP_KEYFRAMES, sampleAnimation, type Pose } from "../characterAnimations";
import {
  type CharacterSkin,
  type GuestCharacterFrame,
  type StreamCamera,
  type StreamCharacterFrame,
  type StreamFrameMessage,
  type StreamParticipantPresence,
} from "../stream";

export const CHARACTER_ENTITY_PACKET_VERSION = 1;

export type CharacterEntityIdentity = {
  id: string;
  isHost: boolean;
  name?: string;
  skin: CharacterSkin;
  physique: "slim" | "jacked";
  faceDataUrl?: string;
  faceAspect?: number;
};

export type CharacterWeaponState = {
  armed: boolean;
  aim?: { x: number; y: number };
  shooter?: { x: number; y: number; facing: 1 | -1 };
};

export type CharacterEntityPacket = {
  kind: "character-state";
  version: typeof CHARACTER_ENTITY_PACKET_VERSION;
  streamId: string;
  sessionId: string;
  participantId: string;
  seq: number;
  timestamp: number;
  identity?: CharacterEntityIdentity;
  character: StreamCharacterFrame | GuestCharacterFrame;
  weapon?: CharacterWeaponState;
};

export type CharacterEntityDrawContext = {
  ctx: CanvasRenderingContext2D;
  cam: StreamCamera;
  sf: number;
  width: number;
  height: number;
  renderTimeMs?: number;
  face?: HTMLImageElement | null;
  sign?: HTMLImageElement | null;
  alpha?: number;
  clockOffsetMs?: number;
  guestSkinOverride?: CharacterSkin;
};

export interface CharacterInputAdapter {
  kind: "local" | "network";
}

export class LocalInputAdapter implements CharacterInputAdapter {
  readonly kind = "local" as const;
  constructor(readonly verbs: readonly string[]) {}
}

export class NetworkAdapter implements CharacterInputAdapter {
  readonly kind = "network" as const;
}

export class CharacterEntity {
  static drawBoardCharacterToCanvas = drawBoardCharacterToCanvas;

  readonly id: string;
  readonly input: CharacterInputAdapter;
  identity: CharacterEntityIdentity;
  pose: BoardCharPoseResult | null = null;
  guestFrame: GuestCharacterFrame | null = null;
  hostFrame: StreamCharacterFrame | null = null;
  private clockOffsetMs = 0;
  private guestSkinOverride?: CharacterSkin;
  private lastSeq = -1;
  weapon: CharacterWeaponState = { armed: false };

  constructor(identity: CharacterEntityIdentity, input: CharacterInputAdapter = new NetworkAdapter()) {
    this.id = identity.id;
    this.identity = identity;
    this.input = input;
  }

  get seq() {
    return this.lastSeq;
  }

  setHostFrame(frame: StreamCharacterFrame, clockOffsetMs = 0) {
    this.hostFrame = frame;
    this.guestFrame = null;
    this.clockOffsetMs = clockOffsetMs;
    this.pose = entityPoseFromHostFrame(frame, this.identity, clockOffsetMs);
  }

  setGuestFrame(frame: GuestCharacterFrame, clockOffsetMs = 0, guestSkinOverride?: CharacterSkin) {
    this.guestFrame = frame;
    this.hostFrame = null;
    this.clockOffsetMs = clockOffsetMs;
    this.guestSkinOverride = guestSkinOverride;
    this.pose = entityPoseFromGuestFrame(frame, this.identity, clockOffsetMs);
  }

  applyPacket(packet: CharacterEntityPacket, options?: { clockOffsetMs?: number; guestSkinOverride?: CharacterSkin }): boolean {
    if (packet.version !== CHARACTER_ENTITY_PACKET_VERSION) return false;
    if (packet.seq <= this.lastSeq) return false;
    this.lastSeq = packet.seq;
    if (packet.identity) this.identity = packet.identity;
    if (packet.weapon) this.weapon = packet.weapon;
    const character = packet.character;
    if ("guestId" in character) this.setGuestFrame(character, options?.clockOffsetMs ?? 0, options?.guestSkinOverride);
    else this.setHostFrame(character, options?.clockOffsetMs ?? 0);
    return true;
  }

  draw(args: CharacterEntityDrawContext) {
    if (!this.pose) return;
    const face = imageReady(args.face) ? args.face : null;
    args.ctx.save();
    args.ctx.globalAlpha *= args.alpha ?? 1;
    drawBoardCharacterToCanvas(
      args.ctx,
      (args.renderTimeMs ?? Date.now()) / 1000,
      [],
      true,
      args.cam,
      args.sf,
      args.width,
      args.height,
      this.pose.boardX ?? 0,
      this.pose.boardY ?? 0,
      [],
      -Infinity,
      {},
      face ? { image: face, aspect: this.identity.faceAspect ?? 1 } : null,
      this.identity.skin,
      this.pose,
      {
        evalCharAtTime: () => this.pose ?? standingBoardPose(0, 0, 1, 0),
        physiqueAt: () => this.identity.physique,
      },
    );
    drawEntitySign(args.ctx, this, args.sign ?? null, args.cam, args.sf, args.width, args.height, args.renderTimeMs ?? Date.now());
    drawEntityLabel(args.ctx, this, args.cam, args.sf, args.width, args.height);
    args.ctx.restore();
  }
}

function imageReady(image?: HTMLImageElement | null): image is HTMLImageElement {
  return !!image && image.complete && image.naturalWidth > 0;
}

function actionProgressFromFrame(
  progress: number,
  actionStartTime: number | undefined,
  actionDuration: number | undefined,
  clockOffsetMs: number,
  renderTimeMs = Date.now(),
) {
  if (actionStartTime !== undefined && actionDuration && actionDuration > 0) {
    const senderNow = renderTimeMs - clockOffsetMs;
    return clamp((senderNow - actionStartTime) / (actionDuration * 1000), 0, 1.4);
  }
  return progress;
}

function entityPoseFromHostFrame(frame: StreamCharacterFrame, identity: CharacterEntityIdentity, clockOffsetMs = 0): BoardCharPoseResult {
  if (frame.boardPose) return { ...frame.boardPose };
  return streamPoseFallback({
    x: frame.x,
    y: frame.y,
    vx: frame.velocity?.x ?? 0,
    vy: frame.velocity?.y ?? 0,
    facing: frame.facing,
    actionType: frame.actionType,
    progress: actionProgressFromFrame(frame.progress, frame.actionStartTime, frame.actionDuration, clockOffsetMs),
    emoji: frame.emoji,
    physique: frame.physique ?? identity.physique,
  });
}

function entityPoseFromGuestFrame(frame: GuestCharacterFrame, identity: CharacterEntityIdentity, clockOffsetMs = 0): BoardCharPoseResult {
  if (frame.boardPose) return { ...frame.boardPose };
  return streamPoseFallback({
    x: frame.position.x,
    y: frame.position.y,
    vx: frame.velocity?.x ?? 0,
    vy: frame.velocity?.y ?? 0,
    facing: frame.facing,
    actionType: frame.actionType,
    progress: actionProgressFromFrame(frame.actionProgress, frame.actionStartTime, frame.actionDuration, clockOffsetMs),
    emoji: frame.emote,
    physique: frame.physique ?? identity.physique,
    signActive: frame.signActive,
  });
}

function streamPoseFallback(args: {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  actionType: string;
  progress: number;
  emoji?: string;
  physique: "slim" | "jacked";
  signActive?: boolean;
}): BoardCharPoseResult {
  const p = clamp(args.progress, 0, 1.4);
  const pose = standingBoardPose(args.x, args.y, args.facing, p * Math.PI * 2);
  const moving = ["walk", "run", "walkTo", "runTo"].includes(args.actionType) || Math.abs(args.vx) > 45;
  if (moving) {
    const run = args.actionType === "run" || args.actionType === "runTo" || Math.abs(args.vx) > 520;
    const phase = p * Math.PI * 2;
    const swing = run ? 0.82 : 0.56;
    pose.headBob = -Math.abs(Math.sin(phase)) * (run ? 5 : 2.5);
    pose.bodyLean = (run ? 0.16 : 0.055) * args.facing;
    pose.leftLegA = Math.sin(phase) * swing;
    pose.rightLegA = Math.sin(phase + Math.PI) * swing;
    pose.leftArmA = Math.sin(phase + Math.PI) * (run ? 0.62 : 0.4);
    pose.rightArmA = Math.sin(phase) * (run ? 0.62 : 0.4);
    pose.leftForeA = 0.1;
    pose.rightForeA = -0.1;
  }
  if (["jump", "jumpTo", "grapple", "zipline", "wallClimb"].includes(args.actionType)) {
    pose.airY = -150 * 4 * Math.min(1, p) * (1 - Math.min(1, p));
    pose.bodyLean = 0.08 * args.facing;
    pose.leftLegA = p < 0.7 ? -0.5 : 0.25;
    pose.rightLegA = p < 0.7 ? -0.42 : 0.15;
    pose.leftArmA = p < 0.7 ? -0.45 : 0.35;
    pose.rightArmA = p < 0.7 ? -0.45 : -0.35;
    pose.leftForeA = p < 0.7 ? -0.2 : 0.05;
    pose.rightForeA = p < 0.7 ? -0.2 : -0.05;
    if (args.actionType === "grapple" || args.actionType === "zipline") {
      pose.grappleAnchorBX = args.x - args.facing * 260;
      pose.grappleAnchorBY = args.y - 320;
      pose.grappleRopeAlpha = 1;
      pose.grappleTaut = true;
    }
  }
  if (args.actionType === "flip" || args.actionType === "eliminated") {
    const flipPose = sampleAnimation({ id: "entity-fallback-flip", name: "flip", keyframes: FORWARD_TUCK_FLIP_KEYFRAMES, loop: false, createdAt: "fallback" }, Math.min(1, p));
    applyPose(pose, flipPose, true);
    if (args.actionType === "eliminated") pose.spinAngle = p * Math.PI * 7.5;
  }
  if (args.actionType === "dance") {
    const phase = p * Math.PI * 2;
    const hipWave = Math.sin(phase);
    const hit = Math.pow(Math.abs(Math.sin(phase)), 1.7);
    const hipOffset = hipWave * 14;
    pose.boardX = args.x + hipOffset * args.facing;
    pose.headBob = -hit * 3;
    pose.bodyLean = 0.12 - hipWave * 0.1;
    pose.leftLegA = 0.46;
    pose.rightLegA = -0.46;
    pose.leftShinA = 0.18;
    pose.rightShinA = -0.18;
    pose.leftArmA = 0.72 - hipWave * 0.28;
    pose.rightArmA = -0.72 - hipWave * 0.28;
    pose.leftForeA = 1.02 - hipWave * 0.18;
    pose.rightForeA = -1.02 - hipWave * 0.18;
    pose.danceFootPlant = true;
    pose.danceHipOffset = hipOffset;
    pose.danceMotionAlpha = Math.max(0, (Math.abs(hipWave) - 0.58) / 0.42);
  }
  if (args.actionType === "pullUps") {
    pose.airY = -40 - Math.sin(Math.min(1, p) * Math.PI * 6) * 45;
    pose.pullUpBarAlpha = 1;
    pose.pullUpBarBX = args.x;
    pose.pullUpBarBY = args.y;
    pose.leftLegA = 0.08;
    pose.rightLegA = -0.08;
    pose.leftShinA = -0.25;
    pose.rightShinA = 0.25;
    pose.leftArmA = -0.85;
    pose.rightArmA = 0.85;
    pose.leftForeA = -0.35;
    pose.rightForeA = 0.35;
  }
  if (args.actionType === "mirrorCheck") {
    pose.mirrorAlpha = 1;
    pose.mirrorBX = args.x + args.facing * 140;
    pose.mirrorBY = args.y;
    pose.mirrorFacing = args.facing;
    if (p > 0.55) {
      pose.leftArmA = 1.18;
      pose.rightArmA = -1.18;
      pose.leftForeA = 2.15;
      pose.rightForeA = -2.15;
      pose.physiquePulse = 1;
    }
  }
  if (args.actionType === "sitAndWatch") {
    pose.sitSeated = p > 0.3 && p < 0.9;
    pose.popcornAlpha = pose.sitSeated ? 1 : 0;
    pose.popcornX = 16;
    pose.popcornY = 8;
    if (pose.sitSeated) {
      pose.boardY = args.y + 76;
      pose.leftLegA = 1.08;
      pose.rightLegA = -1.02;
      pose.leftShinA = -0.88;
      pose.rightShinA = 0.82;
    }
  }
  if (args.actionType === "emote" || args.actionType === "forceChoke") {
    if (args.actionType === "emote") {
      pose.emojiText = args.emoji;
      pose.emojiAlpha = p <= 0.2 ? p / 0.2 : p <= 0.8 ? 1 : Math.max(0, 1 - (p - 0.8) / 0.2);
      pose.headTilt = 0.15;
      pose.rightArmA = -0.66;
      pose.rightForeA = -1.35;
    } else {
      pose.airY = -48 + Math.sin(p * Math.PI * 10) * 4;
      pose.surpriseAlpha = 0.6;
      pose.leftArmA = 0.72;
      pose.rightArmA = -0.72;
      pose.leftForeA = 1.1;
      pose.rightForeA = -1.1;
    }
  }
  if (args.signActive) {
    pose.leftArmA = 1.05;
    pose.rightArmA = -1.05;
    pose.leftForeA = 0.65;
    pose.rightForeA = -0.65;
  }
  return pose;
}

function standingBoardPose(boardX: number, boardY: number, facing: 1 | -1, time: number): BoardCharPoseResult {
  return {
    boardX,
    boardY,
    facing,
    headBob: Math.sin(time * 2) * 2,
    bodyLean: 0,
    headTilt: 0,
    leftLegA: 0.12,
    rightLegA: -0.12,
    leftArmA: 0.25,
    rightArmA: -0.25,
    leftForeA: 0.18,
    rightForeA: -0.18,
    airY: 0,
  };
}

function applyPose(base: BoardCharPoseResult, pose: Pose | null, addSpin = false) {
  if (!pose) return;
  base.headBob = pose.headBob;
  base.bodyLean = pose.bodyLean;
  base.headTilt = pose.headTilt;
  base.spinAngle = (base.spinAngle ?? 0) + (addSpin ? pose.poseRotation * base.facing : 0);
  base.leftLegA = pose.leftLegA;
  base.rightLegA = pose.rightLegA;
  base.leftShinA = pose.leftShinA;
  base.rightShinA = pose.rightShinA;
  base.leftArmA = pose.leftArmA;
  base.rightArmA = pose.rightArmA;
  base.leftForeA = pose.leftForeA;
  base.rightForeA = pose.rightForeA;
  base.airY = (base.airY ?? 0) + pose.airborneY;
}

function drawEntitySign(
  ctx: CanvasRenderingContext2D,
  entity: CharacterEntity,
  sign: HTMLImageElement | null,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  renderTimeMs: number,
) {
  if (!imageReady(sign) || !entity.guestFrame?.signActive || !entity.pose) return;
  const sx = (entity.pose.boardX - cam.cameraX) * sf + W / 2;
  const sy = (entity.pose.boardY - cam.cameraY) * sf + H / 2;
  const sway = Math.sin(renderTimeMs / 420 + entity.id.length) * 4 * sf;
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

function drawEntityLabel(ctx: CanvasRenderingContext2D, entity: CharacterEntity, cam: StreamCamera, sf: number, W: number, H: number) {
  if (!entity.identity.name || !entity.pose) return;
  const sx = (entity.pose.boardX - cam.cameraX) * sf + W / 2;
  const sy = (entity.pose.boardY - cam.cameraY) * sf + H / 2;
  ctx.save();
  ctx.font = `700 ${Math.max(9, 13 * sf)}px 'Caveat', monospace`;
  ctx.textAlign = "center";
  ctx.fillStyle = entity.identity.isHost ? "#8b2bd1" : "#27221f";
  ctx.fillText(entity.identity.name, sx, sy - 230 * sf);
  ctx.restore();
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function identityFromPresence(p: StreamParticipantPresence, fallbackId: string): CharacterEntityIdentity {
  return {
    id: p.guestId ?? fallbackId,
    isHost: p.role === "host" || !!p.isHost,
    name: p.name,
    skin: p.skin ?? "stick",
    physique: p.physique ?? "slim",
    faceDataUrl: p.faceDataUrl,
  };
}

export function packetFromGuestFrame(args: {
  streamId: string;
  sessionId: string;
  seq: number;
  frame: GuestCharacterFrame;
  identity?: CharacterEntityIdentity;
}): CharacterEntityPacket {
  return {
    kind: "character-state",
    version: CHARACTER_ENTITY_PACKET_VERSION,
    streamId: args.streamId,
    sessionId: args.sessionId,
    participantId: args.frame.guestId,
    seq: args.seq,
    timestamp: args.frame.sentAt,
    identity: args.identity,
    character: args.frame,
  };
}

export function packetsFromHostFrame(frame: StreamFrameMessage, seqBase: number): CharacterEntityPacket[] {
  return frame.characters.filter((ch) => ch.enabled).map((ch, index) => ({
    kind: "character-state" as const,
    version: CHARACTER_ENTITY_PACKET_VERSION,
    streamId: frame.streamId,
    sessionId: frame.sessionId,
    participantId: ch.id,
    seq: seqBase + index,
    timestamp: frame.sentAt,
    identity: {
      id: ch.id,
      isHost: true,
      name: ch.id === "c1" ? "HOST" : "HOST 2",
      skin: ch.skin ?? "stick",
      physique: ch.physique,
    },
    character: ch,
    weapon: frame.weapon,
  }));
}
