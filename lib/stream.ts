export const STREAM_FPS = 15;
export const STREAM_CHANNEL_PREFIX = "stream";

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
  actionType: string;
  progress: number;
  emoji?: string;
  emojiAlpha?: number;
};

export type StreamSnapshotMessage = {
  kind: "snapshot";
  streamId: string;
  sessionId: string;
  sentAt: number;
  board: { width: number; height: number; backgroundColor: string };
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

export type StreamMessage = StreamSnapshotMessage | StreamFrameMessage | StreamEndMessage;

export function streamChannelName(streamId: string): string {
  return `${STREAM_CHANNEL_PREFIX}:${streamId}`;
}
