export const STREAM_FPS = 30;
export const STREAM_CHANNEL_PREFIX = "stream";
export const MAX_GUESTS = 8;
export const GUEST_NAME_MAX_LENGTH = 16;
export const GUEST_EMOTES = ["🤔", "💡", "❗", "😂", "👋"] as const;
export const GUEST_VERBS = ["walk", "run", "jump", "flip", "dance", "emote"] as const;

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
  emoji?: string;
  emojiAlpha?: number;
};

export type SpawnDoor = { x: number; y: number };

export type StreamParticipantPresence = {
  role: "host" | "viewer" | "guest";
  guestId?: string;
  name?: string;
  faceDataUrl?: string;
  skin?: "stick" | "styled";
  physique?: "slim" | "jacked";
  joinedAt: number;
};

export type GuestCharacterFrame = {
  kind: "guest-state";
  streamId: string;
  sessionId: string;
  sentAt: number;
  guestId: string;
  name: string;
  position: { x: number; y: number };
  velocity?: { x: number; y: number };
  facing: 1 | -1;
  actionType: "idle" | "walk" | "run" | "jump" | "flip" | "dance" | "emote" | "eliminated";
  actionProgress: number;
  actionStartTime?: number;
  actionDuration?: number;
  actionParams?: Record<string, number | string | boolean | null | undefined>;
  skin?: "stick" | "styled";
  physique?: "slim" | "jacked";
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
};

export type StreamFrameMessage = {
  kind: "frame";
  streamId: string;
  sessionId: string;
  sentAt: number;
  camera: StreamCamera;
  characters: StreamCharacterFrame[];
};

export type StreamEndMessage = {
  kind: "session-end";
  streamId: string;
  sessionId: string;
  sentAt: number;
};

export type StreamMessage = StreamSnapshotMessage | StreamFrameMessage | StreamEndMessage | StreamKickMessage | StreamEliminationMessage;

export function streamChannelName(streamId: string): string {
  return `${STREAM_CHANNEL_PREFIX}:${streamId}`;
}
