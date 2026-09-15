export const JOIN_CODE_LENGTH = 6;
export const JOIN_SESSION_HOURS = 24;
export const JOINABLE_BOARD_UNAVAILABLE = "Board sharing is temporarily unavailable.";

export function normalizeJoinCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, JOIN_CODE_LENGTH);
}

export function validJoinCode(value: unknown): value is string {
  return normalizeJoinCode(value).length === JOIN_CODE_LENGTH;
}

export function generateJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export type JoinableBoardState = {
  clips: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
  boardDimensions: { width: number; height: number };
  cameraKeyframes?: Array<Record<string, unknown>>;
  characterActions?: Array<Record<string, unknown>>;
  characterActions2?: Array<Record<string, unknown>>;
  showCharacter?: boolean;
  showCharacter2?: boolean;
  canvasAspect?: "16:9" | "9:16";
};
