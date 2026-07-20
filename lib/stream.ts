export const STREAM_FPS = 30;
export const STREAM_CHANNEL_PREFIX = "stream";
export const MAX_GUESTS = 8;
export const GUEST_NAME_MAX_LENGTH = 16;
export const GUEST_EMOTES = ["🤔", "💡", "❗", "😂", "👋"] as const;
export const GUEST_VERBS = ["move", "grapple", "skateTo", "wallClimb", "zipline", "dance", "pullUps", "mirrorCheck", "sitAndWatch", "emote", "sign"] as const;
export const MAX_GUEST_SIGN_DATA_URL_BYTES = 150_000;
export const HOST_STREAM_SKIN = "stick" as const;
export const DEFAULT_STREAM_SKIN = "stick" as const;
export const STREAM_ACTION_TYPES = [
  "idle",
  "walk",
  "run",
  "walkTo",
  "runTo",
  "jump",
  "jumpTo",
  "flip",
  "grapple",
  "skateTo",
  "wallClimb",
  "zipline",
  "pointAt",
  "explainGesture",
  "dance",
  "pullUps",
  "pullups",
  "mirrorCheck",
  "sitAndWatch",
  "emote",
  "forceChoke",
  "eliminated",
] as const;

export type CharacterSkin = "stick" | "styled";
export type StreamActionType = (typeof STREAM_ACTION_TYPES)[number];
export type StreamSkinSource = "own-setting" | "presence" | "guest-skin-default" | "fallback";
export type StreamCharacterDebugRow = {
  id: string;
  isHost: boolean;
  skinPublished?: CharacterSkin;
  skinResolved: CharacterSkin;
  skinSource: StreamSkinSource;
  actionType: string;
  actionProgress: number;
  physique: "slim" | "jacked";
  facing?: 1 | -1;
  travelDx?: number;
  rotationDirection?: 1 | -1;
  construction?: Record<string, number | string | boolean>;
};

export type StreamBoardPose = Record<string, number | string | boolean | null | undefined>;

export function isCharacterSkin(value: unknown): value is CharacterSkin {
  return value === "stick" || value === "styled";
}

export function isStreamActionType(value: unknown): value is StreamActionType {
  return typeof value === "string" && (STREAM_ACTION_TYPES as readonly string[]).includes(value);
}

export function resolveStreamSkin(
  published: unknown,
  options: {
    isHost: boolean;
    sourceIfPublished?: StreamSkinSource;
    guestSkinOverride?: CharacterSkin;
    warnContext?: string;
  },
): { skin: CharacterSkin; source: StreamSkinSource; published?: CharacterSkin } {
  const skinPublished = isCharacterSkin(published) ? published : undefined;
  if (options.isHost) {
    if (skinPublished && skinPublished !== HOST_STREAM_SKIN && typeof console !== "undefined") {
      console.warn("[stream:state] host skin must resolve to stick", { context: options.warnContext, published: skinPublished });
    }
    if (!skinPublished && typeof console !== "undefined") {
      console.warn("[stream:state] missing host skin; falling back to stick", { context: options.warnContext });
    }
    return { skin: HOST_STREAM_SKIN, source: skinPublished ? (options.sourceIfPublished ?? "presence") : "fallback", published: skinPublished };
  }
  if (options.guestSkinOverride) {
    return { skin: options.guestSkinOverride, source: "guest-skin-default", published: skinPublished };
  }
  if (skinPublished) return { skin: skinPublished, source: options.sourceIfPublished ?? "presence", published: skinPublished };
  if (typeof console !== "undefined") {
    console.warn("[stream:state] missing/unknown guest skin; falling back to stick", { context: options.warnContext, published });
  }
  return { skin: DEFAULT_STREAM_SKIN, source: "fallback", published: skinPublished };
}

export type StreamCamera = {
  cameraX: number;
  cameraY: number;
  boardZoom: number;
};

export type StreamClip = {
  id: string;
  type: "image" | "video" | "pan" | "characterZoom";
  name: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  videoBadge?: boolean;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  layer?: number;
};

export type StreamAnnotation = {
  id: string;
  type: "text" | "arrow" | "circle" | "highlight" | "pen" | "emoji";
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  color: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  strokeWidth?: number;
  arrowStartX?: number;
  arrowStartY?: number;
  arrowEndX?: number;
  arrowEndY?: number;
  highlightStyle?: "rect" | "underline" | "curlyBrace";
  points?: Array<{ x: number; y: number }>;
  emoji?: string;
};

export type StreamCharacterSnapshot = {
  id: "c1" | "c2";
  enabled: boolean;
  name?: string;
  skin?: "stick" | "styled";
  physique?: "slim" | "jacked";
  faceDataUrl?: string;
  faceAspect?: number;
};

