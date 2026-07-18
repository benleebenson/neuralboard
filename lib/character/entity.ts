import {
  drawSharedStreamCharacter,
  guestCharacterForRender,
  hostCharacterForRender,
  type SharedCharacter,
} from "./renderer";
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
  readonly id: string;
  readonly input: CharacterInputAdapter;
  identity: CharacterEntityIdentity;
  private shared: SharedCharacter | null = null;
  private guestFrame: GuestCharacterFrame | null = null;
  private hostFrame: StreamCharacterFrame | null = null;
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
    this.shared = hostCharacterForRender({ ...frame, skin: this.identity.skin, physique: this.identity.physique }, this.identity.faceAspect, clockOffsetMs);
  }

  setGuestFrame(frame: GuestCharacterFrame, clockOffsetMs = 0, guestSkinOverride?: CharacterSkin) {
    this.guestFrame = frame;
    this.hostFrame = null;
    this.shared = guestCharacterForRender({ ...frame, skin: this.identity.skin, physique: this.identity.physique }, clockOffsetMs, { guestSkinOverride });
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
    if (!this.shared) return;
    drawSharedStreamCharacter(
      args.ctx,
      this.shared,
      args.face ?? null,
      args.sign ?? null,
      args.cam,
      args.sf,
      args.width,
      args.height,
      args.alpha ?? 1,
      args.renderTimeMs ?? Date.now(),
    );
  }
}

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