export type StreamCharacterFrame = {
  id: "c1" | "c2";
  enabled: boolean;
  x: number;
  y: number;
  facing: 1 | -1;
  physique: "slim" | "jacked";
  skin?: "stick" | "styled";
  actionType: string;
  progress: number;
  actionStartTime?: number;
  actionDuration?: number;
  velocity?: { x: number; y: number };
  actionParams?: Record<string, number | string | boolean | null | undefined>;
  boardPose?: StreamBoardPose;
  emoji?: string;
  emojiAlpha?: number;
};

export type SpawnDoor = { x: number; y: number };
export type StreamCrater = { clipId: string; cx: number; cy: number; r: number; seed: number };
export type StreamBazookaFireMessage = { kind:"bazooka_fire";sequenceType:"bazookaFire";streamId:string;sessionId:string;sentAt:number;startTime:number;from:{x:number;y:number};target:{x:number;y:number};seed:number };
export type StreamRepairBoardMessage = { kind:"repair_board";streamId:string;sessionId:string;sentAt:number };

export type StreamParticipantPresence = {
  role: "host" | "viewer" | "guest";
  isHost?: boolean;
  guestId?: string;
  name?: string;
  faceDataUrl?: string;
  skin?: CharacterSkin;
  guestSkin?: CharacterSkin;
  physique?: "slim" | "jacked";
  signDataUrl?: string;
  joinedAt: number;
};

export type GuestCharacterFrame = {
  kind: "guest-state";
  seq?: number;
  streamId: string;
  sessionId: string;
  sentAt: number;
  guestId: string;
  name: string;
  position: { x: number; y: number };
  velocity?: { x: number; y: number };
  facing: 1 | -1;
  actionType: "idle" | "walk" | "run" | "jump" | "flip" | "grapple" | "skateTo" | "wallClimb" | "zipline" | "dance" | "pullUps" | "mirrorCheck" | "sitAndWatch" | "emote" | "forceChoke" | "eliminated";
  actionProgress: number;
  actionStartTime?: number;
  actionDuration?: number;
  actionParams?: Record<string, number | string | boolean | null | undefined>;
  boardPose?: StreamBoardPose;
  skin?: "stick" | "styled";
  physique?: "slim" | "jacked";
  signDataUrl?: string;
  signActive?: boolean;
  receivedAt?: number;
  emote?: string;
};

export type StreamKickMessage = {
  kind: "kick";
  streamId: string;
  sessionId: string;
  guestId: string;
  sentAt: number;
  reason?: "instant" | "elimination_tommygun";
  hostName?: string;
};

export type StreamEliminationMessage = {
  kind: "elimination";
  sequenceType: "elimination_tommygun";
  streamId: string;
  sessionId: string;
  sentAt: number;
  startTime: number;
  duration: number;
  targetGuestId: string;
  hostName: string;
  seed: number;
  shooter: { x: number; y: number; facing: 1 | -1 };
  target: { x: number; y: number };
};

export type StreamShotFiredMessage = {
  kind: "shot_fired";
  streamId: string;
  sessionId: string;
  sentAt: number;
  shotId: string;
  origin: { x: number; y: number };
  dir: { x: number; y: number };
  seed: number;
};

export type StreamWeaponHitMessage = {
  kind: "hit";
  streamId: string;
  sessionId: string;
  sentAt: number;
  guestId: string;
  count: number;
  origin: { x: number; y: number };
  dir: { x: number; y: number };
};

export type StreamChokeMessage = {
  kind: "choke_state";
  streamId: string;
  sessionId: string;
  sentAt: number;
  targetGuestId: string;
  phase: "hold" | "drop" | "end";
  holder: { x: number; y: number; facing: 1 | -1 };
  position: { x: number; y: number };
  progress: number;
};

export type StreamSnapshotMessage = {
  kind: "snapshot";
  streamId: string;
  sessionId: string;
  sentAt: number;
  board: { width: number; height: number; backgroundColor: string };
  spawnDoor?: SpawnDoor | null;
  clips: StreamClip[];
  annotations: StreamAnnotation[];
  characters: StreamCharacterSnapshot[];
  craters?: StreamCrater[];
};

export type StreamFrameMessage = {
  kind: "frame";
  seq?: number;
  streamId: string;
  sessionId: string;
  sentAt: number;
  camera: StreamCamera;
  guestSkin?: CharacterSkin;
  weapon?: {
    armed: boolean;
    kind?: "tommy" | "bazooka";
    aim?: { x: number; y: number };
    shooter?: { x: number; y: number; facing: 1 | -1 };
  };
  characters: StreamCharacterFrame[];
};

export type StreamEndMessage = {
  kind: "session-end";
  streamId: string;
  sessionId: string;
  sentAt: number;
};

export type StreamMessage = StreamSnapshotMessage | StreamFrameMessage | StreamEndMessage | StreamKickMessage | StreamEliminationMessage | StreamShotFiredMessage | StreamWeaponHitMessage | StreamChokeMessage | StreamBazookaFireMessage | StreamRepairBoardMessage;

export function streamChannelName(streamId: string): string {
  return `${STREAM_CHANNEL_PREFIX}:${streamId}`;
}
