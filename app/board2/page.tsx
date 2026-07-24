"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSession, signIn } from "next-auth/react";
import rough from "roughjs";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { ProGated } from "@/app/components/ProGated";
import { ActionWheel, wheelTriggerStyle } from "@/app/components/ActionWheel";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import {
  STREAM_FPS,
  HOST_STREAM_SKIN,
  GuestCharacterFrame,
  MAX_GUEST_SIGN_DATA_URL_BYTES,
  MAX_GUESTS,
  SpawnDoor,
  StreamParticipantPresence,
  StreamCharacterFrame,
  StreamChokeMessage,
  StreamCharacterDebugRow,
  StreamEliminationMessage,
  StreamShotFiredMessage,
  StreamSnapshotMessage,
  StreamWeaponHitMessage,
  StreamBazookaFireMessage,
  StreamCrater,
  StreamRepairBoardMessage,
  streamChannelName,
  resolveStreamSkin,
} from "@/lib/stream";
import type { Viseme, HeadLocalPoint } from "@/lib/stream";
import {
  PLAY_CHARACTER_HEIGHT,
  PLAY_GRAVITY,
  PLAY_JUMP_SPEED,
  PLAY_MAX_FALL_SPEED,
  PLAY_RESPAWN_BELOW_LOWEST_SURFACE,
  RENDERER_VERSION,
  STREAM_PROJECTILE_SPEED,
  STREAM_CHARACTER_GEOMETRY,
  PlayCharacterState,
  PlayHairStyle,
  PlayOutfitStyle,
  drawEliminationSequence,
  drawPlacedSpawnDoor,
  drawPlaySpawnDoor,
  drawTommyGunHeld,
  drawBazookaHeld,
  drawWeaponProjectile,
  eliminationFrameForGuest,
  projectilePoint,
  streamCharacterConstructionParams,
} from "@/lib/character/renderer";
import { DEFAULT_MOUTH_ANCHOR, VISEME_MOUTH, type BoardCharacterDrawEvaluators } from "@/lib/character/board-renderer";
import { bazookaShake, craterForImpact, drawBazookaEffect, drawCrateredImage, type BazookaVisualEvent } from "@/lib/character/craters";
import { groundProfileY, raycastSolid, type TerrainClip, type TerrainPoint } from "@/lib/character/terrain";
import { CharacterEntity } from "@/lib/character/entity";
import { isGrounded } from "@/lib/character/grounding";
import { AuthoredAnimation, FORWARD_TUCK_FLIP_KEYFRAMES, SKATE_OLLY_KEYFRAMES, SKATE_PEDAL_KEYFRAMES, Pose, animationMap, normalizeAnimation, sampleAnimation } from "@/lib/characterAnimations";
import {
  CameraMode,
  OccupancyWindow,
  characterProjectDuration,
  deriveCharacterCameraKeyframes,
  deriveOccupancyWindows,
  occupancyWindowAt,
} from "@/lib/character-camera";
import { AI_FEATURES_ENABLED, DEBUG_STREAM, STREAM_OWNER_USER_ID } from "./config";
type BoardFullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type BoardFullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

// ─── Types ────────────────────────────────────────────────────────────────────

type CameraKeyframe = {
  time: number;
  cameraX: number;
  cameraY: number;
  boardZoom: number;
  easing?: 'linear' | 'ease-in-out'; // applied when interpolating TO this keyframe
};

function streamDebugLog(...args: unknown[]) {
  if (DEBUG_STREAM) console.log("[stream:host]", ...args);
}

function validGuestSignDataUrl(value?: string): value is string {
  return !!value && value.startsWith("data:image/") && value.length <= MAX_GUEST_SIGN_DATA_URL_BYTES;
}

type Clip = {
  id: string;
  type: "image" | "video" | "pan" | "characterZoom" | "customZoom" | "narration";
  name: string;
  sourceUrl: string;
  startTime: number;
  duration: number;
  layer?: number;    // 0-4 for visual clips, undefined for narration. Default: 1
  volume?: number;   // 0-1, default 1. Applies to video and narration clips
  muted?: boolean;   // explicit mute (overrides volume). Default: false
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  holdFraction?: number;
  sourceDurationSec?: number; // natural duration of the video blob (for ambient loop modulo)
  thumbnailBlobUrl?: string;  // URL.createObjectURL of the captured first frame (video clips)
  sourceBlob?: Blob;          // the actual video Blob backing sourceUrl (video clips only) — cloned
                               // per-instance on paste/duplicate so each <video> element gets its
                               // own independent blob instead of sharing one decoder-limited URL
  // narration-only:
  audioBlob?: Blob;
  waveform?: number[];
  sourceOffsetSec?: number;
  speechBubbles?: boolean;
  speechBubbleGestures?: boolean;
  transcriptSegments?: TranscriptSegment[];
  // youtube save/restore:
  youtubeId?: string;
  ytStart?: number;
  ytEnd?: number;
  needsRedownload?: boolean;
};

type TranscriptSegment = { start: number; end: number; text: string };
type SpeechBubbleCue = TranscriptSegment & { index: number };
type SpeechBubbleAnchor = { x: number; y: number; facing: 1 | -1 };

function narrationSentenceCues(segments: readonly TranscriptSegment[]): SpeechBubbleCue[] {
  const cues: SpeechBubbleCue[] = [];
  const pushChunks = (segment: TranscriptSegment, parts: string[]) => {
    const cleanParts = parts.map((part) => part.trim()).filter(Boolean);
    const totalChars = Math.max(1, cleanParts.reduce((sum, part) => sum + part.length, 0));
    let cursor = segment.start;
    for (const part of cleanParts) {
      const partEnd = cursor + (segment.end - segment.start) * part.length / totalChars;
      const words = part.split(/\s+/).filter(Boolean);
      let text = "";
      let start = cursor;
      for (const word of words) {
        const next = text ? `${text} ${word}` : word;
        if (text && next.length > 48) {
          const chunkEnd = cursor + (partEnd - cursor) * Math.max(0.2, text.length / Math.max(1, part.length));
          cues.push({ start, end: chunkEnd, text, index: cues.length });
          start = chunkEnd;
          text = word;
        } else {
          text = next;
        }
      }
      if (text.trim()) cues.push({ start, end: partEnd, text: text.trim(), index: cues.length });
      cursor = partEnd;
    }
  };
  for (const segment of segments) {
    const clean = segment.text.trim();
    if (!clean) continue;
    const parts = clean.match(/.*?[,;:](?=\s|$)|.*?[.!?](?:[\"')\]]+)?(?=\s|$)|.+$/g) ?? [clean];
    pushChunks(segment, parts);
  }
  return cues.map((cue, index, all) => ({ ...cue, end: all[index + 1]?.start ?? cue.end, index }));
}

function activeNarrationBubble(time: number, clips: readonly Clip[]): { cue: SpeechBubbleCue; clip: Clip } | null {
  const clip = clips.find((candidate) => candidate.type === "narration" && candidate.speechBubbles && candidate.transcriptSegments?.length && time >= candidate.startTime && time < candidate.startTime + candidate.duration);
  if (!clip?.transcriptSegments) return null;
  const sourceTime = (clip.sourceOffsetSec ?? 0) + (time - clip.startTime);
  const cues = narrationSentenceCues(clip.transcriptSegments);
  const cue = cues.find((candidate, index) => sourceTime >= candidate.start && sourceTime < (cues[index + 1]?.start ?? Math.max(candidate.end, (clip.sourceOffsetSec ?? 0) + clip.duration)));
  return cue ? { cue, clip } : null;
}

function narrationVisemeAt(time: number, clips: readonly Clip[]): Viseme {
  const clip = clips.find((candidate) =>
    candidate.type === "narration" &&
    time >= candidate.startTime &&
    time < candidate.startTime + candidate.duration
  );
  if (!clip) return "rest";
  const sourceTime = (clip.sourceOffsetSec ?? 0) + (time - clip.startTime);
  if (!clip.transcriptSegments?.length) {
    return rhythmicViseme(sourceTime, clip.id);
  }
  const segment = clip.transcriptSegments.find((candidate) =>
    sourceTime >= candidate.start &&
    sourceTime < candidate.end &&
    candidate.text.trim()
  );
  if (!segment) return rhythmicViseme(sourceTime, clip.id);
  const segmentDur = Math.max(0.001, segment.end - segment.start);
  const segmentT = clamp((sourceTime - segment.start) / segmentDur, 0, 1);
  if (segmentT < 0.035 || segmentT > 0.97) return "closed";

  const words = segment.text.match(/[A-Za-z0-9']+|[,.!?;:]/g) ?? [];
  const spoken = words.filter((word) => /[A-Za-z0-9]/.test(word));
  if (!spoken.length) return "rest";
  const totalChars = Math.max(1, spoken.reduce((sum, word) => sum + word.length, 0));
  let cursor = segment.start;
  for (let index = 0; index < spoken.length; index++) {
    const word = spoken[index];
    const wordDur = Math.max(0.08, segmentDur * word.length / totalChars);
    const start = cursor;
    const end = index === spoken.length - 1 ? segment.end : Math.min(segment.end, cursor + wordDur);
    if (sourceTime >= start && sourceTime < end) {
      const wordT = clamp((sourceTime - start) / Math.max(0.001, end - start), 0, 1);
      const lower = word.toLowerCase();
      if (wordT < 0.1 && /^[bmp]/.test(lower)) return "closed";
      if (wordT > 0.84 && /[bmp]$/.test(lower)) return "closed";
      if (wordT > 0.88) return "slightOpen";
      if (/[fv]|th/.test(lower)) return wordT < 0.48 ? "teeth" : "slightOpen";
      if (/[ou]|oo|ow|aw/.test(lower)) return wordT < 0.55 ? "round" : "pucker";
      if (/[iey]|ee|ea/.test(lower)) return wordT < 0.55 ? "wide" : "teeth";
      if (/[a]/.test(lower)) return wordT < 0.55 ? "open" : "wide";
      return wordT < 0.5 ? "open" : "slightOpen";
    }
    cursor = end;
  }
  return "closed";
}

function rhythmicViseme(time: number, seedKey: string): Viseme {
  const seed = seededRandom(seedKey);
  const beat = (time * (7.5 + seed * 2.5) + seed * 5) % 1;
  if (beat < 0.12) return "closed";
  if (beat < 0.32) return "open";
  if (beat < 0.5) return seed < 0.45 ? "wide" : "round";
  if (beat < 0.68) return "slightOpen";
  if (beat < 0.82) return seed > 0.7 ? "pucker" : "teeth";
  return "slightOpen";
}

function actionSpeechVisemeAt(time: number, actions: readonly ResolvedCharAction[], seedKey: string): Viseme {
  const active = actions.find((action) =>
    (action.type === "explainGesture" || action.type === "emote") &&
    time >= action.startTime &&
    time < action.startTime + action.duration
  );
  if (!active) return "rest";
  const localT = Math.max(0, time - active.startTime);
  const edge = Math.min(localT, active.duration - localT);
  if (edge < 0.08) return "closed";
  return rhythmicViseme(localT, `${seedKey}:${active.id}:${active.type}`);
}

function drawNarrationSpeechBubble(ctx: CanvasRenderingContext2D, time: number, clips: readonly Clip[], width: number, height: number, anchor?: SpeechBubbleAnchor | null) {
  const active = activeNarrationBubble(time, clips);
  if (!active || !anchor) return;
  const { cue, clip } = active;
  const head = anchor ?? { x: width * 0.5, y: height * 0.42, facing: 1 as const };
  const sideSeed = seededRandom(`${clip.id}:${cue.index}:${cue.text}`);
  const side = sideSeed < 0.5 ? -head.facing : head.facing;
  const fontSize = clamp(Math.round(width * 0.022), 15, 27);
  const maxWidth = clamp(width * 0.32, 170, 310);
  ctx.save();
  ctx.font = `${fontSize}px 'Patrick Hand', 'Comic Sans MS', cursive`;
  const words = cue.text.toUpperCase().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth - fontSize * 1.8) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  const lineHeight = fontSize * 1.08;
  const boxW = Math.min(maxWidth, Math.max(fontSize * 7, ...lines.map((item) => ctx.measureText(item).width + fontSize * 1.8)));
  const boxH = Math.max(fontSize * 2.5, lines.length * lineHeight + fontSize * 1.35);
  const centerX = head.x + side * fontSize * (4.7 + sideSeed * 0.9);
  const centerY = head.y - fontSize * (4.65 + seededRandom(`${clip.id}:${cue.index}:bubble-y`) * 0.75);
  const x = clamp(centerX - boxW / 2, fontSize * 0.5, width - boxW - fontSize * 0.5);
  const y = clamp(centerY - boxH / 2, fontSize * 0.4, height - boxH - fontSize * 1.1);
  const radius = Math.min(boxH * 0.42, fontSize * 1.5);
  const tailBase = clamp(head.x, x + fontSize * 1.4, x + boxW - fontSize * 1.4);
  const tailTipX = clamp(head.x + side * fontSize * 1.25, x + fontSize * 0.8, x + boxW - fontSize * 0.8);
  const tailTipY = clamp(head.y - fontSize * 1.65, y + boxH + fontSize * 0.35, height - fontSize * 0.5);
  const cueDuration = Math.max(0.001, cue.end - cue.start);
  const sourceTime = (clip.sourceOffsetSec ?? 0) + (time - clip.startTime);
  const cueT = clamp((sourceTime - cue.start) / cueDuration, 0, 1);
  const pop = cueT < 0.16 ? 0.86 + Math.sin((cueT / 0.16) * Math.PI * 0.5) * 0.14 : cueT < 0.28 ? 1.02 - (cueT - 0.16) / 0.12 * 0.02 : 1;
  ctx.translate(x + boxW / 2, y + boxH / 2);
  ctx.scale(pop, pop);
  ctx.translate(-(x + boxW / 2), -(y + boxH / 2));
  ctx.shadowColor = "rgba(0,0,0,.12)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "rgba(255,255,252,.97)";
  ctx.strokeStyle = "#171717";
  ctx.lineWidth = Math.max(0.85, width * 0.00105);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.quadraticCurveTo(x + boxW, y, x + boxW, y + radius);
  ctx.quadraticCurveTo(x + boxW, y + boxH, x + boxW - radius, y + boxH);
  ctx.lineTo(tailBase + fontSize * 0.42, y + boxH);
  ctx.quadraticCurveTo(tailBase + fontSize * 0.08, y + boxH + fontSize * 0.85, tailTipX, tailTipY);
  ctx.quadraticCurveTo(tailBase - fontSize * 0.24, y + boxH + fontSize * 0.48, tailBase - fontSize * 0.45, y + boxH);
  ctx.lineTo(x + radius, y + boxH);
  ctx.quadraticCurveTo(x, y + boxH, x, y + boxH - radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.stroke();
  ctx.fillStyle = "#171717";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((item, index) => ctx.fillText(item, x + boxW / 2, y + fontSize * 0.75 + lineHeight * (index + 0.5)));
  ctx.restore();
}

type CharacterFaceSettings = {
  faceBlobUrl: string;
  faceAspect: number;
  mouthAnchor?: HeadLocalPoint;
};

type CharacterId = "c1" | "c2";
type CharacterSkin = "stick" | "styled";

type CharacterInstance = {
  id: CharacterId;
  enabled: boolean;
  accentColor: string;
  mode: "auto" | "manual";
  actions: CharacterAction[];
  skin: CharacterSkin;
  faceBlobUrl?: string;
  faceAspect?: number;
  mouthAnchor?: HeadLocalPoint;
  start?: { x: number; y: number };
};

type FaceCropCorner = "nw" | "ne" | "sw" | "se";

type VideoPlaybackMode = "active" | "ambient" | "dormant";

type VideoPlaybackRuntime = {
  state: VideoPlaybackMode;
  lastInViewportAt: number;
  lastTransitionLogAt: number;
  lastRestartAt: number;
  reason: string;
};

type Annotation = {
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
  points?: Array<{ x: number; y: number }>;  // pen
  emoji?: string;                              // emoji
};

type AnnotationTool = "pointer" | "text" | "arrow" | "circle" | "highlight" | "pen" | "emoji";

type CharacterAction = {
  id: string;
  type: "walkTo" | "jumpTo" | "skateTo" | "flip" | "zipline" | "wallClimb" | "grapple"
      | "pointAt" | "sitAndWatch" | "explainGesture" | "emote" | "pullUps" | "mirrorCheck" | "dance" | "bazooka" | "idle";
  startTime: number;
  duration: number;
  targetX?: number;
  targetY?: number;
  targetLocalX?: number;
  targetLocalY?: number;
  targetClipId?: string;  // AI-choreographed actions target a clip id instead of raw coords — resolved
                           // to boardX/Y lazily in resolveCharActions so a clip move never staleifies it.
                           // Explicit targetX/Y (set by manual placement) always takes precedence.
  viaSurfaceId?: string;   // Reserved for future ridable drawn surfaces; accepted/stored, ignored at runtime for now.
  emoji?: string;
  startX?: number;        // explicit start-position override (entrance/exit flips start offscreen, not chained)
  startY?: number;
  entranceFlip?: boolean; // marks the auto-derived flip onto the first media clip — used to hide the
                           // character before this action starts (see characterEntranceTime)
  aiGenerated?: boolean;  // produced by /api/board2/character-choreography — shown with a ✨ badge and
                           // removable in bulk via "Clear AI choreography", otherwise a normal manual action
  narrationGestureClipId?: string;
  narrationGestureCueIndex?: number;
};

type CharacterAddMode = "walkTo" | "jumpTo" | "skateTo" | "pointAt" | "emote" | "grapple" | "pullUps" | "mirrorCheck" | "dance" | "bazooka" | "flip" | "zipline" | "wallClimb" | "sitAndWatch" | "explainGesture";

function nextAvailableCharacterActionStart(
  actions: readonly CharacterAction[],
  requestedStart: number,
  duration: number,
): number {
  let start = requestedStart;
  // Re-check after every move because skipping one action can land inside another.
  for (;;) {
    const conflict = actions
      .filter((action) => action.startTime < start + duration - 0.001 && action.startTime + action.duration > start + 0.001)
      .sort((a, b) => (a.startTime + a.duration) - (b.startTime + b.duration))[0];
    if (!conflict) return start;
    start = Math.max(start, conflict.startTime + conflict.duration);
  }
}

const AUTHORED_BAZOOKA_PICKUP_FIRE_FRACTION = 0.7;
const AUTHORED_BAZOOKA_CHAINED_FIRE_FRACTION = 0.3;
const AUTHORED_BAZOOKA_RANGE = 8000;
const AUTHORED_BAZOOKA_LIFT_START = 0.32;
const AUTHORED_BAZOOKA_LIFT_END = 0.58;

function authoredBazookaPickupProgress(progress: number): number {
  return clamp((progress - AUTHORED_BAZOOKA_LIFT_START) / (AUTHORED_BAZOOKA_LIFT_END - AUTHORED_BAZOOKA_LIFT_START), 0, 1);
}

function authoredBazookaIsChained(action: ResolvedCharAction, actions: readonly ResolvedCharAction[]): boolean {
  const previous = actions
    .filter((candidate) => candidate.id !== action.id && candidate.startTime + candidate.duration <= action.startTime + 0.02)
    .sort((a, b) => (b.startTime + b.duration) - (a.startTime + a.duration))[0];
  return previous?.type === "bazooka";
}

function authoredBazookaDisplayAction(time: number, actions: readonly ResolvedCharAction[]): ResolvedCharAction | null {
  const active = actions.find((action) => time >= action.startTime && time < action.startTime + action.duration);
  if (active) return active.type === "bazooka" ? active : null;
  const previous = actions
    .filter((action) => action.startTime + action.duration <= time)
    .sort((a, b) => (b.startTime + b.duration) - (a.startTime + a.duration))[0];
  const next = actions
    .filter((action) => action.startTime > time)
    .sort((a, b) => a.startTime - b.startTime)[0];
  return previous?.type === "bazooka" && next?.type === "bazooka" ? next : null;
}

function authoredBazookaFireFraction(action: ResolvedCharAction, actions: readonly ResolvedCharAction[]): number {
  return authoredBazookaIsChained(action, actions) ? AUTHORED_BAZOOKA_CHAINED_FIRE_FRACTION : AUTHORED_BAZOOKA_PICKUP_FIRE_FRACTION;
}

function authoredBazookaSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function authoredBazookaTimeline(
  time: number,
  actionGroups: readonly ResolvedCharAction[][],
  clips: readonly Clip[],
  initialCraters: readonly StreamCrater[] = [],
): { craters: StreamCrater[]; events: BazookaVisualEvent[] } {
  const terrain = clips.filter((clip) => clip.type === "image" && clip.boardX !== undefined) as Array<Clip & Required<Pick<Clip, "boardX" | "boardY" | "boardW" | "boardH">>>;
  const actions = actionGroups.flatMap((group) => group.filter((action) => action.type === "bazooka" && action.targetX !== undefined && action.targetY !== undefined)
    .map((action) => ({ action, fireFraction: authoredBazookaFireFraction(action, group) })))
    .sort((a, b) => a.action.startTime - b.action.startTime || a.action.id.localeCompare(b.action.id));
  const craters = [...initialCraters];
  const events: BazookaVisualEvent[] = [];
  for (const entry of actions) {
    const { action, fireFraction } = entry;
    const fireTime = action.startTime + action.duration * fireFraction;
    const dx = action.targetX! - action.fromX;
    const dy = action.targetY! - (action.fromY - 118);
    const length = Math.max(1, Math.hypot(dx, dy));
    const direction = { x: dx / length, y: dy / length };
    const from = { x: action.fromX + direction.x * 111, y: action.fromY - 118 + direction.y * 111 };
    const far = { x: from.x + direction.x * AUTHORED_BAZOOKA_RANGE, y: from.y + direction.y * AUTHORED_BAZOOKA_RANGE };
    const hit = raycastSolid(terrain as TerrainClip[], craters, from, far);
    const target = hit?.point ?? far;
    const seed = authoredBazookaSeed(action.id);
    const impactTime = fireTime + Math.hypot(target.x - from.x, target.y - from.y) / 1100;
    const event = {
      kind: "bazooka_fire",
      sequenceType: "bazookaFire",
      streamId: "authored",
      sessionId: "editor",
      sentAt: fireTime * 1000,
      startTime: fireTime * 1000,
      from,
      target,
      seed,
      fizzle: !hit,
    } as BazookaVisualEvent;
    if (time >= fireTime && time <= impactTime + 1.25) events.push(event);
    if (hit && time >= impactTime) {
      const clip = terrain.find((candidate) => candidate.id === hit.imageId);
      if (clip) {
        const crater = craterForImpact(clip, hit.point, seed);
        const sameImage = craters.filter((candidate) => candidate.clipId === clip.id);
        craters.splice(0, craters.length, ...craters.filter((candidate) => candidate.clipId !== clip.id), ...sameImage.slice(-23), crater);
      }
    }
  }
  return { craters, events };
}

type ResolvedCharAction = CharacterAction & { fromX: number; fromY: number };

type CharacterBlockerTimeline = {
  resolved: ResolvedCharAction[];
  initX: number;
  initY: number;
  entranceTime: number;
};

type LiveCommandKey = "walkTo" | "runTo" | "jumpTo" | "flip" | "grapple" | "zipline" | "skateTo" | "wallClimb" | "dance" | "pullUps" | "mirrorCheck" | "sitAndWatch" | "emote" | "stop";
type LiveCameraMode = "character" | "scene";

type LiveCharacterRuntime = {
  enabled: boolean;
  startWallMs: number;
  initX: number;
  initY: number;
  actions: CharacterAction[];
  currentPose: CharPoseResult | null;
  blendFromPose: CharPoseResult | null;
  blendStartWallMs: number;
  blendDuration: number;
  lastStationaryAction: CharacterAction | null;
  emoteIndex: number;
};

type PlayWeaponShot = {
  shotId: string;
  origin: { x: number; y: number };
  dir: { x: number; y: number };
  seed: number;
  sentAt: number;
  hitGuestIds: Set<string>;
};

type CharTimelineDrag = {
  kind: "move" | "resize-left" | "resize-right";
  actionId: string;
  origStartTime: number;
  origDuration: number;
  cursorOffsetSec: number;
};

type MediaItem = {
  id: string;
  name: string;
  type: "image" | "video";
  url: string;
  duration?: number;
  blob?: Blob; // video only — source for cloning a fresh blob when placed on the board
};

type TimelineDrag = {
  kind: "move" | "resize-left" | "resize-right";
  clipId: string;
  origStartTime: number;
  origDuration: number;
  origLayer: number;
  cursorOffsetSec: number;
};

type BoardMarquee = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type TimelineMarquee = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type YtSearchResult = {
  id: string;
  title: string;
  channel: string;
  duration: string | number;
  thumbnail: string;
  // Set when this selection originated from a Neural Search placeholder click, so
  // handleYtConfirm knows to reuse the placeholder's board position and remove it on success.
  placeholderId?: string;
  boardX?: number;
  boardY?: number;
};
type YtModalView = "search" | "trim";
type YtTab = "paste" | "search";

type DownloadToast = { id: string; title: string; status: "downloading" | "done" | "error"; error?: string };

// Neural Search: a not-yet-downloaded YouTube candidate placed on the board as a clickable
// thumbnail. Lives outside `clips` — no timeline presence, ignored by camera keyframes/export.
type NeuralPlaceholder = {
  id: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string;
  viewCount: number;
  durationSec: number;
};

// Neural Search: a not-yet-downloaded Google Image candidate placed on the board as a
// clickable thumbnail. Lives outside `clips` — no timeline presence, ignored by camera
// keyframes/export, same as NeuralPlaceholder.
type ImagePlaceholder = {
  id: string;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  imageUrl: string;
  title: string;
  sourceUrl: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CANVAS_W_LAND = 1920;
const CANVAS_H_LAND = 1080;
const BOARD_W = 4000;
const BOARD_H = 3000;
const VIEWPORT_W = 800;
const VIEWPORT_H = 600;
const BOARD_CLIP_PAD = 30;
const BOARD_EDGE_MARGIN = 200;
const DEFAULT_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 500;
const RULER_H = 28;
const N_LAYERS = 5;
const LAYER_H = 22;
const TRACK_H = N_LAYERS * LAYER_H; // 110
const TIMELINE_H = 370;
const NARRATION_TRACK_H = 44;

function rocketRayEnd(from: TerrainPoint, cursor: TerrainPoint, boardW = BOARD_W, boardH = BOARD_H): TerrainPoint {
  const dx = cursor.x - from.x;
  const dy = cursor.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { ...from };
  const ux = dx / length;
  const uy = dy / length;
  const limits = [
    ux > 0 ? (boardW - from.x) / ux : ux < 0 ? -from.x / ux : Infinity,
    uy > 0 ? (boardH - from.y) / uy : uy < 0 ? -from.y / uy : Infinity,
  ].filter((value) => value >= 0);
  const distance = Math.min(...limits);
  return { x: from.x + ux * distance, y: from.y + uy * distance };
}

function rocketTerrainClips(clips: readonly Clip[]): TerrainClip[] {
  return clips.flatMap((clip) => clip.type === "image" && clip.boardX !== undefined && clip.boardY !== undefined && clip.boardW !== undefined && clip.boardH !== undefined
    ? [{ id: clip.id, type: clip.type, boardX: clip.boardX, boardY: clip.boardY, boardW: clip.boardW, boardH: clip.boardH }]
    : []);
}
const NARRATION_COLOR = "#ffd6e8";
const HANDLE_W = 6;
const BOARD_RESIZE_PX = 10;
const EMOJI_SET = ["🤔","⭐","🎯","❗","💡","🔥","✨","📈","📉","⚠️","❓","💬","👀","🚀","❤️","✅","❌","🌍","🧠","🎨","🏆","💎","🔑","📌","🎬","📊","💰","🔍","🤝","🌟","💥","🎤","📣","🌈","⏰","🎁","😂"];
const MAGNETIC_SNAP_PX = 10;
const MAX_PASTED_IMAGE_BYTES = 15 * 1024 * 1024;
const CLIP_COLORS = ["#c8f135", "#5ec4ff", "#ff9f5e", "#d4a8ff", "#ff6b9d", "#7df5b0"];
const PAN_CLIP_COLOR = "#f0e6a8";
const CHARACTER_ZOOM_CLIP_COLOR = "#c9d4ff";
const CUSTOM_ZOOM_CLIP_COLOR = "#b8e2ff";
const HOLD_FRACTION = 0.6;
const FRAME_ALL_PADDING = 0.1;
const CLIP_FOCUS_RATIO = 0.7;
const EXPORT_FPS = 60;
const AMBIENT_VIDEO_STORAGE_KEY = "nb_board2_ambient_video_playback";
const AMBIENT_BUDGET = 4;
const AMBIENT_STATE_EVAL_INTERVAL_MS = 100;
const AMBIENT_VIEWPORT_EXPAND = 0.25;
const AMBIENT_DORMANT_HYSTERESIS_MS = 500;
const AMBIENT_CENSUS_INTERVAL_MS = 5000;
const PREVIEW_DEFAULT_H_PX = 135;
const PREVIEW_MIN_H_PX = 96;
const PREVIEW_MAX_H_PX = 620;
const CHARACTER_TRACK_H = 36;
const CHARACTER_COLOR = "#cdeac0";
const DEV_MOUTH_TEST = process.env.NODE_ENV !== "production";
const VISEME_OPTIONS = Object.keys(VISEME_MOUTH) as Viseme[];

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  return `b2_${Date.now()}_${++_idCounter}`;
}

function mimeToExt(mime: string, fallbackName: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/webm": "webm",
  };
  if (map[mime]) return map[mime];
  const m = fallbackName.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "bin";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// Bakes the face-crop oval into a standalone transparent PNG so the modal preview and the
// baked character head render from the exact same pixels. The modal displays the source image
// as a normal width:100% / height:auto image, so imageDrawOffset is 0 and imageDrawScale is
// displayWidth / naturalWidth; crop fractions map directly into source pixels.
async function bakeFaceCropImage(
  sourceUrl: string,
  crop: { x: number; y: number; w: number; h: number }
): Promise<{ blob: Blob; aspect: number }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Face image failed to load"));
    img.src = sourceUrl;
  });
  const sourceX = clamp(Math.round(crop.x * img.naturalWidth), 0, Math.max(0, img.naturalWidth - 1));
  const sourceY = clamp(Math.round(crop.y * img.naturalHeight), 0, Math.max(0, img.naturalHeight - 1));
  const sourceW = Math.max(1, Math.min(img.naturalWidth - sourceX, Math.round(crop.w * img.naturalWidth)));
  const sourceH = Math.max(1, Math.min(img.naturalHeight - sourceY, Math.round(crop.h * img.naturalHeight)));
  const aspect = clamp(sourceH / Math.max(1, sourceW), 0.75, 1.6);
  const canvas = document.createElement("canvas");
  canvas.width = sourceW;
  canvas.height = sourceH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create face crop");
  ctx.clearRect(0, 0, sourceW, sourceH);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(sourceW / 2, sourceH / 2, sourceW / 2, sourceH / 2, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    sourceW,
    sourceH,
    0,
    0,
    sourceW,
    sourceH
  );
  ctx.restore();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Face crop failed"))), "image/png");
  });
  return { blob, aspect };
}

function shadeColor(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `#${clamp(Math.round(r * factor), 0, 255).toString(16).padStart(2, "0")}${clamp(Math.round(g * factor), 0, 255).toString(16).padStart(2, "0")}${clamp(Math.round(b * factor), 0, 255).toString(16).padStart(2, "0")}`;
}

function getVideoMeta(url: string): Promise<{ duration: number; w: number; h: number }> {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.preload = "metadata";
    vid.onloadedmetadata = () => {
      const duration = isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 5;
      const w = vid.videoWidth || 0;
      const h = vid.videoHeight || 0;
      vid.src = "";
      resolve({ duration, w, h });
    };
    vid.onerror = () => resolve({ duration: 5, w: 0, h: 0 });
    vid.src = url;
  });
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function interpolateCameraKeyframes(
  kfs: CameraKeyframe[],
  time: number
): { cameraX: number; cameraY: number; boardZoom: number } {
  if (kfs.length === 0) return { cameraX: BOARD_W / 2, cameraY: BOARD_H / 2, boardZoom: 1 };
  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) {
    const { cameraX, cameraY, boardZoom } = sorted[0];
    return { cameraX, cameraY, boardZoom };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const last = sorted[sorted.length - 1];
    return { cameraX: last.cameraX, cameraY: last.cameraY, boardZoom: last.boardZoom };
  }
  let lo = 0;
  while (lo < sorted.length - 2 && sorted[lo + 1].time <= time) lo++;
  const a = sorted[lo];
  const b = sorted[lo + 1];
  const rawT = (time - a.time) / (b.time - a.time);
  const t = b.easing === 'linear' ? rawT : easeInOutCubic(rawT);
  return {
    cameraX: lerp(a.cameraX, b.cameraX, t),
    cameraY: lerp(a.cameraY, b.cameraY, t),
    boardZoom: lerp(a.boardZoom, b.boardZoom, t),
  };
}

function magneticSnap(
  t: number,
  candidates: number[],
  threshold: number
): { snapped: number; target: number | null } {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(t - c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return { snapped: best ?? t, target: best };
}

function allClipEdges(clips: Clip[], excludeId: string): number[] {
  const edges: number[] = [];
  for (const c of clips) {
    if (c.id === excludeId) continue;
    edges.push(c.startTime, c.startTime + c.duration);
  }
  return edges;
}

function layerOverlap(clips: Clip[], start: number, duration: number, excludeId: string, layer: number): boolean {
  return clips.some(
    (c) => c.id !== excludeId && (c.layer ?? 1) === layer && c.type !== "narration" &&
      start < c.startTime + c.duration && start + duration > c.startTime
  );
}

function freeLayerAtTime(clips: Clip[], start: number, duration: number, excludeId: string, preferLayer: number): number {
  for (let l = preferLayer; l < N_LAYERS; l++) {
    if (!layerOverlap(clips, start, duration, excludeId, l)) return l;
  }
  for (let l = 0; l < preferLayer; l++) {
    if (!layerOverlap(clips, start, duration, excludeId, l)) return l;
  }
  return preferLayer;
}

function endOfLayer(clips: Clip[], layer: number, excludeId: string): number {
  return clips
    .filter((c) => c.id !== excludeId && (c.layer ?? 1) === layer && c.type !== "narration")
    .reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
}

function findFreeBoardPos(
  existing: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }>,
  clipW: number,
  clipH: number,
  camX: number = BOARD_W / 2,
  camY: number = BOARD_H / 2
): { boardX: number; boardY: number } {
  const visuals = existing.filter((c) => c.boardX !== undefined);
  const overlaps = (bx: number, by: number, pad: number) =>
    visuals.some(
      (c) =>
        !(
          bx + clipW + pad < c.boardX! ||
          bx > c.boardX! + c.boardW! + pad ||
          by + clipH + pad < c.boardY! ||
          by > c.boardY! + c.boardH! + pad
        )
    );
  const candidate = (rx: number, ry: number) => ({
    boardX: clamp(camX - clipW / 2 + rx, 0, BOARD_W - clipW),
    boardY: clamp(camY - clipH / 2 + ry, 0, BOARD_H - clipH),
  });
  // Phase 1: near camera with padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H
    );
    if (!overlaps(bx, by, BOARD_CLIP_PAD)) return { boardX: bx, boardY: by };
  }
  // Phase 2: near camera, no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W,
      (Math.random() - 0.5) * VIEWPORT_H
    );
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  // Phase 3: 2× radius, no padding
  for (let i = 0; i < 50; i++) {
    const { boardX: bx, boardY: by } = candidate(
      (Math.random() - 0.5) * VIEWPORT_W * 2,
      (Math.random() - 0.5) * VIEWPORT_H * 2
    );
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  // Phase 4: anywhere on board
  for (let i = 0; i < 50; i++) {
    const bx = BOARD_EDGE_MARGIN + Math.random() * (BOARD_W - BOARD_EDGE_MARGIN * 2 - clipW);
    const by = BOARD_EDGE_MARGIN + Math.random() * (BOARD_H - BOARD_EDGE_MARGIN * 2 - clipH);
    if (!overlaps(bx, by, 0)) return { boardX: bx, boardY: by };
  }
  const last = visuals.at(-1);
  if (last)
    return {
      boardX: Math.min(last.boardX! + 20, BOARD_W - clipW),
      boardY: Math.min(last.boardY! + 20, BOARD_H - clipH),
    };
  return {
    boardX: clamp(camX - clipW / 2, 0, BOARD_W - clipW),
    boardY: clamp(camY - clipH / 2, 0, BOARD_H - clipH),
  };
}

function findFreeBoardPosNearHost(
  existing: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }>,
  clipW: number,
  clipH: number,
  hostX: number,
  hostY: number,
  facing: 1 | -1 = 1
): { boardX: number; boardY: number } {
  const visuals = existing.filter((c) => c.boardX !== undefined);
  const overlaps = (bx: number, by: number, pad: number) =>
    visuals.some(
      (c) =>
        !(
          bx + clipW + pad < c.boardX! ||
          bx > c.boardX! + c.boardW! + pad ||
          by + clipH + pad < c.boardY! ||
          by > c.boardY! + c.boardH! + pad
        )
    );
  const candidateFromCenter = (cx: number, cy: number) => ({
    boardX: clamp(cx - clipW / 2, 0, BOARD_W - clipW),
    boardY: clamp(cy - clipH / 2, 0, BOARD_H - clipH),
  });
  const side = facing || 1;
  const centers: Array<{ dx: number; dy: number }> = [
    { dx: side * 300, dy: -Math.min(180, clipH * 0.25) },
    { dx: side * 500, dy: -Math.min(220, clipH * 0.2) },
    { dx: side * 180, dy: -Math.min(360, clipH * 0.55) },
    { dx: side * 420, dy: 180 },
    { dx: side * 600, dy: 40 },
    { dx: 0, dy: -Math.min(520, clipH * 0.7) },
    { dx: -side * 300, dy: -Math.min(180, clipH * 0.25) },
  ];
  for (const pad of [BOARD_CLIP_PAD, 0]) {
    for (const { dx, dy } of centers) {
      if (Math.hypot(dx, dy) > 680) continue;
      const { boardX, boardY } = candidateFromCenter(hostX + dx, hostY + dy);
      if (!overlaps(boardX, boardY, pad)) return { boardX, boardY };
    }
  }
  return findFreeBoardPos(existing, clipW, clipH, clamp(hostX + side * 420, 0, BOARD_W), clamp(hostY - clipH * 0.35, 0, BOARD_H));
}

function parseDurationSec(d: string | number | undefined): number {
  if (typeof d === "number") return isFinite(d) ? d : 0;
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return parseFloat(d) || 0;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatViewCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  if (n > 0) return `${n} views`;
  return "";
}

function parseTimestampSec(s: string): number | null {
  const parts = s.split(":").map((p) => parseFloat(p.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
  if (parts.length === 1 && !isNaN(parts[0]) && parts[0] >= 0) return parts[0];
  return null;
}

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─── Annotation canvas helpers ────────────────────────────────────────────────

function drawCurlyBrace(
  ctx: CanvasRenderingContext2D,
  x: number, y1: number, y2: number,
  color: string, sw: number
) {
  const h = y2 - y1;
  const mid = (y1 + y2) / 2;
  const q = Math.max(8, Math.min(30, h * 0.15));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.bezierCurveTo(x + q, y1, x + q, mid - h * 0.05, x, mid);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.bezierCurveTo(x + q, mid + h * 0.05, x + q, y2, x, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, mid);
  ctx.lineTo(x + q * 1.5, mid);
  ctx.stroke();
  ctx.restore();
}

function drawAnnotationsToCanvas(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number
) {
  const rc = rough.canvas(ctx.canvas);
  const toSX = (bx: number) => (bx - cam.cameraX) * sf + W / 2;
  const toSY = (by: number) => (by - cam.cameraY) * sf + H / 2;
  for (const ann of annotations) {
    const sw = Math.max(1, (ann.strokeWidth ?? 3) * sf);
    const roughSeed = ann.id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0) & 0xffff;
    const roughOpts = { stroke: ann.color, strokeWidth: sw, roughness: 1.4, bowing: 1.2, seed: roughSeed };
    if (ann.type === "text" && ann.text) {
      const fs = Math.max(8, (ann.fontSize ?? 80) * sf);
      ctx.save();
      ctx.font = `${ann.fontWeight ?? "normal"} ${fs}px '${ann.fontFamily ?? "Caveat"}', cursive`;
      ctx.fillStyle = ann.color;
      ctx.textBaseline = "top";
      ctx.fillText(ann.text, toSX(ann.boardX), toSY(ann.boardY));
      ctx.restore();
    } else if (ann.type === "arrow" && ann.arrowStartX !== undefined) {
      const ax = toSX(ann.arrowStartX), ay = toSY(ann.arrowStartY!);
      const ex = toSX(ann.arrowEndX!), ey = toSY(ann.arrowEndY!);
      rc.line(ax, ay, ex, ey, roughOpts);
      const angle = Math.atan2(ey - ay, ex - ax);
      const hl = Math.max(12, sw * 5);
      rc.line(ex, ey, ex - hl * Math.cos(angle - Math.PI / 6), ey - hl * Math.sin(angle - Math.PI / 6), roughOpts);
      rc.line(ex, ey, ex - hl * Math.cos(angle + Math.PI / 6), ey - hl * Math.sin(angle + Math.PI / 6), roughOpts);
    } else if (ann.type === "circle") {
      rc.ellipse(
        toSX(ann.boardX) + ann.boardW * sf / 2,
        toSY(ann.boardY) + ann.boardH * sf / 2,
        ann.boardW * sf, ann.boardH * sf,
        { ...roughOpts, fill: "none" }
      );
    } else if (ann.type === "highlight") {
      const sx = toSX(ann.boardX), sy = toSY(ann.boardY);
      const bw = ann.boardW * sf, bh = ann.boardH * sf;
      const style = ann.highlightStyle ?? "rect";
      if (style === "rect") {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = ann.color;
        ctx.fillRect(sx, sy, bw, bh);
        ctx.globalAlpha = 1;
        ctx.restore();
      } else if (style === "underline") {
        rc.line(sx, sy + bh, sx + bw, sy + bh, roughOpts);
      } else {
        drawCurlyBrace(ctx, sx + bw, sy, sy + bh, ann.color, sw);
      }
    } else if (ann.type === "pen" && ann.points && ann.points.length >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toSX(ann.points[0].x), toSY(ann.points[0].y));
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(toSX(ann.points[i].x), toSY(ann.points[i].y));
      }
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1, (ann.strokeWidth ?? 4) * sf);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    } else if (ann.type === "emoji" && ann.emoji) {
      const fs = Math.max(8, (ann.fontSize ?? 120) * sf);
      ctx.save();
      ctx.font = `${fs}px serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(ann.emoji, toSX(ann.boardX + ann.boardW / 2), toSY(ann.boardY + ann.boardH / 2));
      ctx.restore();
    }
  }
}

// ─── Character — module-level helpers ────────────────────────────────────────

// Distance thresholds for auto-mode travel type selection
const CHAR_WALK_DIST = 500;   // board px — below this: walkTo
const CHAR_JUMP_DIST = 1500;  // board px — below this: jumpTo; above: grapple

// Character momentum post-process. These values are deliberately board-space/time based so the
// browser preview, a scrubbed frame, and an exported frame all produce the same pose.
const MOMENTUM_SAMPLE_DT = 1 / 60;
const VELOCITY_EMA_ALPHA = 0.38;
const LEAN_K = 0.00045;
const LEAN_MAX = 0.22;
const LEAN_RESPONSE_HZ = 9;
const LIMB_SPRING_K = 90;
const LIMB_SPRING_C = 12;
const LIMB_ACCEL_J = 0.000105;
const LIMB_OFFSET_MAX = 0.18;
const LIMB_HISTORY_SEC = 0.65;
const TAKEOFF_STRETCH_Y = 1.06;
const TAKEOFF_STRETCH_X = 0.96;
const LANDING_SQUASH_Y = 0.92;
const LANDING_SQUASH_X = 1.06;
const SQUASH_RECOVER_SEC = 0.15;
const TAKEOFF_STRETCH_SEC = 0.1;
const TAKEOFF_VY_THRESHOLD = -180;
const LANDING_VY_THRESHOLD = 220;
const TRAVEL_ACCEL_PX = 120;
const TRAVEL_DECEL_PX = 140;
const PLAY_WALK_RADIUS_PX = 260;
const PLAY_JUMP_CURSOR_PX = 85;
const PLAY_STEER_INTERVAL_MS = 140;
const PLAY_WALK_SPEED = 360;
const PLAY_RUN_SPEED = 760;
const PLAY_WALK_CYCLE_PX = 340;
const PLAY_WEAPON_FIRE_INTERVAL_MS = 120;
const PLAY_WEAPON_SHOT_LIFETIME_MS = 1700;
const PLAY_WEAPON_HIT_RADIUS = 58;
const CHAR_POINT_BEAT = 1.5;  // seconds of pointing per clip hold

// Travel-type action kinds — these are movement primitives from the prior resolved position.
const CHAR_TRAVEL_TYPES = new Set<CharacterAction["type"]>(["walkTo", "jumpTo", "skateTo", "flip", "zipline", "wallClimb", "grapple"]);
// Stationary actions whose target is a place to perform the action. Runtime may spend the first
// part of the same block walking in, but the timeline still stores one action.
const CHAR_STATIONARY_TARGET_TYPES = new Set<CharacterAction["type"]>(["dance", "emote", "pullUps", "mirrorCheck", "sitAndWatch", "explainGesture"]);
const CHAR_STATIONARY_NEAR_TARGET_PX = 60;
const CHAR_STATIONARY_RUN_DIST_PX = 600;
const CHAR_STATIONARY_WALK_SPEED = 360;
const CHAR_STATIONARY_RUN_SPEED = 720;
const CHAR_OFFSCREEN_PAD = 900;
const CHAR_ENTRANCE_Y_LIFT = 600;
const PHASE_TIME_SCALE = 1.2;
const SKATE_ROLL_SPEED = 560; // board px/sec
const SKATE_MOUNT_SEC = 0.3 * PHASE_TIME_SCALE;
const SKATE_PREP_SEC = 0.25 * PHASE_TIME_SCALE;
const SKATE_LAND_SEC = 0.4 * PHASE_TIME_SCALE;
const SKATE_LANDING_ROLLOUT_PX = 90;
const SKATE_EDGE_MARGIN = 50;
const SKATE_MIN_POP_HEIGHT = 80;
const SKATE_MAX_POP_HEIGHT = 140;
const SKATE_POP_CLEARANCE = 60;
const SKATE_AUTO_MAX_HEIGHT_DELTA = 150;
const SKATE_MANUAL_FALLBACK_HEIGHT_DELTA = 180;
const GRAPPLE_MANUAL_DURATION_SEC = 1.5 * PHASE_TIME_SCALE;
const CHAR_HIP_RAW = STREAM_CHARACTER_GEOMETRY.hipRaw;
const CHAR_TORSO_RAW = STREAM_CHARACTER_GEOMETRY.torsoRaw;
const CHAR_NECK_RAW = STREAM_CHARACTER_GEOMETRY.neckRaw;
const CHAR_HEAD_R_RAW = STREAM_CHARACTER_GEOMETRY.headRaw;
const CHAR_ARM_RAW = STREAM_CHARACTER_GEOMETRY.armRaw;
const CHAR_RELAX_ARM_A = 0.25;
const CHAR_RELAX_FORE_A = 0.18;
const LIVE_BLEND_SEC = 0.15;
const LIVE_WALK_SPEED = 420;
const LIVE_RUN_SPEED = 780;
const LIVE_EMOTES = ["🤔", "💡", "❗", "😂"];
const LIVE_CAMERA_TRANSITION_MS = 600;
const PULLUP_BAR_WIDTH = 180;
const PULLUP_BAR_HEIGHT = 230;
const PULLUP_GRIP_HALF_WIDTH = 32;
const MIRROR_W = 90;
const MIRROR_H = 260;
const MIRROR_OFFSET = 140;
const LAUNCHER_ALWAYS_VISIBLE = true;

// Deterministic pseudo-random in [0,1) seeded by a string (clip.id) — same seed always
// yields the same value, so regenerating the auto-choreography doesn't reshuffle emotes.
function seededRandom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 100000) / 100000;
}

function getCharInitPos(clips: { boardX?: number; boardY?: number; boardW?: number; boardH?: number }[]): { x: number; y: number } {
  const placed = clips.filter((c) => c.boardX !== undefined);
  if (placed.length === 0) return { x: BOARD_W / 2, y: BOARD_H * 0.75 };
  const minX = Math.min(...placed.map((c) => c.boardX!));
  const maxX = Math.max(...placed.map((c) => c.boardX! + (c.boardW ?? 0)));
  const maxY = Math.max(...placed.map((c) => c.boardY! + (c.boardH ?? 0)));
  return { x: (minX + maxX) / 2, y: maxY + 80 };
}

// Snap a desired Y position to the nearest clip top edge at x, if any clip spans that x.
// Returns the clip's boardY (feet land on the top surface). Falls back to desiredY if no clip.
function resolveGroundY(
  x: number,
  desiredY: number,
  clips: { id?: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[],
  craters: readonly StreamCrater[] = []
): number {
  const terrain = clips.flatMap((clip, index): TerrainClip[] => clip.boardX !== undefined && clip.boardY !== undefined && clip.boardW !== undefined && clip.boardH !== undefined && (clip.type === "image" || clip.type === "video")
    ? [{ id: clip.id ?? `surface-${index}`, type: clip.type, boardX: clip.boardX, boardY: clip.boardY, boardW: clip.boardW, boardH: clip.boardH }]
    : []);
  return groundProfileY(terrain, craters, x)?.y ?? desiredY;
}

// Snap a board position to the top surface of the clip under x (for action placement).
function snapToClipTop(
  tx: number, ty: number,
  clips: { id?: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[],
  craters: readonly StreamCrater[] = []
): { x: number; y: number } {
  const PAD = 40;
  const candidates = clips.filter((c) =>
    c.boardX !== undefined && c.boardY !== undefined && c.boardW !== undefined && c.boardH !== undefined &&
    (c.type === "image" || c.type === "video") &&
    tx >= c.boardX! && tx <= c.boardX! + (c.boardW ?? 0)
  );
  if (candidates.length === 0) return { x: tx, y: ty };
  // Pick topmost clip whose body contains the click point (boardY <= ty <= boardY + boardH)
  const hit = candidates
    .filter((c) => ty >= c.boardY! && ty <= c.boardY! + (c.boardH ?? 0))
    .sort((a, b) => a.boardY! - b.boardY!)[0];  // topmost
  if (hit) {
    // Clamp x to the inner span (not on extreme edges)
    const cx = Math.max(hit.boardX! + PAD, Math.min(hit.boardX! + (hit.boardW ?? 0) - PAD, tx));
    return { x: cx, y: resolveGroundY(cx, ty, clips, craters) };
  }
  return { x: tx, y: ty };
}

type CharSurfaceClip = {
  id?: string;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
  type?: string;
};

type RequiredSurfaceClip = CharSurfaceClip & {
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
};

type CameraViewport = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

type SkateToPlan = {
  facing: 1 | -1;
  startX: number;
  startY: number;
  edgeX: number;
  launchY: number;
  gapEndX: number;
  landingY: number;
  finalX: number;
  rolloutDistance: number;
  rollDistance: number;
  ollyDistance: number;
  heightDelta: number;
  peakHeight: number;
  tooHighTarget: boolean;
  mountDur: number;
  rollDur: number;
  prepDur: number;
  airDur: number;
  landDur: number;
  mountEnd: number;
  airStart: number;
  airEnd: number;
  terrainGapWidth: number;
  terrainAutoOllie: boolean;
};

function isBoardSurface(c: CharSurfaceClip): c is RequiredSurfaceClip {
  return (c.type === "image" || c.type === "video") &&
    c.boardX !== undefined && c.boardY !== undefined &&
    c.boardW !== undefined && c.boardH !== undefined;
}

function findSurfaceAtFeet(x: number, y: number, clips: CharSurfaceClip[]): RequiredSurfaceClip | undefined {
  const PAD = 40;
  return clips
    .filter(isBoardSurface)
    .filter((c) => x >= c.boardX + PAD && x <= c.boardX + c.boardW - PAD)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
}

function nearestPlayableSurface(x: number, y: number, clips: CharSurfaceClip[]): RequiredSurfaceClip | undefined {
  const surfaces = clips.filter(isBoardSurface);
  const directlyHit = surfaces
    .filter((c) => x >= c.boardX && x <= c.boardX + c.boardW && y >= c.boardY - 30 && y <= c.boardY + c.boardH)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
  if (directlyHit) return directlyHit;
  return surfaces
    .filter((c) => x >= c.boardX && x <= c.boardX + c.boardW)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
}

function findTargetSurface(active: ResolvedCharAction, tx: number, ty: number, clips: CharSurfaceClip[]): RequiredSurfaceClip | undefined {
  if (active.targetClipId) {
    const byId = clips.find((c) => c.id === active.targetClipId);
    if (byId && isBoardSurface(byId)) return byId;
  }
  const PAD = 40;
  const hit = clips
    .filter(isBoardSurface)
    .filter((c) =>
      tx >= c.boardX && tx <= c.boardX + c.boardW &&
      ty >= c.boardY - PAD && ty <= c.boardY + c.boardH + PAD
    )
    .sort((a, b) => Math.abs(a.boardY - ty) - Math.abs(b.boardY - ty))[0];
  if (hit) return hit;
  return clips
    .filter(isBoardSurface)
    .filter((c) => tx >= c.boardX + PAD && tx <= c.boardX + c.boardW - PAD)
    .sort((a, b) => Math.abs(a.boardY - ty) - Math.abs(b.boardY - ty))[0];
}

function clampInsideClipX(clip: RequiredSurfaceClip, x: number, pad = 50): number {
  const innerPad = Math.min(pad, Math.max(0, clip.boardW / 2 - 1));
  return clamp(x, clip.boardX + innerPad, clip.boardX + clip.boardW - innerPad);
}

function findStandingSurfaceForTarget(
  x: number,
  y: number,
  targetClipId: string | undefined,
  clips: CharSurfaceClip[]
): RequiredSurfaceClip | undefined {
  if (targetClipId) {
    const byId = clips.find((c) => c.id === targetClipId);
    if (byId && isBoardSurface(byId)) return byId;
  }
  const hit = clips
    .filter(isBoardSurface)
    .filter((c) => x >= c.boardX && x <= c.boardX + c.boardW && y >= c.boardY - 60 && y <= c.boardY + c.boardH + 60)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
  if (hit) return hit;
  return clips
    .filter(isBoardSurface)
    .filter((c) => x >= c.boardX && x <= c.boardX + c.boardW)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
}

function resolveStandingSlot(
  desiredX: number,
  desiredY: number,
  timeStart: number,
  timeEnd: number,
  targetClipId: string | undefined,
  clips: CharSurfaceClip[],
  blockers: CharacterBlockerTimeline[] = [],
  laneBias = 0,
  craters: readonly StreamCrater[] = []
): { x: number; y: number } {
  const surface = findStandingSurfaceForTarget(desiredX, desiredY, targetClipId, clips);
  const groundY = resolveGroundY(desiredX, surface?.boardY ?? desiredY, clips, craters);
  const baseX = surface ? clampInsideClipX(surface, desiredX + laneBias, 50) : desiredX + laneBias;
  const offsets = [0, 70, -70, 140, -140];
  const minSeps = [90, 55];

  const occupied = (candidateX: number, minSep: number) => blockers.some((blocker) => {
    const sampleStart = Math.max(timeStart, blocker.entranceTime);
    const sampleEnd = Math.max(sampleStart, timeEnd);
    for (let t = sampleStart; t <= sampleEnd + 0.001; t += 0.25) {
      const pose = evalCharAtTime(t, blocker.resolved, blocker.initX, blocker.initY, clips, {}, false, 1, craters);
      const sameSurface = Math.abs(resolveGroundY(pose.boardX, pose.boardY, clips, craters) - groundY) < 8 || Math.abs(pose.boardY - groundY) < 8;
      if (sameSurface && Math.abs(pose.boardX - candidateX) < minSep) return true;
    }
    return false;
  });

  for (const minSep of minSeps) {
    for (const offset of offsets) {
      const candidateX = surface ? clampInsideClipX(surface, baseX + offset, 50) : baseX + offset;
      if (!occupied(candidateX, minSep)) return { x: candidateX, y: groundY };
    }
  }

  return { x: baseX, y: groundY };
}

function cameraViewport(
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  outputW: number,
  outputH: number
): CameraViewport {
  const visibleW = BOARD_W / Math.max(0.05, cam.boardZoom);
  const visibleH = outputH * BOARD_W / (Math.max(0.05, cam.boardZoom) * outputW);
  return {
    left: cam.cameraX - visibleW / 2,
    right: cam.cameraX + visibleW / 2,
    top: cam.cameraY - visibleH / 2,
    bottom: cam.cameraY + visibleH / 2,
    width: visibleW,
    height: visibleH,
  };
}

function viewportEntranceSpawn(
  landingX: number,
  landingY: number,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  outputW: number,
  outputH: number
): { x: number; y: number } {
  const vp = cameraViewport(cam, outputW, outputH);
  const leftRoom = Math.max(0, landingX - vp.left);
  const rightRoom = Math.max(0, vp.right - landingX);
  const side: 1 | -1 = rightRoom > leftRoom ? 1 : -1;
  return {
    x: landingX + side * vp.width * 0.35,
    y: Math.min(landingY - 150, vp.top - 150),
  };
}

function buildSkateToPlan(active: ResolvedCharAction, clips: CharSurfaceClip[], craters: readonly StreamCrater[] = []): SkateToPlan | null {
  const tx = active.targetX ?? active.fromX;
  const ty = active.targetY ?? active.fromY;
  const source = findSurfaceAtFeet(active.fromX, active.fromY, clips);
  const target = findTargetSurface(active, tx, ty, clips);
  if (!source || !target) return null;

  const sourceCenterX = source.boardX + source.boardW / 2;
  const targetCenterX = target.boardX + target.boardW / 2;
  const facing: 1 | -1 = targetCenterX >= sourceCenterX ? 1 : -1;
  let edgeX = facing === 1
    ? source.boardX + source.boardW - SKATE_EDGE_MARGIN
    : source.boardX + SKATE_EDGE_MARGIN;
  const targetHoldX = clampInsideClipX(target, tx, SKATE_EDGE_MARGIN);
  const desiredLandingX = targetHoldX - facing * SKATE_LANDING_ROLLOUT_PX;
  let gapEndX = clampInsideClipX(target, desiredLandingX, SKATE_EDGE_MARGIN);
  let finalX = clampInsideClipX(target, gapEndX + facing * SKATE_LANDING_ROLLOUT_PX, SKATE_EDGE_MARGIN);
  const rolloutDistance = Math.abs(finalX - gapEndX);
  const sourceGround = groundProfileY([source as TerrainClip], craters, active.fromX);
  const startY = sourceGround?.y ?? source.boardY;
  let landingY = groundProfileY([target as TerrainClip], craters, gapEndX)?.y ?? target.boardY;
  const topGaps = craters.filter((crater) => crater.clipId === source.id && Math.abs(crater.cy) < crater.r).map((crater) => {
    const half = Math.sqrt(crater.r ** 2 - crater.cy ** 2);
    return { left: source.boardX + crater.cx - half, right: source.boardX + crater.cx + half, width: half * 2 };
  }).filter((gap) => facing === 1 ? gap.left > active.fromX && gap.left < tx : gap.right < active.fromX && gap.right > tx).sort((a,b)=>facing===1?a.left-b.left:b.right-a.right);
  const terrainGap = topGaps[0];
  if (terrainGap) {
    edgeX = facing === 1 ? terrainGap.left : terrainGap.right;
    gapEndX = facing === 1 ? terrainGap.right : terrainGap.left;
    if (terrainGap.width > 120) finalX = gapEndX = edgeX + facing * 90;
    else finalX = gapEndX + facing * SKATE_LANDING_ROLLOUT_PX;
    landingY = resolveGroundY(gapEndX, startY, clips, craters);
  } else if (source === target) {
    return null;
  }
  const rollDistance = Math.abs(edgeX - active.fromX);
  const ollyDistance = Math.abs(gapEndX - edgeX);
  const heightDelta = landingY - startY;
  const verticalClimb = Math.max(0, startY - landingY);
  const peakHeight = clamp(verticalClimb + SKATE_POP_CLEARANCE, SKATE_MIN_POP_HEIGHT, SKATE_MAX_POP_HEIGHT);
  const tooHighTarget = verticalClimb > SKATE_MANUAL_FALLBACK_HEIGHT_DELTA;

  const naturalMount = SKATE_MOUNT_SEC;
  const naturalRoll = Math.max(0.05 * PHASE_TIME_SCALE, rollDistance / SKATE_ROLL_SPEED);
  const naturalAir = Math.max(0.08 * PHASE_TIME_SCALE, ollyDistance / SKATE_ROLL_SPEED);
  const naturalLand = SKATE_LAND_SEC;
  const naturalTotal = naturalMount + naturalRoll + naturalAir + naturalLand;
  const duration = Math.max(0.12, active.duration);

  let mountDur: number;
  let rollDur: number;
  let airDur: number;
  let landDur: number;
  if (duration >= naturalMount + naturalLand + 0.12) {
    mountDur = naturalMount;
    landDur = naturalLand;
    const variableBudget = Math.max(0.12, duration - mountDur - landDur);
    const variableNatural = naturalRoll + naturalAir;
    rollDur = variableBudget * (naturalRoll / variableNatural);
    airDur = variableBudget * (naturalAir / variableNatural);
  } else {
    const scale = duration / naturalTotal;
    mountDur = naturalMount * scale;
    rollDur = naturalRoll * scale;
    airDur = naturalAir * scale;
    landDur = naturalLand * scale;
  }

  const mountEnd = mountDur;
  const airStart = mountDur + rollDur;
  const airEnd = airStart + airDur;
  const prepDur = Math.min(
    SKATE_PREP_SEC,
    Math.max(0, rollDur),
    rollDistance > 0 ? (Math.min(120, rollDistance) / rollDistance) * rollDur : 0
  );

  return {
    facing,
    startX: active.fromX,
    startY,
    edgeX,
    launchY: startY,
    gapEndX,
    landingY,
    finalX,
    rolloutDistance,
    rollDistance,
    ollyDistance,
    heightDelta,
    peakHeight,
    tooHighTarget,
    mountDur,
    rollDur,
    prepDur,
    airDur,
    landDur,
    mountEnd,
    airStart,
    airEnd,
    terrainGapWidth: terrainGap?.width ?? 0,
    terrainAutoOllie: !!terrainGap && terrainGap.width <= 120,
  };
}

function resolvedActionRestPosition(
  action: ResolvedCharAction,
  clips: CharSurfaceClip[],
  craters: readonly StreamCrater[] = []
): { x: number; y: number } {
  const skatePlan = action.type === "skateTo" ? buildSkateToPlan(action, clips, craters) : null;
  if (skatePlan) return { x: skatePlan.finalX, y: skatePlan.landingY };
  if (CHAR_STATIONARY_TARGET_TYPES.has(action.type) && action.targetX !== undefined) {
    const targetY = resolveGroundY(action.targetX, action.targetY ?? action.fromY, clips, craters);
    const dist = Math.hypot(action.targetX - action.fromX, targetY - action.fromY);
    if (dist < CHAR_STATIONARY_NEAR_TARGET_PX) return { x: action.fromX, y: action.fromY };
    return {
      x: action.targetX,
      y: targetY,
    };
  }
  return {
    x: action.targetX ?? action.fromX,
    y: action.targetY ?? action.fromY,
  };
}

function actionCanChangeRestPosition(type: CharacterAction["type"]): boolean {
  return CHAR_TRAVEL_TYPES.has(type) || CHAR_STATIONARY_TARGET_TYPES.has(type);
}

type StationaryRuntime =
  | {
      hasTarget: false;
      didWalkIn: false;
      action: ResolvedCharAction;
      progress: number;
      elapsed: number;
      targetX: number;
      targetY: number;
    }
  | {
      hasTarget: true;
      phase: "near" | "travel" | "act";
      didWalkIn: boolean;
      action: ResolvedCharAction;
      progress: number;
      elapsed: number;
      targetX: number;
      targetY: number;
      travelDuration: number;
      distance: number;
      running: boolean;
    };

function stationaryRuntimeForAction(
  active: ResolvedCharAction,
  clips: CharSurfaceClip[],
  time: number,
  craters: readonly StreamCrater[] = []
): StationaryRuntime {
  if (!CHAR_STATIONARY_TARGET_TYPES.has(active.type) || active.targetX === undefined) {
    const elapsed = time - active.startTime;
    return {
      hasTarget: false,
      didWalkIn: false,
      action: active,
      progress: clamp(elapsed / Math.max(0.001, active.duration), 0, 1),
      elapsed,
      targetX: active.fromX,
      targetY: active.fromY,
    };
  }

  const targetX = active.targetX;
  const targetY = resolveGroundY(targetX, active.targetY ?? active.fromY, clips, craters);
  const distance = Math.hypot(targetX - active.fromX, targetY - active.fromY);
  const elapsed = time - active.startTime;
  if (distance < CHAR_STATIONARY_NEAR_TARGET_PX) {
    return {
      hasTarget: true,
      phase: "near",
      didWalkIn: false,
      action: { ...active, targetX: active.fromX, targetY: active.fromY },
      progress: clamp(elapsed / Math.max(0.001, active.duration), 0, 1),
      elapsed,
      targetX: active.fromX,
      targetY: active.fromY,
      travelDuration: 0,
      distance,
      running: false,
    };
  }

  const running = distance >= CHAR_STATIONARY_RUN_DIST_PX;
  const naturalTravel = distance / (running ? CHAR_STATIONARY_RUN_SPEED : CHAR_STATIONARY_WALK_SPEED);
  const travelDuration = Math.max(0.001, Math.min(active.duration * 0.5, naturalTravel));
  const remainingDuration = Math.max(0.001, active.duration - travelDuration);
  const actionStartTime = active.startTime + travelDuration;
  const actionElapsed = Math.max(0, elapsed - travelDuration);
  const action: ResolvedCharAction = {
    ...active,
    startTime: actionStartTime,
    duration: remainingDuration,
    fromX: targetX,
    fromY: targetY,
    targetX,
    targetY,
  };

  return {
    hasTarget: true,
    phase: elapsed < travelDuration ? "travel" : "act",
    didWalkIn: true,
    action,
    progress: clamp(actionElapsed / remainingDuration, 0, 1),
    elapsed: actionElapsed,
    targetX,
    targetY,
    travelDuration,
    distance,
    running,
  };
}

function characterActionHasWalkIn(action: ResolvedCharAction, clips: CharSurfaceClip[]): boolean {
  const runtime = stationaryRuntimeForAction(action, clips, action.startTime);
  return runtime.hasTarget && runtime.didWalkIn;
}

// Resolve an action's targetClipId to board coordinates, using the clip's CURRENT position —
// called fresh every resolveCharActions pass so a clip move is reflected on the very next render,
// never stale. pointAt targets a point inside the clip (to point AT something); every other
// targeted type targets the clip's top surface (a place to stand).
function resolveClipTarget(
  action: CharacterAction,
  clips: { id: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[]
): { x: number; y: number } | undefined {
  if (!action.targetClipId) return undefined;
  const c = clips.find((cl) => cl.id === action.targetClipId);
  if (!c || c.boardX === undefined || c.boardY === undefined) return undefined;
  const cx = c.boardX + (c.boardW ?? 0) / 2;
  if (action.type === "pointAt") return { x: cx, y: c.boardY + (c.boardH ?? 0) * 0.35 };
  if (action.type === "bazooka" && action.targetLocalX !== undefined && action.targetLocalY !== undefined) {
    return { x: c.boardX + action.targetLocalX, y: c.boardY + action.targetLocalY };
  }
  return { x: cx, y: c.boardY };
}

// Resolve fromX/fromY for each action (position continuity pass).
// Handles both manual and auto-derived actions merged in time order.
function resolveCharActions(
  actions: CharacterAction[],
  initX: number,
  initY: number,
  clips: { id: string; boardX?: number; boardY?: number; boardW?: number; boardH?: number; type?: string }[],
  blockers: CharacterBlockerTimeline[] = [],
  laneBias = 0,
  craters: readonly StreamCrater[] = []
): ResolvedCharAction[] {
  const sorted = [...actions].sort((a, b) => a.startTime - b.startTime);
  let x = initX, y = initY;
  const result: ResolvedCharAction[] = [];
  for (const a of sorted) {
    // Explicit targetX/Y (manual placement) always wins; otherwise resolve targetClipId against
    // the clip's current position (AI-choreographed actions).
    const resolvedTarget = resolveClipTarget(a, clips);
    let targetX = a.type === "bazooka" ? resolvedTarget?.x ?? a.targetX : a.targetX ?? resolvedTarget?.x;
    let targetY = a.type === "bazooka" ? resolvedTarget?.y ?? a.targetY : a.targetY ?? resolvedTarget?.y;
    if (actionCanChangeRestPosition(a.type) && targetX !== undefined) {
      const slot = resolveStandingSlot(targetX, targetY ?? y, a.startTime, a.startTime + a.duration, a.targetClipId, clips, blockers, resolvedTarget ? laneBias : 0, craters);
      targetX = slot.x;
      targetY = slot.y;
    }
    // startX/startY (entrance/exit flips) override the chained position for this action only —
    // the chain continues from targetX/targetY afterward, same as any other travel action.
    const resolvedAction: ResolvedCharAction = { ...a, targetX, targetY, fromX: a.startX ?? x, fromY: a.startY ?? y };
    result.push(resolvedAction);
    if (actionCanChangeRestPosition(a.type) && targetX !== undefined) {
      const rest = resolvedActionRestPosition(resolvedAction, clips, craters);
      x = rest.x; y = rest.y;
    }
    // pointAt/idle don't change position; stationary target actions may end at
    // their target after an evaluation-layer walk-in.
  }
  return result;
}

// Merge auto-derived actions with manual overrides:
// manual actions take priority — any derived action overlapping a manual one is suppressed.
function mergeCharActions(derived: CharacterAction[], manual: CharacterAction[]): CharacterAction[] {
  return [
    ...derived.filter((d) => !manual.some((m) =>
      d.startTime < m.startTime + m.duration && d.startTime + d.duration > m.startTime
    )),
    ...manual,
  ].sort((a, b) => a.startTime - b.startTime);
}

function narrationSpeechGestureActions(
  clip: Clip,
  ownerActions: readonly CharacterAction[],
  owner: CharacterId,
): CharacterAction[] {
  if (clip.type !== "narration" || !clip.speechBubbles || clip.speechBubbleGestures === false || !clip.transcriptSegments?.length) return [];
  const offset = clip.sourceOffsetSec ?? 0;
  const clipStart = clip.startTime;
  const clipEnd = clip.startTime + clip.duration;
  const existing = ownerActions.filter((action) => action.narrationGestureClipId !== clip.id);
  return narrationSentenceCues(clip.transcriptSegments).flatMap((cue) => {
    const startTime = clamp(clipStart + cue.start - offset, clipStart, clipEnd);
    const endTime = clamp(clipStart + cue.end - offset, startTime, clipEnd);
    const duration = Math.max(0, endTime - startTime);
    if (duration < 0.35) return [];
    const overlapsBusyAction = existing.some((action) => {
      if (action.type === "idle" || action.type === "explainGesture") return false;
      return startTime < action.startTime + action.duration - 0.001 && startTime + duration > action.startTime + 0.001;
    });
    if (overlapsBusyAction) return [];
    return [{
      id: `speech_${owner}_${clip.id}_${cue.index}`,
      type: "explainGesture" as const,
      startTime,
      duration,
      aiGenerated: true,
      narrationGestureClipId: clip.id,
      narrationGestureCueIndex: cue.index,
    }];
  });
}

// Derive character actions automatically from the clip timeline (auto-follow mode).
// Recomputed fresh every call — callers should memoize on [clips] so a clip reorder, add/delete,
// holdFraction change, or board-position move always produces an up-to-date plan (no stored/stale
// derived actions).
//
// Pan clips never carry the character: if a pan comes before he's entered, he simply isn't rendered
// yet (see entranceFlip / characterEntranceTime in the component); if a pan falls mid-timeline, he
// idles in place on whatever clip he last landed on and resumes once the pan ends.
function deriveAutoCharActions(
  clips: Clip[],
  initX: number,
  initY: number,
  cameraKeyframes: CameraKeyframe[] = [],
  outputW = CANVAS_W_LAND,
  outputH = CANVAS_H_LAND
): CharacterAction[] {
  const focusClips = clips
    .filter((c) => c.type !== "narration" && (c.type === "pan" || c.type === "characterZoom" || c.boardX !== undefined))
    .sort((a, b) => a.startTime - b.startTime);
  if (focusClips.length === 0) return [];

  const actions: CharacterAction[] = [];
  let curX = initX, curY = initY;
  let prev: Clip | null = null;
  let hasEntered = false;
  for (const clip of focusClips) {
    const hf = clip.holdFraction ?? HOLD_FRACTION;
    const holdStart = clip.startTime;
    const holdEnd = clip.startTime + clip.duration * hf;
    const transEnd = clip.startTime + clip.duration;
    const isPan = clip.type === "pan" || clip.type === "characterZoom";

    if (isPan) {
      // Character is either not on yet (handled by characterEntranceTime hiding him) or idling in
      // place on his last landing spot — no action, no position change, just skip past it.
      prev = clip;
      continue;
    }

    // Where the character needs to be standing when the camera finishes settling on this clip
    const arriveX = clip.boardX! + (clip.boardW ?? 0) / 2;
    const arriveY = clip.boardY!;

    // Travel is timed to the camera's OWN transition window so he arrives exactly when it settles:
    // the camera moves from the previous clip's stop during [prevHoldEnd, prevTransEnd] (see
    // generateCameraKeyframes) — mirror that window here rather than a fixed travel duration. The
    // entrance flip onto the first media clip follows the same rule using the preceding pan's window
    // (if any); with nothing preceding it at all, it starts at t=0 and lands at holdStart.
    let travelStart: number, travelEnd: number;
    if (!prev) {
      travelStart = 0;
      travelEnd = Math.max(travelStart + 0.15, holdStart);
    } else {
      const prevHf = prev.holdFraction ?? HOLD_FRACTION;
      travelStart = prev.startTime + prev.duration * prevHf;
      travelEnd = Math.max(travelStart + 0.15, prev.startTime + prev.duration);
    }

    if (!hasEntered) {
      // Entrance: spawn from the visible camera viewport so the flip descends from the top/top-corner
      // in both landscape and portrait output, instead of using a board-space offscreen guess.
      const startCam = cameraKeyframes.length > 0 ? interpolateCameraKeyframes(cameraKeyframes, travelStart) : null;
      const spawn = startCam
        ? viewportEntranceSpawn(arriveX, arriveY, startCam, outputW, outputH)
        : { x: arriveX - CHAR_OFFSCREEN_PAD, y: arriveY - CHAR_ENTRANCE_Y_LIFT };
      actions.push({
        id: `auto_${clip.id}_mv`,
        type: "flip",
        startTime: travelStart,
        duration: travelEnd - travelStart,
        targetX: arriveX, targetY: arriveY,
        startX: spawn.x, startY: spawn.y,
        entranceFlip: true,
      });
      hasEntered = true;
    } else {
      const dx = arriveX - curX, dy = arriveY - curY;
      const dist = Math.hypot(dx, dy);
      if (dist > 20 && travelEnd - travelStart > 0.1) {
        let moveType: CharacterAction["type"];
        const horizontalDist = Math.abs(dx);
        const mildHeightChange = Math.abs(dy) <= SKATE_AUTO_MAX_HEIGHT_DELTA;
        const skateCandidate = horizontalDist >= 800 && horizontalDist <= 2000 && mildHeightChange;
        if (dy > 300 && Math.abs(dx) > 150) moveType = "zipline";     // big drop — slide down a line
        else if (dy < -300 && dist < CHAR_JUMP_DIST * 1.3) moveType = "wallClimb"; // big climb, short reach
        else if (skateCandidate && seededRandom(clip.id + ":skateTo") < 0.5) moveType = "skateTo";
        else if (dist < CHAR_WALK_DIST) moveType = "walkTo";
        else if (dist < CHAR_JUMP_DIST) moveType = "jumpTo";
        else moveType = "grapple";

        actions.push({
          id: `auto_${clip.id}_mv`,
          type: moveType,
          startTime: travelStart,
          duration: travelEnd - travelStart,
          targetX: arriveX, targetY: arriveY,
        });
      }
    }

    // Hold behavior: pointAt beat, then sitAndWatch (video) / explainGesture (long holds) for the rest
    const holdDur = clip.duration * hf;
    const pointDur = Math.min(CHAR_POINT_BEAT, holdDur - 0.1);
    if (pointDur > 0.2) {
      actions.push({
        id: `auto_${clip.id}_pt`,
        type: "pointAt",
        startTime: holdStart,
        duration: pointDur,
        targetX: clip.boardX! + (clip.boardW ?? 0) / 2,
        targetY: clip.boardY! + (clip.boardH ?? 0) * 0.35,
      });
      const restStart = holdStart + pointDur;
      const restDur = holdEnd - restStart;
      if (restDur > 0.6) {
        if (clip.type === "video") {
          actions.push({ id: `auto_${clip.id}_watch`, type: "sitAndWatch", startTime: restStart, duration: restDur, targetX: arriveX, targetY: arriveY });
        } else {
          // Any image hold with meaningful time left after the point beat gets talking gestures —
          // previously gated on holdDur > 4s, which almost no image clip hit, so idle silently won.
          actions.push({ id: `auto_${clip.id}_gest`, type: "explainGesture", startTime: restStart, duration: restDur, targetX: arriveX, targetY: arriveY });
        }
      }
    }

    // Auto emotes — deterministic per clip.id so regenerating the plan never reshuffles them.
    // Max one per hold.
    if (clip.type === "video") {
      if (holdDur > 1.5 && seededRandom(clip.id + ":emoteVideo") < 0.3) {
        const vidStart = holdStart + holdDur * (0.3 + seededRandom(clip.id + ":emoteVideoPos") * 0.4);
        const emoji = seededRandom(clip.id + ":emoteVideoChoice") < 0.5 ? "😂" : "👀";
        if (vidStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: vidStart, duration: 1.5, emoji });
      }
    } else if (pointDur > 0.2 && seededRandom(clip.id + ":emoteArrive") < 0.3) {
      const emoji = seededRandom(clip.id + ":emoteChoice") < 0.5 ? "💡" : "❗";
      const emoteStart = holdStart + pointDur + 0.3;
      if (emoteStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: emoteStart, duration: 1.5, emoji });
    } else if (holdDur > 4 && seededRandom(clip.id + ":emoteMid") < 0.35) {
      const midStart = holdStart + holdDur * 0.5;
      if (midStart + 1.5 < transEnd) actions.push({ id: `auto_${clip.id}_emote`, type: "emote", startTime: midStart, duration: 1.5, emoji: "🤔" });
    }

    curX = arriveX; curY = arriveY;
    prev = clip;
  }

  // Exit: flip offscreen after the last clip's transition ends. Skipped entirely if he never
  // entered (e.g. the timeline is pan-only — nothing to exit from).
  if (prev && hasEntered) {
    const lastTransEnd = prev.startTime + prev.duration;
    const exitCam = cameraKeyframes.length > 0 ? interpolateCameraKeyframes(cameraKeyframes, lastTransEnd) : null;
    const exitTarget = exitCam
      ? viewportEntranceSpawn(curX, curY, exitCam, outputW, outputH)
      : { x: curX + CHAR_OFFSCREEN_PAD * (curX >= initX ? 1 : -1), y: curY - CHAR_ENTRANCE_Y_LIFT };
    actions.push({
      id: `auto_exit`,
      type: "flip",
      startTime: lastTransEnd,
      duration: 1.0,
      targetX: exitTarget.x,
      targetY: exitTarget.y,
    });
  }

  return actions;
}

type CharPoseResult = {
  boardX: number; boardY: number;
  facing: 1 | -1;
  headBob: number;
  bodyLean: number;
  headTilt?: number;
  spinAngle?: number; // full-body rotation around the torso center (flip only) — separate from bodyLean's upper-body-only lean
  leftLegA: number; rightLegA: number;
  leftShinA?: number; rightShinA?: number;
  leftArmA: number; rightArmA: number;
  leftForeA: number; rightForeA: number;
  airY: number;
  emojiText?: string;
  emojiAlpha?: number;
  pointTargetBX?: number;
  pointTargetBY?: number;
  forceHandOpen?: boolean;
  grappleAnchorBX?: number;
  grappleAnchorBY?: number;
  grappleRopeAlpha?: number;
  grappleHookT?: number;
  grappleTaut?: boolean;
  grappleImpact?: number;
  skateboardVisible?: boolean;
  skateFootMode?: "both-planted" | "left-push" | "air";
  skateCrouch?: number;
  skateboardTilt?: number;
  skateSparkAlpha?: number;
  skateMotionAlpha?: number;
  terrainLeftFootY?: number;
  terrainRightFootY?: number;
  terrainGrounded?: boolean;
  actionType?: string;
  hideArms?: boolean;
  pullUpBarAlpha?: number;
  pullUpBarBX?: number;
  pullUpBarBY?: number;
  sitSeated?: boolean;
  danceFootPlant?: boolean;
  danceHipOffset?: number;
  danceMotionAlpha?: number;
  popcornAlpha?: number;
  popcornX?: number;
  popcornY?: number;
  mirrorAlpha?: number;
  mirrorBX?: number;
  mirrorBY?: number;
  mirrorFacing?: 1 | -1;
  surpriseAlpha?: number;
  sparkleAlpha?: number;
  physiquePulse?: number;
  momentumScaleX?: number;
  momentumScaleY?: number;
};

const ACTION_ANIMATION_SLOT: Partial<Record<CharacterAction["type"], string>> = {
  walkTo: "walk",
  jumpTo: "jump",
  flip: "flip",
  zipline: "zipline-hang",
  wallClimb: "climb",
  sitAndWatch: "sit",
  explainGesture: "explain",
  idle: "idle",
};

const FALLBACK_FORWARD_TUCK_FLIP: AuthoredAnimation = {
  id: "fallback_forward_tuck_flip",
  name: "flip",
  keyframes: FORWARD_TUCK_FLIP_KEYFRAMES,
  loop: false,
  createdAt: "fallback",
};

const FALLBACK_SKATE_PEDAL: AuthoredAnimation = {
  id: "fallback_skate_pedal",
  name: "skate-pedal",
  keyframes: SKATE_PEDAL_KEYFRAMES,
  loop: true,
  createdAt: "fallback",
};

const FALLBACK_SKATE_OLLY: AuthoredAnimation = {
  id: "fallback_skate_olly",
  name: "skate-olly",
  keyframes: SKATE_OLLY_KEYFRAMES,
  loop: false,
  createdAt: "fallback",
};

function applyAuthoredPose(base: CharPoseResult, pose: Pose | null, opts: { addSpin?: boolean; addAirborne?: boolean } = {}): CharPoseResult {
  if (!pose) return base;
  return {
    ...base,
    headBob: pose.headBob,
    bodyLean: pose.bodyLean,
    headTilt: pose.headTilt,
    spinAngle: (base.spinAngle ?? 0) + (opts.addSpin ? pose.poseRotation * base.facing : 0),
    leftLegA: pose.leftLegA,
    rightLegA: pose.rightLegA,
    leftShinA: pose.leftShinA,
    rightShinA: pose.rightShinA,
    leftArmA: pose.leftArmA,
    rightArmA: pose.rightArmA,
    leftForeA: pose.leftForeA,
    rightForeA: pose.rightForeA,
    airY: base.airY + (opts.addAirborne === false ? 0 : pose.airborneY),
  };
}

function relaxedSkateArms(pose: Pose | null): Pose | null {
  if (!pose) return pose;
  return {
    ...pose,
    leftArmA: clamp(pose.leftArmA, 0.04, 0.4),
    rightArmA: clamp(pose.rightArmA, -0.4, -0.04),
    leftForeA: clamp(pose.leftForeA, 0.02, 0.32),
    rightForeA: clamp(pose.rightForeA, -0.32, -0.02),
  };
}

function authoredProgressForAction(active: ResolvedCharAction, progress: number): number {
  const tx = active.targetX ?? active.fromX;
  const ty = active.targetY ?? active.fromY;
  const dist = Math.hypot(tx - active.fromX, ty - active.fromY);
  if (active.type === "walkTo") {
    // One authored walk is a single stride. Cadence is speed-proportional via stride length:
    // cycles/sec = travelSpeed / stridePx, so total cycles over the action = distance / stridePx.
    return distanceTravelProgress(progress, dist) * Math.max(1, dist / 220);
  }
  return progress;
}

function distanceTravelProgress(progress: number, distance: number): number {
  const D = Math.max(0.001, distance);
  const scale = Math.min(1, D / (TRAVEL_ACCEL_PX + TRAVEL_DECEL_PX));
  const accelD = Math.min(D * 0.48, TRAVEL_ACCEL_PX * scale);
  const decelD = Math.min(D - accelD, TRAVEL_DECEL_PX * scale);
  const denom = D + accelD + decelD;
  const accelT = (2 * accelD) / denom;
  const cruiseT = Math.max(0, (D - accelD - decelD) / denom);
  const p = clamp(progress, 0, 1);
  if (accelT > 0 && p < accelT) return (accelD * Math.pow(p / accelT, 2)) / D;
  if (p < accelT + cruiseT) return (accelD + (p - accelT) * denom) / D;
  const decelT = Math.max(0.0001, 1 - accelT - cruiseT);
  const u = clamp((p - accelT - cruiseT) / decelT, 0, 1);
  return (D - decelD + decelD * (1 - Math.pow(1 - u, 2))) / D;
}

function lerpCharPose(a: CharPoseResult, b: CharPoseResult, t: number): CharPoseResult {
  const e = easeInOutCubic(clamp(t, 0, 1));
  return {
    ...b,
    boardX: lerp(a.boardX, b.boardX, e),
    boardY: lerp(a.boardY, b.boardY, e),
    facing: b.facing,
    headBob: lerp(a.headBob, b.headBob, e),
    bodyLean: lerp(a.bodyLean, b.bodyLean, e),
    headTilt: lerp(a.headTilt ?? 0, b.headTilt ?? 0, e),
    leftLegA: lerp(a.leftLegA, b.leftLegA, e),
    rightLegA: lerp(a.rightLegA, b.rightLegA, e),
    leftShinA: lerp(a.leftShinA ?? (a.leftLegA + a.leftForeA * 0.5), b.leftShinA ?? (b.leftLegA + b.leftForeA * 0.5), e),
    rightShinA: lerp(a.rightShinA ?? (a.rightLegA + a.rightForeA * 0.5), b.rightShinA ?? (b.rightLegA + b.rightForeA * 0.5), e),
    leftArmA: lerp(a.leftArmA, b.leftArmA, e),
    rightArmA: lerp(a.rightArmA, b.rightArmA, e),
    leftForeA: lerp(a.leftForeA, b.leftForeA, e),
    rightForeA: lerp(a.rightForeA, b.rightForeA, e),
    airY: lerp(a.airY, b.airY, e),
  };
}

function thinkingChinPoint(headTilt: number, visibleSide: -1 | 1, hasFace = false, faceAspect = 1): { x: number; y: number } {
  const torsoTopY = -CHAR_TORSO_RAW;
  const neckTopX = -Math.sin(headTilt) * CHAR_NECK_RAW;
  const neckTopY = torsoTopY - Math.cos(headTilt) * CHAR_NECK_RAW;
  const headR = CHAR_HEAD_R_RAW * (hasFace ? 1.15 : 1);
  const headRY = hasFace ? headR * Math.sqrt(faceAspect) : headR;
  const headCX = neckTopX - Math.sin(headTilt) * headRY * 0.35;
  const headCY = neckTopY - Math.cos(headTilt) * headRY;
  return {
    x: headCX + visibleSide * 4,
    y: headCY + headRY * 0.92,
  };
}

function solveArmToLocalPoint(targetX: number, targetY: number, side: -1 | 1): { armA: number; foreA: number } {
  const shoulderX = 0;
  const shoulderY = -CHAR_TORSO_RAW * 0.85;
  const dx = targetX - shoulderX;
  const dy = targetY - shoulderY;
  const rawD = Math.hypot(dx, dy);
  const d = clamp(rawD, 2, CHAR_ARM_RAW * 2 - 0.001);
  const ux = dx / Math.max(0.001, rawD);
  const uy = dy / Math.max(0.001, rawD);
  const reachable = { x: shoulderX + ux * d, y: shoulderY + uy * d };
  const mid = { x: (shoulderX + reachable.x) / 2, y: (shoulderY + reachable.y) / 2 };
  const h = Math.sqrt(Math.max(0, CHAR_ARM_RAW * CHAR_ARM_RAW - (d / 2) * (d / 2)));
  const px = -uy;
  const py = ux;
  const elbow = { x: mid.x + px * h * side, y: mid.y + py * h * side };
  const upperDx = elbow.x - shoulderX;
  const upperDy = elbow.y - shoulderY;
  const foreDx = reachable.x - elbow.x;
  const foreDy = reachable.y - elbow.y;
  return {
    armA: Math.atan2(-upperDx, upperDy),
    foreA: Math.atan2(-foreDx, foreDy),
  };
}

function standingCharPose(boardX: number, boardY: number, facing: 1 | -1, time: number): CharPoseResult {
  return {
    boardX, boardY, facing,
    headBob: Math.sin(time * 2) * 2,
    bodyLean: 0,
    headTilt: 0,
    leftLegA: 0.12,
    rightLegA: -0.12,
    leftArmA: CHAR_RELAX_ARM_A,
    rightArmA: -CHAR_RELAX_ARM_A,
    leftForeA: CHAR_RELAX_FORE_A,
    rightForeA: -CHAR_RELAX_FORE_A,
    airY: 0,
  };
}

function thinkingPoseBase(
  boardX: number,
  boardY: number,
  facing: 1 | -1,
  time: number,
  actionId: string,
  elapsed: number,
  phase: "lift" | "bend" | "chin" | "hold" | "release",
  hasFace = false,
  faceAspect = 1
): CharPoseResult {
  const thinkingSide: -1 | 1 = facing >= 0 ? 1 : -1;
  const s0 = seededRandom(`${actionId}:head`);
  const s1 = seededRandom(`${actionId}:weight`);
  const s2 = seededRandom(`${actionId}:hand`);
  const s3 = seededRandom(`${actionId}:free`);
  const headMicro = phase === "hold" ? Math.sin((elapsed / 3) * Math.PI * 2 + s0 * Math.PI * 2) * 0.03 : 0;
  const weight = phase === "hold" ? Math.sin((elapsed / 4) * Math.PI * 2 + s1 * Math.PI * 2) : 0;
  const handPulse = phase === "hold"
    ? Math.pow(Math.max(0, Math.sin((elapsed / 2.5) * Math.PI * 2 + s2 * Math.PI * 2)), 6) * 0.05
    : 0;
  const freeSway = phase === "hold" ? Math.sin((elapsed / 3.7) * Math.PI * 2 + s3 * Math.PI * 2) * 0.04 : 0;
  const headTilt = phase === "lift" ? 0 : phase === "bend" ? 0.08 : 0.15 + headMicro;
  const chin = thinkingChinPoint(headTilt, thinkingSide, hasFace, faceAspect);
  const solved = solveArmToLocalPoint(chin.x, chin.y, thinkingSide);
  const pose = standingCharPose(boardX + weight * 3 * facing, boardY, facing, time);

  pose.headBob = Math.sin(time * 2) * 2;
  pose.headTilt = headTilt;
  pose.bodyLean = (phase === "lift" ? 0.015 : 0.035) + weight * 0.015;
  pose.leftLegA = 0.12 + Math.max(0, weight) * 0.04;
  pose.rightLegA = -0.12 + Math.min(0, weight) * 0.04;

  if (thinkingSide === 1) {
    pose.leftArmA = 0.25 + freeSway;
    pose.leftForeA = 0.18 + freeSway * 0.5;
    pose.rightArmA = phase === "lift" ? -0.5 : phase === "bend" ? -0.66 : solved.armA;
    pose.rightForeA = phase === "lift" ? -0.35 : phase === "bend" ? -1.35 : solved.foreA - handPulse;
  } else {
    pose.rightArmA = -0.25 - freeSway;
    pose.rightForeA = -0.18 - freeSway * 0.5;
    pose.leftArmA = phase === "lift" ? 0.5 : phase === "bend" ? 0.66 : solved.armA;
    pose.leftForeA = phase === "lift" ? 0.35 : phase === "bend" ? 1.35 : solved.foreA + handPulse;
  }

  return pose;
}

function physiqueAt(time: number, actions: CharacterAction[]): "slim" | "jacked" {
  return actions.some((action) =>
    action.type === "mirrorCheck" &&
    action.startTime + action.duration * 0.35 <= time
  ) ? "jacked" : "slim";
}

function pullUpArmPose(airY: number): Pick<CharPoseResult, "leftArmA" | "rightArmA" | "leftForeA" | "rightForeA"> {
  const hipYRaw = -CHAR_HIP_RAW;
  const gripYFromHip = -PULLUP_BAR_HEIGHT - airY - hipYRaw;
  const left = solveArmToLocalPoint(-PULLUP_GRIP_HALF_WIDTH, gripYFromHip, -1);
  const right = solveArmToLocalPoint(PULLUP_GRIP_HALF_WIDTH, gripYFromHip, 1);
  return {
    leftArmA: left.armA,
    leftForeA: left.foreA,
    rightArmA: right.armA,
    rightForeA: right.foreA,
  };
}

function aimAngleFromPoint(
  boardX: number,
  boardY: number,
  facing: 1 | -1,
  targetX: number,
  targetY: number
): number {
  const shoulderY = boardY - 129;
  const dxLocal = (targetX - boardX) * facing;
  const dy = targetY - shoulderY;
  return -Math.atan2(dxLocal, dy);
}

function travelPoseBetween(
  time: number,
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  progress: number,
  clips: CharSurfaceClip[],
  running = false,
  craters: readonly StreamCrater[] = []
): CharPoseResult {
  const distance = Math.hypot(targetX - fromX, targetY - fromY);
  const travelProgress = distanceTravelProgress(progress, distance);
  let bx = lerp(fromX, targetX, travelProgress);
  const rawBy = lerp(fromY, targetY, travelProgress);
  const terrain=clips.filter(isBoardSurface) as TerrainClip[];
  let profile = groundProfileY(terrain, craters, bx);
  let autoJumpY=0;
  if(!profile){let left:null|{x:number;y:number}=null,right:null|{x:number;y:number}=null;for(let d=6;d<=126&&!left;d+=6){const p=groundProfileY(terrain,craters,bx-d);if(p)left={x:bx-d,y:p.y};}for(let d=6;d<=126&&!right;d+=6){const p=groundProfileY(terrain,craters,bx+d);if(p)right={x:bx+d,y:p.y};}if(left&&right&&right.x-left.x<=120){const gapT=clamp((bx-left.x)/(right.x-left.x),0,1);profile={y:lerp(left.y,right.y,gapT),imageId:"terrain-gap",slope:0};autoJumpY=-70*4*gapT*(1-gapT);}else{const lip=targetX>=fromX?left:right;if(lip){bx=lip.x;profile=groundProfileY(terrain,craters,bx);}}}
  if(profile&&Math.abs(profile.slope)>Math.tan(50*Math.PI/180)){const downhill=profile.slope>0?1:-1;for(let d=4;d<=60;d+=4){const candidate=groundProfileY(terrain,craters,bx+downhill*d);if(candidate&&Math.abs(candidate.slope)<=Math.tan(50*Math.PI/180)){bx+=downhill*d;profile=candidate;break;}}}
  const by = profile?.y ?? rawBy;
  const facing: 1 | -1 = targetX >= fromX ? 1 : -1;
  const stridePx = running ? 180 : 145;
  const phase = travelProgress * Math.max(1, distance / stridePx) * Math.PI * 2;
  const swing = running ? 0.82 : 0.56;
  const leftPlant = Math.max(0, Math.sin(phase));
  const rightPlant = Math.max(0, Math.sin(phase + Math.PI));
  const bounce = Math.abs(Math.sin(phase)) * (running ? 5 : 2.5);
  return {
    boardX: bx, boardY: by, facing,
    headBob: -bounce,
    bodyLean: (running ? 0.16 : 0.055) * facing + clamp((profile?.slope ?? 0) * .4, -.12, .12),
    leftLegA: Math.sin(phase) * swing - leftPlant * 0.08,
    rightLegA: Math.sin(phase + Math.PI) * swing - rightPlant * 0.08,
    leftArmA: Math.sin(phase + Math.PI) * (running ? 0.62 : 0.4),
    rightArmA: Math.sin(phase) * (running ? 0.62 : 0.4),
    leftForeA: 0.1 + leftPlant * (running ? 0.48 : 0.28),
    rightForeA: -0.1 - rightPlant * (running ? 0.48 : 0.28),
    airY: autoJumpY,
  };
}

function evalCharPoseRaw(
  time: number,
  resolved: ResolvedCharAction[],
  initX: number,
  initY: number,
  clips: CharSurfaceClip[],
  authoredAnimations: Record<string, AuthoredAnimation> = {},
  hasFace = false,
  faceAspect = 1,
  craters: readonly StreamCrater[] = []
): CharPoseResult {
  // Standing/idle pose — angles measured from vertical-down, positive = outward from body midline.
  // Relaxed arms stay visibly away from the torso; the idle bob below is head/breathing only.
  const idlePose = (rx: number, ry: number): CharPoseResult => {
    const t = time * 2;
    return {
      boardX: rx, boardY: ry, facing: 1,
      headBob: Math.sin(t) * 2, bodyLean: 0,
      leftLegA: 0.12, rightLegA: -0.12,
      leftArmA: CHAR_RELAX_ARM_A, rightArmA: -CHAR_RELAX_ARM_A,
      leftForeA: CHAR_RELAX_FORE_A, rightForeA: -CHAR_RELAX_FORE_A,
      airY: 0,
    };
  };

  const active = resolved.find((a) => time >= a.startTime && time < a.startTime + a.duration);

  if (!active) {
    let rx = initX, ry = initY;
    let lastEnd = -1;
    for (const a of resolved) {
      const end = a.startTime + a.duration;
      if (end <= time && end > lastEnd) {
        lastEnd = end;
        if (actionCanChangeRestPosition(a.type) && a.targetX !== undefined) {
          const rest = resolvedActionRestPosition(a, clips, craters);
          rx = rest.x; ry = rest.y;
        } else {
          rx = a.fromX; ry = a.fromY;
        }
      }
    }
    const idle = idlePose(rx, ry);
    const heldBazooka = authoredBazookaDisplayAction(time, resolved);
    if (heldBazooka) {
      const targetX = heldBazooka.targetX ?? rx + 400;
      const targetY = heldBazooka.targetY ?? ry - 110;
      const facing: 1 | -1 = targetX >= rx ? 1 : -1;
      return {
        ...idle,
        facing,
        hideArms: true,
        bodyLean: facing * 0.05,
        pointTargetBX: targetX,
        pointTargetBY: targetY,
      };
    }
    return applyAuthoredPose(idle, sampleAnimation(authoredAnimations.idle, (time * 0.35) % 1));
  }

  const progress = Math.max(0, Math.min(1, (time - active.startTime) / active.duration));
  const slotName = ACTION_ANIMATION_SLOT[active.type];
  const authoredPose = slotName
    ? sampleAnimation(authoredAnimations[slotName], authoredProgressForAction(active, progress))
    : null;
  const stationaryRuntime = stationaryRuntimeForAction(active, clips, time, craters);
  if (stationaryRuntime.hasTarget && stationaryRuntime.phase === "travel") {
    return travelPoseBetween(
      time,
      active.fromX,
      active.fromY,
      stationaryRuntime.targetX,
      stationaryRuntime.targetY,
      clamp((time - active.startTime) / stationaryRuntime.travelDuration, 0, 1),
      clips,
      stationaryRuntime.running,
      craters
    );
  }
  const stationaryActive = stationaryRuntime.action;
  const stationaryProgress = stationaryRuntime.progress;
  const stationaryElapsed = stationaryRuntime.elapsed;

  if (active.type === "walkTo") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const speed = Math.hypot(tx - active.fromX, ty - active.fromY) / Math.max(0.001, active.duration);
    return applyAuthoredPose(travelPoseBetween(time, active.fromX, active.fromY, tx, ty, progress, clips, speed > 520, craters), authoredPose);
  }

  if (active.type === "jumpTo") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const bx = active.fromX + (tx - active.fromX) * progress;
    const by = active.fromY + (ty - active.fromY) * progress;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const airY = -150 * 4 * progress * (1 - progress);

    // Three-phase jump: takeoff / mid-air / landing — limbs never collapse toward center
    let leftLegA: number, rightLegA: number, leftArmA: number, rightArmA: number;
    let leftForeA = 0, rightForeA = 0, headBob = 0;

    if (progress < 0.15) {
      // Takeoff crouch: legs push off (spread slightly), arms swing back
      const t = progress / 0.15;
      leftLegA  = lerp(0,    0.3,  t);
      rightLegA = lerp(0,   -0.3,  t);
      leftArmA  = lerp(0.15,-0.45, t);
      rightArmA = lerp(-0.15,-0.45, t);
    } else if (progress < 0.75) {
      // Mid-air: both legs trail back (symmetric tuck), both arms raised forward for balance
      const t = (progress - 0.15) / 0.6;
      leftLegA  = lerp(0.3, -0.55, t);
      rightLegA = lerp(-0.3,-0.45, t);
      leftForeA  = lerp(0, -0.3, t);
      rightForeA = lerp(0, -0.3, t);
      leftArmA  = lerp(-0.45, -0.5, t);
      rightArmA = lerp(-0.45, -0.5, t);
      headBob   = -Math.sin(Math.PI * t) * 4;
    } else {
      // Landing: legs extend down ahead, arms splay for balance, then settle
      const t = (progress - 0.75) / 0.25;
      leftLegA  = lerp(-0.55, 0.25, t);
      rightLegA = lerp(-0.45, 0.15, t);
      leftArmA  = lerp(-0.5,  CHAR_RELAX_ARM_A,  t);
      rightArmA = lerp(-0.5, -CHAR_RELAX_ARM_A,  t);
      leftForeA  = lerp(-0.3, CHAR_RELAX_FORE_A, t);
      rightForeA = lerp(-0.3, -CHAR_RELAX_FORE_A, t);
    }

    return applyAuthoredPose({
      boardX: bx, boardY: by, facing,
      headBob, bodyLean: 0,
      leftLegA, rightLegA, leftArmA, rightArmA, leftForeA, rightForeA,
      airY,
    }, authoredPose);
  }

  if (active.type === "skateTo") {
    const plan = buildSkateToPlan(active, clips, craters);
    if (!plan) {
      return applyAuthoredPose(idlePose(active.fromX, active.fromY), sampleAnimation(authoredAnimations.idle, 0));
    }
    if (plan.tooHighTarget) {
      const tx = active.targetX ?? active.fromX;
      const ty = active.targetY ?? active.fromY;
      const landingY = resolveGroundY(tx, ty, clips, craters);
      const bx = lerp(active.fromX, tx, progress);
      const by = lerp(active.fromY, landingY, progress);
      const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
      const airY = -150 * 4 * progress * (1 - progress);
      return {
        boardX: bx, boardY: by, facing,
        headBob: 0, bodyLean: 0.04 * facing,
        leftLegA: progress < 0.7 ? -0.5 : 0.25,
        rightLegA: progress < 0.7 ? -0.42 : 0.15,
        leftArmA: progress < 0.7 ? -0.45 : 0.35,
        rightArmA: progress < 0.7 ? -0.45 : -0.35,
        leftForeA: progress < 0.7 ? -0.2 : 0.05,
        rightForeA: progress < 0.7 ? -0.2 : -0.05,
        airY,
      };
    }

    let bx = plan.startX;
    let by = plan.startY;
    let airY = 0;
    let pose: Pose | null = null;
    let skateboardVisible = true;
    let skateFootMode: CharPoseResult["skateFootMode"] = "both-planted";
    let skateCrouch = 6;
    let skateBodyLean = 0;
    let skateboardTilt = 0;
    let skateSparkAlpha = 0;
    let skateMotionAlpha = 0;
    const elapsed = progress * active.duration;

    if (elapsed < plan.mountEnd) {
      const t = plan.mountDur > 0 ? elapsed / plan.mountDur : 1;
      bx = plan.startX;
      by = plan.startY;
      pose = sampleAnimation(authoredAnimations["skate-pedal"] ?? FALLBACK_SKATE_PEDAL, t * 0.16);
      skateFootMode = "both-planted";
      skateCrouch = lerp(4, 8, t);
    } else if (elapsed < plan.airStart) {
      const rollElapsed = elapsed - plan.mountEnd;
      const baseRollT = plan.rollDur > 0 ? clamp(rollElapsed / plan.rollDur, 0, 1) : 1;
      const probeX=lerp(plan.startX,plan.edgeX,baseRollT),probe=groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,probeX);
      const slopeSpeed=1+clamp((probe?.slope??0)*plan.facing*.15,-.15,.15);
      const rollT=clamp(baseRollT*slopeSpeed,0,1);
      bx = lerp(plan.startX, plan.edgeX, rollT);
      const rollGround=groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,bx);
      by = rollGround?.y??plan.startY;
      const behind=groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,bx-plan.facing*20)?.y??by;
      const ahead=groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,bx+plan.facing*20)?.y??by;
      skateboardTilt=Math.atan2(ahead-behind,40)*plan.facing;
      const prepStart = Math.max(plan.mountEnd, plan.airStart - plan.prepDur);
      if (plan.prepDur > 0 && elapsed >= prepStart) {
        const prepT = clamp((elapsed - prepStart) / plan.prepDur, 0, 1);
        pose = sampleAnimation(authoredAnimations["skate-olly"] ?? FALLBACK_SKATE_OLLY, lerp(0, 0.18, prepT));
        skateFootMode = "both-planted";
        skateCrouch = lerp(8, 18, prepT);
        skateBodyLean = 0.15 * plan.facing * prepT;
        skateboardTilt = -0.45 * easeInOutCubic(Math.max(0, (prepT - 0.62) / 0.38));
        skateSparkAlpha = Math.max(0, (prepT - 0.78) / 0.22);
      } else {
        const cycleProgress = plan.rollDistance > 0
          ? (Math.abs(bx - plan.startX) / 400)
          : rollT;
        pose = sampleAnimation(authoredAnimations["skate-pedal"] ?? FALLBACK_SKATE_PEDAL, cycleProgress);
        const cycle = ((cycleProgress % 1) + 1) % 1;
        skateFootMode = cycle < 0.58 ? "left-push" : "both-planted";
        skateCrouch = 7;
      }
    } else if (elapsed < plan.airEnd) {
      const airElapsed = Math.max(0, elapsed - plan.airStart);
      const T = Math.max(0.001, plan.airDur);
      const t = clamp(airElapsed / T, 0, 1);
      const H = Math.max(1, plan.peakHeight);
      const D = plan.heightDelta;
      const g = Math.pow((Math.sqrt(2 * H) + Math.sqrt(Math.max(0.001, 2 * (H + D)))) / T, 2);
      const v0 = -Math.sqrt(2 * g * H);
      bx = plan.edgeX + (plan.gapEndX - plan.edgeX) * t;
      by = plan.launchY;
      airY = v0 * airElapsed + 0.5 * g * airElapsed * airElapsed;
      pose = sampleAnimation(authoredAnimations["skate-olly"] ?? FALLBACK_SKATE_OLLY, lerp(0.18, 0.84, t));
      skateFootMode = "air";
      skateCrouch = lerp(14, 8, Math.sin(Math.PI * t));
      skateBodyLean = plan.facing * lerp(0.15, -0.1, t);
      skateboardTilt = t < 0.35 ? lerp(-0.45, 0, easeInOutCubic(t / 0.35)) : 0;
      skateSparkAlpha = Math.max(0, 1 - t / 0.16);
      skateMotionAlpha = Math.max(0, 1 - Math.abs(t - 0.52) / 0.25);
    } else {
      const t = plan.landDur > 0 ? clamp((elapsed - plan.airEnd) / plan.landDur, 0, 1) : 1;
      const rolloutT = clamp(t / 0.68, 0, 1);
      bx = plan.gapEndX + (plan.finalX - plan.gapEndX) * rolloutT;
      by = resolveGroundY(bx,plan.landingY,clips,craters);
      skateboardVisible = t < 0.72;
      pose = t < 0.68
        ? sampleAnimation(authoredAnimations["skate-olly"] ?? FALLBACK_SKATE_OLLY, lerp(0.84, 1, t / 0.68))
        : sampleAnimation(authoredAnimations.idle, 0) ?? null;
      skateFootMode = "both-planted";
      skateCrouch = t < 0.68 ? lerp(18, 7, rolloutT) : lerp(7, 0, (t - 0.68) / 0.32);
      skateBodyLean = plan.facing * lerp(-0.08, 0, t);
      skateboardTilt = lerp(-0.08, 0, Math.min(1, t * 2));
    }
    pose = relaxedSkateArms(pose);
    if (pose) pose = { ...pose, bodyLean: pose.bodyLean + skateBodyLean };

    return applyAuthoredPose({
      boardX: bx, boardY: by, facing: plan.facing,
      headBob: 0, bodyLean: skateBodyLean,
      leftLegA: 0.12, rightLegA: -0.12,
      leftArmA: CHAR_RELAX_ARM_A, rightArmA: -CHAR_RELAX_ARM_A,
      leftForeA: CHAR_RELAX_FORE_A, rightForeA: -CHAR_RELAX_FORE_A,
      airY,
      skateboardVisible,
      skateFootMode,
      skateCrouch,
      skateboardTilt,
      skateSparkAlpha,
      skateMotionAlpha,
    }, pose, { addAirborne: false });
  }

  if (active.type === "grapple") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    // Anchor point: above and between start+end, biased toward destination
    const anchorBX = active.fromX + (tx - active.fromX) * 0.55;
    const anchorBY = Math.min(active.fromY, ty) - 380;
    const landingY = active.targetY ?? ty;
    const PREP_END = 0.12;
    const FIRE_END = 0.22;
    const PULL_START = 0.32;
    const RELEASE_PREP_START = 0.72;
    const RELEASE_DETACH = 0.85;
    const FREEFALL_END = 0.93;
    const zipT = progress <= PULL_START ? 0 : progress >= RELEASE_DETACH ? 1 : easeInOutCubic((progress - PULL_START) / (RELEASE_DETACH - PULL_START));
    const sag = Math.sin(Math.PI * zipT) * 28;
    let bx = active.fromX;
    let by = active.fromY;
    let bodyLean = 0;
    let leftLegA = 0.12, rightLegA = -0.12;
    let leftArmA = CHAR_RELAX_ARM_A, rightArmA = -CHAR_RELAX_ARM_A;
    let leftForeA = CHAR_RELAX_FORE_A, rightForeA = -CHAR_RELAX_FORE_A;
    let headBob = 0;
    let ropeAlpha = 0;
    let hookT: number | undefined;
    let taut = false;
    let impact = 0;

    const aimA = aimAngleFromPoint(bx, by, facing, anchorBX, anchorBY);
    const setFiringArm = (angle: number, fore = angle) => {
      if (facing >= 0) {
        rightArmA = angle; rightForeA = fore;
      } else {
        leftArmA = angle; leftForeA = fore;
      }
    };
    const setFreeArm = (angle: number, fore = angle * 0.5) => {
      if (facing >= 0) {
        leftArmA = angle; leftForeA = fore;
      } else {
        rightArmA = angle; rightForeA = fore;
      }
    };

    if (progress < PREP_END) {
      const t = easeInOutCubic(progress / PREP_END);
      bodyLean = lerp(0.02, -0.08, easeOutQuad(t)) * facing;
      setFiringArm(lerp(0.08, aimA, t), lerp(0.13, aimA, t));
      setFreeArm(lerp(-0.12, 0.34, t), lerp(-0.05, 0.14, t));
    } else if (progress < FIRE_END) {
      const t = easeOutQuad((progress - PREP_END) / (FIRE_END - PREP_END));
      const recoil = Math.sin(t * Math.PI) * 0.18;
      bodyLean = lerp(-0.08, -0.03, t) * facing;
      setFiringArm(aimA - recoil * 0.35, aimA + recoil);
      setFreeArm(lerp(0.34, 0.42, t), lerp(0.14, 0.18, t));
      ropeAlpha = t;
      hookT = 0.02 + t * 0.18;
    } else if (progress < PULL_START) {
      const t = (progress - FIRE_END) / (PULL_START - FIRE_END);
      setFiringArm(aimA, aimA);
      setFreeArm(0.35, 0.12);
      bodyLean = -0.04 * facing;
      ropeAlpha = 1;
      hookT = t;
    } else if (progress < RELEASE_DETACH) {
      bx = lerp(active.fromX, tx, zipT);
      by = lerp(active.fromY, landingY - 60, zipT) + sag;
      const movingAimA = aimAngleFromPoint(bx, by, facing, anchorBX, anchorBY);
      setFiringArm(movingAimA, movingAimA);
      ropeAlpha = 1;
      hookT = 1;
      taut = true;
      if (progress < 0.45) {
        const t = (progress - PULL_START) / (0.45 - PULL_START);
        bodyLean = lerp(-0.9, -0.72, t) * facing;
        leftLegA = lerp(0.5, 0.65, t); rightLegA = lerp(0.35, 0.52, t);
        setFreeArm(0.75, 0.22);
        headBob = -3;
      } else if (progress < 0.7) {
        const t = (progress - 0.45) / 0.25;
        bodyLean = lerp(-0.72, -0.35, t) * facing;
        leftLegA = lerp(0.65, -0.32, t); rightLegA = lerp(0.52, 0.75, t);
        setFreeArm(lerp(0.75, 0.15, t), lerp(0.22, 0.1, t));
        headBob = -2;
      } else {
        const t = clamp((progress - RELEASE_PREP_START) / (RELEASE_DETACH - RELEASE_PREP_START), 0, 1);
        bodyLean = lerp(-0.35, -0.04, easeOutQuad(t)) * facing;
        leftLegA = lerp(-0.32, -0.62, t); rightLegA = lerp(0.75, -0.5, t);
        setFreeArm(lerp(0.15, -0.2, t), lerp(0.1, -0.02, t));
        headBob = -1;
      }
    } else if (progress < FREEFALL_END) {
      const t = (progress - RELEASE_DETACH) / (FREEFALL_END - RELEASE_DETACH);
      bx = tx;
      by = lerp(landingY - 60, landingY, easeInQuad(t));
      ropeAlpha = 0;
      bodyLean = lerp(-0.04, -0.18, t) * facing;
      leftLegA = lerp(-0.62, -0.72, t); rightLegA = lerp(-0.5, -0.62, t);
      leftForeA = lerp(0.8, 0.65, t); rightForeA = lerp(0.75, 0.62, t);
      setFiringArm(lerp(aimA, 0.05, t), lerp(aimA, 0.1, t));
      setFreeArm(lerp(-0.2, -0.1, t), lerp(-0.02, 0.02, t));
    } else {
      const t = (progress - FREEFALL_END) / (1 - FREEFALL_END);
      bx = tx;
      by = landingY;
      ropeAlpha = 0;
      bodyLean = lerp(-0.18, 0, t) * facing;
      leftLegA = lerp(-0.72, 0.12, t); rightLegA = lerp(-0.62, -0.12, t);
      leftForeA = lerp(0.65, 0.13, t); rightForeA = lerp(0.62, -0.13, t);
      setFiringArm(lerp(0.05, -CHAR_RELAX_ARM_A, t), lerp(0.1, -CHAR_RELAX_FORE_A, t));
      setFreeArm(lerp(-0.2, CHAR_RELAX_ARM_A, t), lerp(-0.1, CHAR_RELAX_FORE_A, t));
      impact = Math.max(0, 1 - t * 1.3);
    }

    return applyAuthoredPose({
      boardX: bx, boardY: by, facing,
      headBob, bodyLean,
      leftLegA, rightLegA, leftArmA, rightArmA, leftForeA, rightForeA,
      airY: 0,
      grappleAnchorBX: anchorBX,
      grappleAnchorBY: anchorBY,
      grappleRopeAlpha: ropeAlpha,
      grappleHookT: hookT,
      grappleTaut: taut,
      grappleImpact: impact,
    }, null);
  }

  if (active.type === "flip") {
    // Forward tuck flip: position stays on the coded parabolic path, while pose + whole-body
    // rotation sample the same keyframes used by Pose Lab's starter "flip" animation. Rotation
    // is intentionally piecewise: slow prep/takeoff, fastest through the tight tuck, then eased
    // open into a flat 2π landing. The draw step rotates around mid-torso, not the feet.
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const landingY = active.targetY ?? ty;
    const bx = active.entranceFlip
      ? lerp(active.fromX, tx, easeOutQuad(progress))
      : lerp(active.fromX, tx, progress);
    const rawBy = active.entranceFlip
      ? lerp(active.fromY, landingY, easeInQuad(progress))
      : lerp(active.fromY, landingY, progress);
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const airY = active.entranceFlip ? 0 : -180 * 4 * progress * (1 - progress);
    const by = progress >= 0.985 ? landingY : rawBy;
    const flipPose = authoredPose ?? sampleAnimation(FALLBACK_FORWARD_TUCK_FLIP, progress);

    return applyAuthoredPose({
      boardX: bx, boardY: by, facing,
      headBob: 0, bodyLean: 0, spinAngle: 0,
      leftLegA: 0, rightLegA: 0, leftArmA: 0, rightArmA: 0, leftForeA: 0, rightForeA: 0,
      airY,
    }, flipPose, { addSpin: true, addAirborne: false });
  }

  if (active.type === "zipline") {
    // Slides down a taut line from a fixed anchor near the start — reuses the grapple rope draw
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const bx = lerp(active.fromX, tx, progress);
    const by = lerp(active.fromY, ty, progress);
    return applyAuthoredPose({
      boardX: bx, boardY: by, facing,
      headBob: Math.sin(progress * Math.PI * 6) * 1.5, bodyLean: 0.15 * facing,
      leftLegA: 0.25, rightLegA: 0.35,
      leftArmA: -0.9, rightArmA: -0.9,
      leftForeA: -0.1, rightForeA: -0.1,
      airY: 0,
      grappleAnchorBX: active.fromX, grappleAnchorBY: active.fromY - 260,
      grappleRopeAlpha: 1,
    }, authoredPose);
  }

  if (active.type === "wallClimb") {
    // Mostly-vertical climb, alternating limbs
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = tx >= active.fromX ? 1 : -1;
    const bx = lerp(active.fromX, tx, progress);
    const by = lerp(active.fromY, ty, progress);
    const climbPhase = progress * 10;
    return applyAuthoredPose({
      boardX: bx, boardY: by, facing,
      headBob: 0, bodyLean: -0.12,
      leftLegA: Math.sin(climbPhase) * 0.4 + 0.15, rightLegA: Math.sin(climbPhase + Math.PI) * 0.4 - 0.15,
      leftArmA: Math.sin(climbPhase + Math.PI) * 0.5 - 0.3, rightArmA: Math.sin(climbPhase) * 0.5 - 0.3,
      leftForeA: 0.1, rightForeA: 0.1,
      airY: 0,
    }, authoredPose);
  }

  if (active.type === "sitAndWatch") {
    const a = stationaryActive;
    const p = stationaryProgress;
    const tx = a.targetX ?? a.fromX;
    const groundY = resolveGroundY(a.fromX, a.targetY ?? a.fromY, clips, craters);
    const facing: 1 | -1 = tx >= a.fromX ? 1 : -1;
    const STEP_END = 0.12;
    const LOWER_END = 0.3;
    const STAND_START = 0.9;
    const seatedBoardY = groundY + CHAR_HIP_RAW;
    const jitter = seededRandom(a.id + ":popcorn") * 0.34;
    const eatingCycle = ((time + jitter) / 2.2) % 1;
    let bx = a.fromX;
    let by = groundY;
    let headBob = 0;
    let bodyLean = 0;
    let headTilt = 0;
    let leftLegA = 0.12;
    let rightLegA = -0.12;
    let leftShinA: number | undefined;
    let rightShinA: number | undefined;
    let leftArmA = CHAR_RELAX_ARM_A;
    let rightArmA = -CHAR_RELAX_ARM_A;
    let leftForeA = CHAR_RELAX_FORE_A;
    let rightForeA = -CHAR_RELAX_FORE_A;
    let popcornAlpha = 0;
    let popcornX = 40;
    let popcornY = 72;
    let sitSeated = false;

    const seatedPose = (aliveT: number) => {
      const lap = solveArmToLocalPoint(8, 8, -1);
      const bucket = solveArmToLocalPoint(16, 8, 1);
      const mouth = solveArmToLocalPoint(8, -104, 1);
      const downToBucket = clamp(aliveT / 0.24, 0, 1);
      const upToMouth = clamp((aliveT - 0.24) / 0.28, 0, 1);
      const chew = clamp((aliveT - 0.52) / 0.18, 0, 1);
      const relax = clamp((aliveT - 0.7) / 0.3, 0, 1);
      const reach = aliveT < 0.24 ? downToBucket : aliveT < 0.52 ? 1 - upToMouth : aliveT < 0.7 ? 0 : relax;
      const lift = aliveT < 0.24 ? 0 : aliveT < 0.52 ? upToMouth : aliveT < 0.7 ? 1 - chew * 0.45 : 0;
      leftArmA = lap.armA;
      leftForeA = lap.foreA;
      rightArmA = lerp(bucket.armA, mouth.armA, lift);
      rightForeA = lerp(bucket.foreA, mouth.foreA, lift) + Math.sin((time + jitter) * 8.1) * 0.035 * reach;
      headBob = Math.sin((time + jitter) * 2.6) * 0.9 + (aliveT >= 0.52 && aliveT < 0.7 ? Math.sin(chew * Math.PI * 3) * 0.8 : 0);
      headTilt = 0.03 + Math.sin((time + jitter) * 1.3) * 0.035;
      bodyLean = 0.08 + Math.sin((time + jitter) * 0.9) * 0.015;
      popcornAlpha = 1;
      popcornX = 16;
      popcornY = 8;
    };

    if (p < STEP_END) {
      const t = easeInOutCubic(p / STEP_END);
      bx = a.fromX;
      bodyLean = lerp(0, 0.12, t);
      leftLegA = lerp(0.12, 0.32, t);
      rightLegA = lerp(-0.12, -0.32, t);
      leftShinA = lerp(0.18, 0.42, t);
      rightShinA = lerp(-0.18, -0.42, t);
      leftArmA = CHAR_RELAX_ARM_A;
      rightArmA = -CHAR_RELAX_ARM_A;
      popcornAlpha = t;
      popcornX = 40;
      popcornY = 72;
    } else if (p < LOWER_END) {
      const t = easeInOutCubic((p - STEP_END) / (LOWER_END - STEP_END));
      by = lerp(groundY, seatedBoardY, t);
      bodyLean = lerp(0.16, 0.08, t);
      leftLegA = lerp(0.32, 1.08, t);
      rightLegA = lerp(-0.32, -1.02, t);
      leftShinA = lerp(0.42, -0.88, t);
      rightShinA = lerp(-0.42, 0.82, t);
      const reachBack = solveArmToLocalPoint(-24, 22, -1);
      leftArmA = lerp(CHAR_RELAX_ARM_A, reachBack.armA, t);
      leftForeA = lerp(CHAR_RELAX_FORE_A, reachBack.foreA, t);
      rightArmA = lerp(-CHAR_RELAX_ARM_A, -0.28, t);
      rightForeA = lerp(-CHAR_RELAX_FORE_A, -0.1, t);
      popcornAlpha = 1;
      popcornX = lerp(40, 16, t);
      popcornY = lerp(72, 8, t);
      sitSeated = t > 0.72;
    } else if (p < STAND_START) {
      by = seatedBoardY;
      leftLegA = 1.08;
      rightLegA = -1.02;
      leftShinA = -0.88;
      rightShinA = 0.82;
      sitSeated = true;
      seatedPose(eatingCycle);
    } else {
      const t = easeInOutCubic((p - STAND_START) / (1 - STAND_START));
      by = lerp(seatedBoardY, groundY, t);
      bodyLean = lerp(0.16, 0, t);
      leftLegA = lerp(1.08, 0.12, t);
      rightLegA = lerp(-1.02, -0.12, t);
      leftShinA = lerp(-0.88, 0.12, t);
      rightShinA = lerp(0.82, -0.12, t);
      const pushHand = solveArmToLocalPoint(-24, 22, -1);
      leftArmA = lerp(pushHand.armA, CHAR_RELAX_ARM_A, t);
      rightArmA = lerp(0.2, -CHAR_RELAX_ARM_A, t);
      leftForeA = lerp(pushHand.foreA, CHAR_RELAX_FORE_A, t);
      rightForeA = lerp(0.1, -CHAR_RELAX_FORE_A, t);
      popcornAlpha = Math.max(0, 1 - t * 1.4);
      popcornX = lerp(16, 40, t);
      popcornY = lerp(8, 72, t);
      sitSeated = t < 0.18;
    }

    return {
      boardX: bx, boardY: by, facing,
      headBob, bodyLean,
      headTilt,
      leftLegA, rightLegA,
      leftShinA, rightShinA,
      leftArmA, rightArmA,
      leftForeA, rightForeA,
      airY: 0,
      sitSeated,
      popcornAlpha,
      popcornX,
      popcornY,
    };
  }

  if (active.type === "explainGesture") {
    // Conversational presenter gestures keyed by wrist targets: side holds, small point-up/down,
    // and modest two-hand spreads. Keep the hands expressive without turning every beat into a pose.
    const localT = Math.max(0, time - active.startTime);
    const seed = seededRandom(active.id);
    const poseTargets = [
      { t: 0, left: { x: -42, y: -54 }, right: { x: 42, y: -56 }, lean: 0.01, tilt: -0.01 },
      { t: 0.16, left: { x: -48, y: -60 }, right: { x: 34, y: -82 }, lean: -0.018, tilt: 0.03 },
      { t: 0.32, left: { x: -46, y: -50 }, right: { x: 52, y: -44 }, lean: 0.022, tilt: 0.005 },
      { t: 0.5, left: { x: -32, y: -80 }, right: { x: 50, y: -58 }, lean: 0.02, tilt: -0.025 },
      { t: 0.68, left: { x: -54, y: -58 }, right: { x: 54, y: -62 }, lean: 0, tilt: 0.012 },
      { t: 0.84, left: { x: -50, y: -42 }, right: { x: 38, y: -78 }, lean: -0.018, tilt: 0.03 },
      { t: 1, left: { x: -42, y: -54 }, right: { x: 42, y: -56 }, lean: 0.01, tilt: -0.01 },
    ];
    const cycle = 3.6 + seed * 0.55;
    const cycleT = ((localT + seed * cycle) % cycle) / cycle;
    let poseIndex = 0;
    while (poseIndex < poseTargets.length - 2 && cycleT > poseTargets[poseIndex + 1].t) poseIndex++;
    const a = poseTargets[poseIndex];
    const b = poseTargets[poseIndex + 1];
    const blend = easeInOutCubic(clamp((cycleT - a.t) / Math.max(0.001, b.t - a.t), 0, 1));
    const handDrift = Math.sin(localT * 8.2 + seed * 8) * 1.35;
    const interpPoint = (pa: { x: number; y: number }, pb: { x: number; y: number }, side: -1 | 1) => ({
      x: lerp(pa.x, pb.x, blend) + side * handDrift,
      y: lerp(pa.y, pb.y, blend) + Math.sin(localT * 6.4 + seed * 5 + side) * 1.05,
    });
    const leftHand = interpPoint(a.left, b.left, -1);
    const rightHand = interpPoint(a.right, b.right, 1);
    const leftArm = solveArmToLocalPoint(leftHand.x, leftHand.y, -1);
    const rightArm = solveArmToLocalPoint(rightHand.x, rightHand.y, 1);
    const intro = easeInOutCubic(clamp(localT / 0.22, 0, 1));
    const exit = easeInOutCubic(clamp((active.startTime + active.duration - time) / 0.22, 0, 1));
    const gestureAlpha = Math.min(intro, exit);
    const facing: 1 | -1 = active.targetX !== undefined && Math.abs(active.targetX - active.fromX) > 3
      ? active.targetX >= active.fromX ? 1 : -1
      : 1;

    return applyAuthoredPose({
      boardX: active.fromX, boardY: active.fromY, facing,
      headBob: Math.sin(localT * 3.4 + seed) * 0.75 - (1 - intro) * 1.4,
      bodyLean: lerp(0, lerp(a.lean, b.lean, blend), gestureAlpha),
      headTilt: lerp(0, lerp(a.tilt, b.tilt, blend), gestureAlpha),
      leftLegA: 0.1 + Math.sin(localT * 0.75) * 0.045,
      rightLegA: -0.1 - Math.sin(localT * 0.75 + 1.3) * 0.045,
      leftArmA: lerp(CHAR_RELAX_ARM_A, leftArm.armA, gestureAlpha),
      rightArmA: lerp(-CHAR_RELAX_ARM_A, rightArm.armA, gestureAlpha),
      leftForeA: lerp(CHAR_RELAX_FORE_A, leftArm.foreA, gestureAlpha),
      rightForeA: lerp(-CHAR_RELAX_FORE_A, rightArm.foreA, gestureAlpha),
      airY: 0,
    }, authoredPose);
  }

  if (active.type === "bazooka") {
    const targetX = active.targetX ?? active.fromX + 400;
    const targetY = active.targetY ?? active.fromY - 110;
    const facing: 1 | -1 = targetX >= active.fromX ? 1 : -1;
    const chained = authoredBazookaIsChained(active, resolved);
    const bendDown = clamp(progress / 0.28, 0, 1);
    const standUp = clamp((progress - 0.56) / 0.14, 0, 1);
    const bend = chained ? 0 : (bendDown * bendDown * (3 - 2 * bendDown)) * (1 - standUp * standUp * (3 - 2 * standUp));
    const fireFraction = authoredBazookaFireFraction(active, resolved);
    const brace = Math.sin(clamp((progress - fireFraction + 0.08) / 0.16, 0, 1) * Math.PI) * 0.12;
    return {
      ...idlePose(active.fromX, active.fromY),
      facing,
      hideArms: true,
      bodyLean: facing * (0.05 + bend * 0.48 - brace),
      headBob: bend * 34 + brace * 18,
      leftLegA: 0.2 + bend * 0.5,
      rightLegA: -0.2 - bend * 0.5,
      leftShinA: 0.3 + bend * 0.46,
      rightShinA: -0.3 - bend * 0.46,
      pointTargetBX: targetX,
      pointTargetBY: targetY,
    };
  }

  if (active.type === "pullUps") {
    const a = stationaryActive;
    const p = stationaryProgress;
    const tx = a.targetX ?? a.fromX;
    const ty = resolveGroundY(tx, a.targetY ?? a.fromY, clips, craters);
    const facing: 1 | -1 = tx >= a.fromX ? 1 : -1;
    const APPROACH_END = 0.1;
    const HANG_END = 0.15;
    const DISMOUNT_START = 0.9;
    let bx = tx;
    let by = ty;
    let airY = -40;
    let leftLegA = 0.08, rightLegA = -0.08;
    let leftShinA: number | undefined;
    let rightShinA: number | undefined;
    let legBackBend = 0.25;
    let bodyLean = 0;
    let headBob = 0;
    let arms = pullUpArmPose(airY);

    if (p < APPROACH_END) {
      const t = easeInOutCubic(p / APPROACH_END);
      bx = lerp(a.fromX, tx, t);
      by = lerp(a.fromY, ty, t);
      airY = 0;
      const reach = t;
      leftLegA = Math.sin(t * Math.PI * 2) * 0.2;
      rightLegA = Math.sin(t * Math.PI * 2 + Math.PI) * 0.2;
      legBackBend = lerp(0.1, 0.25, reach);
      arms = {
        leftArmA: lerp(CHAR_RELAX_ARM_A, -0.75, reach),
        rightArmA: lerp(-CHAR_RELAX_ARM_A, 0.75, reach),
        leftForeA: lerp(CHAR_RELAX_FORE_A, -0.35, reach),
        rightForeA: lerp(-CHAR_RELAX_FORE_A, 0.35, reach),
      };
    } else if (p < HANG_END) {
      const t = easeInOutCubic((p - APPROACH_END) / (HANG_END - APPROACH_END));
      airY = lerp(0, -40, t);
      arms = pullUpArmPose(airY);
      leftLegA = lerp(0.12, 0.07, t);
      rightLegA = lerp(-0.12, -0.05, t);
      legBackBend = 0.25;
    } else if (p < DISMOUNT_START) {
      const repSpan = DISMOUNT_START - HANG_END;
      const reps = Math.max(1, Math.round(a.duration / 4 * 3));
      const loop = ((p - HANG_END) / repSpan) * reps;
      const repT = loop - Math.floor(loop);
      const lift = Math.pow(Math.max(0, Math.sin(Math.PI * repT)), 0.75);
      airY = lerp(-40, -103, easeInOutCubic(lift));
      arms = pullUpArmPose(airY);
      bodyLean = Math.sin(loop * Math.PI * 2 + 0.7) * 0.03;
      headBob = -lift * 2;
      const kneeEase = easeInOutCubic(Math.min(1, lift * 1.2));
      leftLegA = lerp(0.07, 0.11, kneeEase);
      rightLegA = lerp(-0.05, -0.08, kneeEase);
      legBackBend = 0.25 + lift * 0.04;
    } else {
      const t = easeInOutCubic((p - DISMOUNT_START) / (1 - DISMOUNT_START));
      airY = lerp(-40, 0, t);
      arms = t < 0.35 ? pullUpArmPose(airY) : {
        leftArmA: lerp(-0.45, CHAR_RELAX_ARM_A, (t - 0.35) / 0.65),
        rightArmA: lerp(0.45, -CHAR_RELAX_ARM_A, (t - 0.35) / 0.65),
        leftForeA: lerp(-0.2, CHAR_RELAX_FORE_A, (t - 0.35) / 0.65),
        rightForeA: lerp(0.2, -CHAR_RELAX_FORE_A, (t - 0.35) / 0.65),
      };
      const absorb = Math.sin(Math.PI * t);
      if (t < 0.58) {
        const dropT = t / 0.58;
        leftLegA = lerp(0.07, 0.04, dropT);
        rightLegA = lerp(-0.05, -0.04, dropT);
        legBackBend = lerp(0.25, 0.08, dropT);
        leftShinA = lerp(-0.25, -0.04, dropT);
        rightShinA = lerp(0.25, 0.04, dropT);
      } else {
        const landT = (t - 0.58) / 0.42;
        leftLegA = lerp(0.04, 0.12, landT) + absorb * 0.03;
        rightLegA = lerp(-0.04, -0.12, landT) - absorb * 0.03;
        legBackBend = lerp(0.08, 0.02, landT);
        leftShinA = lerp(-0.04, 0.02, landT);
        rightShinA = lerp(0.04, -0.02, landT);
      }
      headBob = absorb * 2;
    }
    if (p < DISMOUNT_START) {
      leftShinA = -legBackBend;
      rightShinA = legBackBend;
    }

    return {
      boardX: bx, boardY: by, facing,
      headBob, bodyLean,
      headTilt: 0,
      leftLegA, rightLegA,
      leftShinA, rightShinA,
      leftArmA: arms.leftArmA, rightArmA: arms.rightArmA,
      leftForeA: arms.leftForeA, rightForeA: arms.rightForeA,
      airY,
      pullUpBarAlpha: p < 0.15 ? p / 0.15 : p > 0.92 ? Math.max(0, (1 - p) / 0.08) : 1,
      pullUpBarBX: tx,
      pullUpBarBY: ty,
    };
  }

  if (active.type === "mirrorCheck") {
    const a = stationaryActive;
    const p = stationaryProgress;
    const tx = a.targetX ?? a.fromX;
    const ty = resolveGroundY(tx, a.targetY ?? a.fromY, clips, craters);
    const facing: 1 | -1 = tx >= a.fromX ? 1 : -1;
    let pose = standingCharPose(tx, ty, facing, time);
    let surpriseAlpha = 0;
    let sparkleAlpha = 0;
    let physiquePulse = 0;

    if (p < 0.15) {
      const t = p / 0.15;
      const bx = lerp(a.fromX, tx, easeInOutCubic(t));
      const rawBy = lerp(a.fromY, ty, easeInOutCubic(t));
      const phase = t * Math.PI * 2;
      pose = {
        ...standingCharPose(bx, rawBy, facing, time),
        headBob: Math.sin(phase * 2) * 1.5,
        bodyLean: Math.sin(phase) * 0.04,
        leftLegA: Math.sin(phase) * 0.35,
        rightLegA: Math.sin(phase + Math.PI) * 0.35,
        leftArmA: Math.sin(phase + Math.PI) * 0.24,
        rightArmA: Math.sin(phase) * 0.24,
        leftForeA: Math.sin(phase + Math.PI) * 0.1,
        rightForeA: Math.sin(phase) * 0.1,
      };
    } else if (p < 0.35) {
      const t = (p - 0.15) / 0.2;
      surpriseAlpha = Math.max(0, 1 - Math.abs(t - 0.35) / 0.35);
      pose.headTilt = lerp(0, 0.13, easeOutQuad(t));
      pose.headBob = -Math.sin(Math.PI * t) * 4;
      pose.leftArmA = lerp(CHAR_RELAX_ARM_A, 0.28, t);
      pose.rightArmA = lerp(-CHAR_RELAX_ARM_A, -0.28, t);
      pose.leftForeA = lerp(CHAR_RELAX_FORE_A, 0.28, t);
      pose.rightForeA = lerp(-CHAR_RELAX_FORE_A, -0.28, t);
    } else if (p < 0.55) {
      const t = (p - 0.35) / 0.2;
      pose = thinkingPoseBase(tx, ty, facing, time, a.id, stationaryElapsed, "hold");
      pose.headTilt = lerp(-0.06, 0.18, easeInOutCubic(t));
      physiquePulse = Math.max(0, 1 - Math.abs(t - 0.28) / 0.28);
    } else if (p < 0.8) {
      const t = (p - 0.55) / 0.25;
      const tremble = Math.sin(time * 42 + seededRandom(`${a.id}:flex`) * 10) * 0.02;
      pose.bodyLean = Math.sin(time * 11) * 0.015;
      pose.headTilt = 0.08;
      pose.leftArmA = 1.18 + tremble;
      pose.rightArmA = -1.18 - tremble;
      pose.leftForeA = 2.15 - tremble;
      pose.rightForeA = -2.15 + tremble;
      pose.leftLegA = 0.18;
      pose.rightLegA = -0.18;
      sparkleAlpha = Math.min(1, t * 2);
    } else {
      const t = (p - 0.8) / 0.2;
      sparkleAlpha = Math.max(0, 1 - t * 0.4);
      pose.headTilt = 0.08;
      pose.leftLegA = 0.22;
      pose.rightLegA = -0.22;
      if (t < 0.5) {
        pose.leftArmA = lerp(1.18, 0.8, t * 2);
        pose.rightArmA = lerp(-1.18, -0.8, t * 2);
        pose.leftForeA = lerp(2.15, 1.05, t * 2);
        pose.rightForeA = lerp(-2.15, -1.05, t * 2);
      } else {
        const q = (t - 0.5) / 0.5;
        pose.leftArmA = lerp(0.8, 1.15, q);
        pose.leftForeA = lerp(1.05, 2.05, q);
        pose.rightArmA = lerp(-0.8, -0.35, q);
        pose.rightForeA = lerp(-1.05, -0.65, q);
      }
    }

    return {
      ...pose,
      airY: 0,
      mirrorAlpha: p < 0.12 ? p / 0.12 : p > 0.94 ? Math.max(0, (1 - p) / 0.06) : 1,
      mirrorBX: tx + facing * MIRROR_OFFSET,
      mirrorBY: ty,
      mirrorFacing: facing,
      surpriseAlpha,
      sparkleAlpha,
      physiquePulse,
    };
  }

  if (active.type === "dance") {
    const a = stationaryActive;
    const tx = a.targetX ?? a.fromX;
    const groundY = resolveGroundY(tx, a.targetY ?? a.fromY, clips, craters);
    const facing: 1 | -1 = tx >= a.fromX ? 1 : -1;
    const elapsed = Math.max(0, stationaryElapsed);
    const edge = Math.min(1, elapsed / 0.22, (a.duration - elapsed) / 0.22);
    const phase = (elapsed / 0.9) * Math.PI * 2;
    const hipWave = Math.sin(phase) * clamp(edge, 0, 1);
    const hit = Math.pow(Math.abs(Math.sin(phase)), 1.7) * clamp(edge, 0, 1);
    const hipOffset = hipWave * 14;
    return {
      boardX: tx + hipOffset * facing,
      boardY: groundY,
      facing,
      headBob: -hit * 3,
      bodyLean: 0.12 - hipWave * 0.1,
      headTilt: -hipWave * 0.04,
      leftLegA: 0.46,
      rightLegA: -0.46,
      leftShinA: 0.18,
      rightShinA: -0.18,
      leftArmA: 0.72 - hipWave * 0.28,
      rightArmA: -0.72 - hipWave * 0.28,
      leftForeA: 1.02 - hipWave * 0.18,
      rightForeA: -1.02 - hipWave * 0.18,
      airY: 0,
      danceFootPlant: true,
      danceHipOffset: hipOffset,
      danceMotionAlpha: Math.max(0, (Math.abs(hipWave) - 0.58) / 0.42),
    };
  }

  if (active.type === "pointAt") {
    const tx = active.targetX ?? active.fromX, ty = active.targetY ?? active.fromY;
    const facing: 1 | -1 = (tx - active.fromX) >= 0 ? 1 : -1;
    const armProgress = Math.min(1, progress / 0.3);
    // Weight shift: stance leg slightly offset toward target side
    const stanceShift = facing === 1 ? 0.08 : -0.08;
    return {
      boardX: active.fromX, boardY: active.fromY, facing,
      headBob: 0, bodyLean: 0,
      leftLegA: stanceShift, rightLegA: -stanceShift * 0.5,
      // Arm defaults — will be overridden in draw for the pointing arm
      leftArmA: CHAR_RELAX_ARM_A, rightArmA: -CHAR_RELAX_ARM_A,
      leftForeA: CHAR_RELAX_FORE_A, rightForeA: -CHAR_RELAX_FORE_A,
      airY: 0,
      pointTargetBX: active.fromX + (tx - active.fromX) * armProgress,
      pointTargetBY: active.fromY + (ty - active.fromY) * armProgress,
    };
  }

  if (active.type === "emote") {
    const a = stationaryActive;
    const elapsed = stationaryElapsed;
    const p = stationaryProgress;
    const transitionScale = Math.min(1, Math.max(0.35, a.duration / 2));
    const liftEnd = 0.2 * transitionScale;
    const bendEnd = liftEnd + 0.24 * transitionScale;
    const chinEnd = bendEnd + 0.16 * transitionScale;
    const releaseDur = 0.2 * transitionScale;
    const releaseStart = Math.max(chinEnd, a.duration - releaseDur);
    const fallbackFacing: 1 | -1 = (a.targetX ?? a.fromX) >= a.fromX ? 1 : -1;
    const priorPose = stationaryRuntime.didWalkIn
      ? standingCharPose(a.fromX, a.fromY, fallbackFacing, time)
      : evalCharPoseRaw(
          a.startTime,
          resolved.filter((action) => action.id !== a.id),
          initX,
          initY,
          clips,
          authoredAnimations,
          hasFace,
          faceAspect
        );
    const facing = priorPose.facing ?? 1;
    const standing = standingCharPose(a.fromX, a.fromY, facing, time);
    const liftPose = thinkingPoseBase(a.fromX, a.fromY, facing, time, a.id, elapsed, "lift", hasFace, faceAspect);
    const bendPose = thinkingPoseBase(a.fromX, a.fromY, facing, time, a.id, elapsed, "bend", hasFace, faceAspect);
    const chinPose = thinkingPoseBase(a.fromX, a.fromY, facing, time, a.id, elapsed, "chin", hasFace, faceAspect);
    const holdPose = thinkingPoseBase(a.fromX, a.fromY, facing, time, a.id, elapsed, "hold", hasFace, faceAspect);
    let pose: CharPoseResult;

    if (elapsed < liftEnd) {
      pose = lerpCharPose(priorPose, liftPose, liftEnd > 0 ? elapsed / liftEnd : 1);
    } else if (elapsed < bendEnd) {
      pose = lerpCharPose(liftPose, bendPose, (elapsed - liftEnd) / Math.max(0.001, bendEnd - liftEnd));
    } else if (elapsed < chinEnd) {
      pose = lerpCharPose(bendPose, chinPose, (elapsed - bendEnd) / Math.max(0.001, chinEnd - bendEnd));
    } else if (elapsed < releaseStart) {
      pose = holdPose;
    } else {
      const releaseT = easeOutQuad((elapsed - releaseStart) / Math.max(0.001, a.duration - releaseStart));
      pose = lerpCharPose(holdPose, standing, releaseT);
    }

    const emojiAlpha = p <= 0.2
      ? p / 0.2
      : p <= 0.8 ? 1
      : Math.max(0, 1 - (p - 0.8) / 0.2);
    return {
      ...pose,
      airY: 0,
      emojiText: a.emoji, emojiAlpha,
    };
  }

  return idlePose(active.fromX, active.fromY);
}

function momentumIntensityAt(time: number, resolved: ResolvedCharAction[]): number {
  const active = resolved.find((a) => time >= a.startTime && time < a.startTime + a.duration);
  if (!active) return 1;
  if (["pullUps", "sitAndWatch", "mirrorCheck", "dance", "bazooka"].includes(active.type)) return 0.3;
  return 1;
}

function evalCharAtTime(
  time: number,
  resolved: ResolvedCharAction[],
  initX: number,
  initY: number,
  clips: CharSurfaceClip[],
  authoredAnimations: Record<string, AuthoredAnimation> = {},
  hasFace = false,
  faceAspect = 1,
  craters: readonly StreamCrater[] = []
): CharPoseResult {
  const base = evalCharPoseRaw(time, resolved, initX, initY, clips, authoredAnimations, hasFace, faceAspect, craters);
  const dt = MOMENTUM_SAMPLE_DT;
  const sampleRoot = (t: number) => {
    const p = evalCharPoseRaw(Math.max(0, t), resolved, initX, initY, clips, authoredAnimations, hasFace, faceAspect, craters);
    return { x: p.boardX, y: p.boardY + p.airY };
  };
  const r0 = sampleRoot(time);
  const r1 = sampleRoot(time - dt);
  const r2 = sampleRoot(time - dt * 2);
  const rawV = { x: (r0.x - r1.x) / dt, y: (r0.y - r1.y) / dt };
  const priorV = { x: (r1.x - r2.x) / dt, y: (r1.y - r2.y) / dt };
  const velocity = {
    x: lerp(priorV.x, rawV.x, VELOCITY_EMA_ALPHA),
    y: lerp(priorV.y, rawV.y, VELOCITY_EMA_ALPHA),
  };
  const intensity = momentumIntensityAt(time, resolved);
  const active = resolved.find((a) => time >= a.startTime && time < a.startTime + a.duration);
  const actionAge = active ? time - active.startTime : Infinity;
  const actionTail = active ? active.startTime + active.duration - time : Infinity;
  const terrainGrounded=isGrounded({actionType:active?.type??"idle",airY:base.airY,skateAirborne:base.skateFootMode==="air",grappleAirborne:active?.type==="grapple"&&actionAge>=active.duration*.32&&actionAge<active.duration*.93});
  const leanEase = Math.min(1, actionAge * LEAN_RESPONSE_HZ, actionTail * LEAN_RESPONSE_HZ);
  const leanExtra = clamp(velocity.x * LEAN_K, -LEAN_MAX, LEAN_MAX) * easeInOutCubic(clamp(leanEase, 0, 1)) * intensity;

  // Replay a short fixed-step window. This is the same spring-damper as a stateful simulation,
  // but deterministic under seeking, dropped preview frames, and offline export.
  let offset = 0;
  let offsetVelocity = 0;
  const steps = Math.ceil(LIMB_HISTORY_SEC / dt);
  let previousVelocityX = 0;
  for (let i = steps; i >= 0; i--) {
    const t = time - i * dt;
    const q0 = sampleRoot(t);
    const q1 = sampleRoot(t - dt);
    const q2 = sampleRoot(t - dt * 2);
    const vxNow = ((q0.x - q1.x) / dt) * VELOCITY_EMA_ALPHA + ((q1.x - q2.x) / dt) * (1 - VELOCITY_EMA_ALPHA);
    const ax = (vxNow - previousVelocityX) / dt;
    previousVelocityX = vxNow;
    const drive = -LIMB_ACCEL_J * ax * base.facing * momentumIntensityAt(t, resolved);
    const acceleration = -LIMB_SPRING_K * offset - LIMB_SPRING_C * offsetVelocity + drive;
    offsetVelocity += acceleration * dt;
    offset = clamp(offset + offsetVelocity * dt, -LIMB_OFFSET_MAX, LIMB_OFFSET_MAX);
  }

  let scaleX = 1;
  let scaleY = 1;
  const airborneVelocity = velocity.y;
  if (airborneVelocity < TAKEOFF_VY_THRESHOLD) {
    const takeoffEnvelope = active ? 1 - clamp(actionAge / TAKEOFF_STRETCH_SEC, 0, 1) * 0.35 : 1;
    const amount = clamp(-airborneVelocity / 700, 0, 1) * takeoffEnvelope * intensity;
    scaleX = lerp(1, TAKEOFF_STRETCH_X, amount);
    scaleY = lerp(1, TAKEOFF_STRETCH_Y, amount);
  } else {
    for (let ago = 0; ago <= SQUASH_RECOVER_SEC; ago += dt) {
      const a0 = sampleRoot(time - ago);
      const a1 = sampleRoot(time - ago - dt);
      const impactVy = (a0.y - a1.y) / dt;
      if (impactVy > LANDING_VY_THRESHOLD) {
        const recover = 1 - clamp(ago / SQUASH_RECOVER_SEC, 0, 1);
        const amount = clamp(impactVy / 900, 0, 1) * recover * intensity;
        scaleX = lerp(1, LANDING_SQUASH_X, amount);
        scaleY = lerp(1, LANDING_SQUASH_Y, amount);
        break;
      }
    }
  }

  return {
    ...base,
    bodyLean: base.bodyLean + leanExtra,
    leftArmA: base.leftArmA + offset,
    rightArmA: base.rightArmA - offset,
    leftLegA: base.leftLegA + offset * 0.82,
    rightLegA: base.rightLegA - offset * 0.82,
    momentumScaleX: scaleX,
    momentumScaleY: scaleY,
    actionType:active?.type??"idle",
    terrainGrounded,
    terrainLeftFootY:terrainGrounded?(groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,base.boardX-14)?.y??base.boardY)-base.boardY:0,
    terrainRightFootY:terrainGrounded?(groundProfileY(clips.filter(isBoardSurface) as TerrainClip[],craters,base.boardX+14)?.y??base.boardY)-base.boardY:0,
  };
}

function liveRuntimeSeconds(runtime: LiveCharacterRuntime, wallMs: number): number {
  return Math.max(0, (wallMs - runtime.startWallMs) / 1000);
}

function liveResolvedActions(runtime: LiveCharacterRuntime, clips: Clip[], craters: readonly StreamCrater[] = []): ResolvedCharAction[] {
  return resolveCharActions(runtime.actions, runtime.initX, runtime.initY, clips, [], 0, craters);
}

function evalLiveCharacterAtWallTime(
  runtime: LiveCharacterRuntime,
  wallMs: number,
  clips: Clip[],
  authoredAnimations: Record<string, AuthoredAnimation> = {},
  hasFace = false,
  faceAspect = 1,
  craters: readonly StreamCrater[] = []
): CharPoseResult {
  const t = liveRuntimeSeconds(runtime, wallMs);
  const resolved = liveResolvedActions(runtime, clips, craters);
  let pose = evalCharAtTime(t, resolved, runtime.initX, runtime.initY, clips, authoredAnimations, hasFace, faceAspect, craters);
  if (runtime.blendFromPose && runtime.blendStartWallMs > 0) {
    const blendT = clamp((wallMs - runtime.blendStartWallMs) / Math.max(0.001, runtime.blendDuration * 1000), 0, 1);
    if (blendT < 1) pose = lerpCharPose(runtime.blendFromPose, pose, blendT);
  }
  return pose;
}

function boardCharacterDrawEvaluators(): BoardCharacterDrawEvaluators {
  return {
    evalCharAtTime: evalCharAtTime as unknown as BoardCharacterDrawEvaluators["evalCharAtTime"],
    physiqueAt: physiqueAt as unknown as BoardCharacterDrawEvaluators["physiqueAt"],
  };
}

function characterHeadSpeechAnchor(
  pose: CharPoseResult,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  width: number,
  height: number,
  hasFace: boolean,
  faceAspect: number,
  physique: "slim" | "jacked" = "slim",
): SpeechBubbleAnchor {
  const s = sf;
  const sx = (pose.boardX - cam.cameraX) * sf + width / 2;
  const sy = (pose.boardY - cam.cameraY) * sf + height / 2;
  const isJacked = physique === "jacked";
  const torsoLen = STREAM_CHARACTER_GEOMETRY.torsoRaw * s;
  const neckLen = STREAM_CHARACTER_GEOMETRY.neckRaw * s * (isJacked ? 0.72 : 1);
  const headR = STREAM_CHARACTER_GEOMETRY.headRaw * s * (hasFace ? 1.15 : 1);
  const headRY = hasFace ? headR * Math.sqrt(clamp(faceAspect, 0.75, 1.6)) : headR;
  const hipY = (-STREAM_CHARACTER_GEOMETRY.hipRaw + (pose.skateboardVisible ? (pose.skateCrouch ?? 6) : 0)) * s + pose.headBob * s * 0.25;
  const headTilt = pose.headTilt ?? 0;
  const neckTopX = -Math.sin(headTilt) * neckLen;
  const neckTopY = -torsoLen - Math.cos(headTilt) * neckLen;
  const headCX = neckTopX - Math.sin(headTilt) * headRY * 0.35;
  const headCY = neckTopY - Math.cos(headTilt) * headRY;
  const leanCos = Math.cos(pose.bodyLean);
  const leanSin = Math.sin(pose.bodyLean);
  let localX = headCX * leanCos - headCY * leanSin;
  let localY = hipY + headCX * leanSin + headCY * leanCos;
  if (pose.spinAngle) {
    const spinCenterY = hipY - torsoLen / 2;
    const dx = localX;
    const dy = localY - spinCenterY;
    const cos = Math.cos(pose.spinAngle);
    const sin = Math.sin(pose.spinAngle);
    localX = dx * cos - dy * sin;
    localY = spinCenterY + dx * sin + dy * cos;
  }
  return {
    x: sx + localX * pose.facing * (pose.momentumScaleX ?? 1),
    y: sy + pose.airY * s + localY * (pose.momentumScaleY ?? 1),
    facing: pose.facing,
  };
}

function poseAllowsSpeechBubble(pose: CharPoseResult): boolean {
  const action = pose.actionType ?? "idle";
  if (pose.grappleRopeAlpha || pose.pullUpBarAlpha || pose.skateboardVisible || pose.spinAngle || Math.abs(pose.airY) > 18) return false;
  return ![
    "walkTo",
    "runTo",
    "walk",
    "run",
    "jumpTo",
    "jump",
    "flip",
    "grapple",
    "zipline",
    "wallClimb",
    "skateTo",
    "pullUps",
    "pullups",
    "sitAndWatch",
    "dance",
    "mirrorCheck",
    "bazooka",
    "forceChoke",
    "eliminated",
  ].includes(action);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Board2Page() {
  const { data: session } = useSession();

  const [clips, setClips] = useState<Clip[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [mutedLayers, setMutedLayers] = useState<Record<number, boolean>>({});
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [canvasAspect, setCanvasAspect] = useState<"16:9" | "9:16">("16:9");
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [timelineScroll, setTimelineScroll] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [previewHeight, setPreviewHeight] = useState(PREVIEW_DEFAULT_H_PX);
  const [ambientVideoEnabled, setAmbientVideoEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const saved = window.localStorage.getItem(AMBIENT_VIDEO_STORAGE_KEY);
      return saved === null ? true : saved !== "0";
    } catch {
      return true;
    }
  });
  const [isRecording, setIsRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [transcribingNarrationId, setTranscribingNarrationId] = useState<string | null>(null);
  const [boardZoom, setBoardZoom] = useState(0.18);
  const [boardPan, setBoardPan] = useState({ x: 20, y: 20 });
  const [toast, setToast] = useState<string | null>(null);
  const [cameraKeyframes, setCameraKeyframes] = useState<CameraKeyframe[]>([]);
  const [cameraMode, setCameraMode] = useState<CameraMode>("clips");
  const [cameraKeyframeMode, setCameraKeyframeMode] = useState<CameraMode>("clips");
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [dividerTooltip, setDividerTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const [keyframesOutOfDate, setKeyframesOutOfDate] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; timeSec: number; clipId?: string } | null>(null);
  const [clipboardReady, setClipboardReady] = useState(false);

  // ── Mobile ──
  const [isMobile, setIsMobile] = useState(false);
  const [isPortrait, setIsPortrait] = useState(false);
  const [mobileDrawer, setMobileDrawer] = useState<"media" | "props" | null>(null);
  const [mobileLongPressClipId, setMobileLongPressClipId] = useState<string | null>(null);

  // ── Save / Load ──
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("My Board");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingProject, setIsLoadingProject] = useState(false);

  // ── Annotations ──
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pointer");
  const [annotationColor, setAnnotationColor] = useState("#cc2200");
  const [annotationFont, setAnnotationFont] = useState("Caveat");
  const [annotationHighlightStyle, setAnnotationHighlightStyle] = useState<"rect" | "underline" | "curlyBrace">("rect");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationText, setEditingAnnotationText] = useState("");
  const [annotationToolbarOpen, setAnnotationToolbarOpen] = useState(false);
  const [annotationEmoji, setAnnotationEmoji] = useState("🎯");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [penPreviewPoints, setPenPreviewPoints] = useState<Array<{ x: number; y: number }> | null>(null);

  // ── Character ──
  const [showCharacter, setShowCharacter] = useState(false);
  const [characterActions, setCharacterActions] = useState<CharacterAction[]>([]);
  const [characterMode, setCharacterMode] = useState<"auto" | "manual">("auto");
  const [characterSkin, setCharacterSkin] = useState<CharacterSkin>("stick");
  const [showCharacter2, setShowCharacter2] = useState(false);
  const [characterActions2, setCharacterActions2] = useState<CharacterAction[]>([]);
  const [characterMode2, setCharacterMode2] = useState<"auto" | "manual">("auto");
  const [characterSkin2, setCharacterSkin2] = useState<CharacterSkin>("stick");
  const [characterViseme, setCharacterViseme] = useState<Viseme | "auto">("auto");
  const [characterViseme2, setCharacterViseme2] = useState<Viseme | "auto">("auto");
  const [characterStart, setCharacterStart] = useState<{ x: number; y: number } | null>(null);
  const [characterStart2, setCharacterStart2] = useState<{ x: number; y: number } | null>(null);
  const [characterStartPickId, setCharacterStartPickId] = useState<CharacterId | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<CharacterId>("c1");
  const [characterAddMode, setCharacterAddMode] = useState<CharacterAddMode | null>(null);
  const [characterToolbarOpen, setCharacterToolbarOpen] = useState(false);
  const [characterPanelOpen, setCharacterPanelOpen] = useState(false);
  const [characterEmoji, setCharacterEmoji] = useState("🤔");
  const [characterEmojiPickerOpen, setCharacterEmojiPickerOpen] = useState(false);
  const [characterFace, setCharacterFace] = useState<CharacterFaceSettings | null>(null);
  const [characterFace2, setCharacterFace2] = useState<CharacterFaceSettings | null>(null);
  const [facePickerOpen, setFacePickerOpen] = useState(false);
  const [faceCropSource, setFaceCropSource] = useState<{ url: string; name: string } | null>(null);
  const [faceCrop, setFaceCrop] = useState({ x: 0.25, y: 0.12, w: 0.5, h: 0.68 });
  const [faceMouthAnchor, setFaceMouthAnchor] = useState<HeadLocalPoint>(DEFAULT_MOUTH_ANCHOR);
  const [faceCropPreview, setFaceCropPreview] = useState<{ url: string; aspect: number } | null>(null);
  const [liveControlEnabled, setLiveControlEnabled] = useState(false);
  const [liveCameraMode, setLiveCameraMode] = useState<LiveCameraMode>("character");
  const [liveLegendOpen, setLiveLegendOpen] = useState(true);
  const [liveHeldCommand, setLiveHeldCommand] = useState<LiveCommandKey | null>(null);
  const [streamPublishing, setStreamPublishing] = useState(false);
  const [streamGuestSkin, setStreamGuestSkin] = useState<CharacterSkin>("stick");
  const [spawnDoor, setSpawnDoor] = useState<SpawnDoor | null>(null);
  const [streamGuests, setStreamGuests] = useState<StreamParticipantPresence[]>([]);
  const [selectedCharActionId, setSelectedCharActionId] = useState<string | null>(null);
  const [retargetCharActionId, setRetargetCharActionId] = useState<string | null>(null);
  const [charActionContextMenu, setCharActionContextMenu] = useState<{ x: number; y: number; actionId: string } | null>(null);
  const [authoredAnimations, setAuthoredAnimations] = useState<AuthoredAnimation[]>([]);
  const [playMode, setPlayMode] = useState(false);
  const [playLegendOpen, setPlayLegendOpen] = useState(true);
  const [playSceneShot, setPlaySceneShot] = useState(false);
  const [playWeaponArmed, setPlayWeaponArmed] = useState(false);
  const [playBazookaArmed, setPlayBazookaArmed] = useState(false);
  const [playCleanUi, setPlayCleanUi] = useState(false);
  const [playCleanMenuOpen, setPlayCleanMenuOpen] = useState(false);
  const [playWheelOpen, setPlayWheelOpen] = useState(false);
  const [playWheelMenuOpen, setPlayWheelMenuOpen] = useState(false);
  const [playDebugOpen, setPlayDebugOpen] = useState(false);
  const [playParticipantsOpen, setPlayParticipantsOpen] = useState(false);
  const [playMaximize, setPlayMaximize] = useState(false);
  const [playNativeFullscreen, setPlayNativeFullscreen] = useState(false);
  const [playAddMenuOpen, setPlayAddMenuOpen] = useState(false);
  const [playHairStyle, setPlayHairStyle] = useState<PlayHairStyle>("spikes");
  const [playOutfitStyle, setPlayOutfitStyle] = useState<PlayOutfitStyle>("tee");
  const [playViewport, setPlayViewport] = useState({ width: 1280, height: 720 });

  // ── AI character choreography ──
  const [directCharacterOpen, setDirectCharacterOpen] = useState(false);
  const [characterDirection, setCharacterDirection] = useState("");
  const [syncEmotesToNarration, setSyncEmotesToNarration] = useState(true);
  const [choreoPhase, setChoreoPhase] = useState<string | null>(null);
  const [choreoError, setChoreoError] = useState<string | null>(null);

  // ── AI annotation generation ──
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiTab, setAiTab] = useState<"audio" | "script">("audio");
  const [aiAudioFile, setAiAudioFile] = useState<File | null>(null);
  const [aiScriptText, setAiScriptText] = useState("");
  const [aiPhase, setAiPhase] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // ── YouTube modal ──
  const [ytModalOpen, setYtModalOpen] = useState(false);
  const [ytTab, setYtTab] = useState<YtTab>("search");
  const [ytView, setYtView] = useState<YtModalView>("search");
  const [ytUrlInput, setYtUrlInput] = useState("");
  const [ytQuery, setYtQuery] = useState("");
  const [ytResults, setYtResults] = useState<YtSearchResult[]>([]);
  const [ytSelected, setYtSelected] = useState<YtSearchResult | null>(null);
  const [ytStart, setYtStart] = useState(0);
  const [ytStartInput, setYtStartInput] = useState("0:00");
  const [ytEnd, setYtEnd] = useState(30);
  const [ytEndInput, setYtEndInput] = useState("0:30");
  const [ytError, setYtError] = useState("");
  const [ytLoading, setYtLoading] = useState(false);
  const [ytShortsOnly, setYtShortsOnly] = useState(false);
  const [downloadToasts, setDownloadToasts] = useState<DownloadToast[]>([]);

  // ── Neural Search ──
  const [neuralModalOpen, setNeuralModalOpen] = useState(false);
  const [neuralConcept, setNeuralConcept] = useState("");
  const [neuralPhase, setNeuralPhase] = useState<string | null>(null);
  const [neuralError, setNeuralError] = useState("");
  const [neuralPlaceholders, setNeuralPlaceholders] = useState<NeuralPlaceholder[]>([]);
  const [imagePlaceholders, setImagePlaceholders] = useState<ImagePlaceholder[]>([]);
  const [hoveredPlaceholderId, setHoveredPlaceholderId] = useState<string | null>(null);
  const [imagePreviewTarget, setImagePreviewTarget] = useState<ImagePlaceholder | null>(null);
  const [imagePreviewWorking, setImagePreviewWorking] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState("");

  // ── Top 5 Neural Search ──
  const [top5ModalOpen, setTop5ModalOpen] = useState(false);
  const [top5Concept, setTop5Concept] = useState("");
  const [top5Phase, setTop5Phase] = useState<string | null>(null);
  const [top5Error, setTop5Error] = useState("");

  // ── Mobile Top 5 Tinder flow ──
  type MobileVideoCandidate = { videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number; };
  type MobileTop5ItemData = { rank: number; label: string; blurb: string; videos: MobileVideoCandidate[]; };
  type MobileTop5ApiData = { title: string; items: MobileTop5ItemData[]; };
  type MobileAcceptedVideo = { videoId: string; trimStart: number; trimEnd: number; title: string; };

  const [mobileDesktopOverride, setMobileDesktopOverride] = useState(false);
  const [mobileTop5Screen, setMobileTop5Screen] = useState<"prompt" | "loading" | "swipe" | "build" | "done">("prompt");
  const [mobileTop5Concept, setMobileTop5Concept] = useState("");
  const [mobileTop5Data, setMobileTop5Data] = useState<MobileTop5ApiData | null>(null);
  const [mobileTop5CurrentRank, setMobileTop5CurrentRank] = useState(5);
  const [mobileTop5ResultsByRank, setMobileTop5ResultsByRank] = useState<Map<number, MobileVideoCandidate[]>>(new Map());
  const [mobileTop5IndexByRank, setMobileTop5IndexByRank] = useState<Map<number, number>>(new Map());
  const [mobileTop5AcceptedByRank, setMobileTop5AcceptedByRank] = useState<Map<number, MobileAcceptedVideo>>(new Map());
  const [mobileTop5TrimStart, setMobileTop5TrimStart] = useState(0);
  const [mobileTop5TrimEnd, setMobileTop5TrimEnd] = useState(30);
  const [mobileTop5CardAnim, setMobileTop5CardAnim] = useState<"accept" | "reject" | null>(null);
  const [mobileTop5LoadingRank, setMobileTop5LoadingRank] = useState<number | null>(null);
  const [mobileTop5BuildPhase, setMobileTop5BuildPhase] = useState<string | null>(null);
  const [mobileTop5Error, setMobileTop5Error] = useState("");
  const [mobileTop5TrimStartInput, setMobileTop5TrimStartInput] = useState("0:00");
  const [mobileTop5TrimEndInput, setMobileTop5TrimEndInput] = useState("0:30");
  const [mobileTop5TrimError, setMobileTop5TrimError] = useState("");
  const [mobileTop5CustomLabels, setMobileTop5CustomLabels] = useState<Map<number, string>>(new Map());
  const [mobileTop5EditingLabel, setMobileTop5EditingLabel] = useState(false);
  const [mobileTop5LabelInput, setMobileTop5LabelInput] = useState("");
  const [mobileTop5ListLength, setMobileTop5ListLength] = useState<3 | 4 | 5>(5);

  const [boardMarquee, setBoardMarquee] = useState<BoardMarquee>(null);
  const [timelineMarquee, setTimelineMarquee] = useState<TimelineMarquee>(null);
  const [customZoomDrawMode, setCustomZoomDrawMode] = useState(false);
  const [customZoomDrawPreview, setCustomZoomDrawPreview] = useState<BoardMarquee>(null);

  const canvasW = canvasAspect === "16:9" ? CANVAS_W_LAND : CANVAS_H_LAND;
  const canvasH = canvasAspect === "16:9" ? CANVAS_H_LAND : CANVAS_W_LAND;
  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedCharActionOwner: CharacterId | null = characterActions.some((a) => a.id === selectedCharActionId)
    ? "c1"
    : characterActions2.some((a) => a.id === selectedCharActionId)
      ? "c2"
      : null;
  const selectedCharAction = selectedCharActionOwner === "c1"
    ? characterActions.find((a) => a.id === selectedCharActionId) ?? null
    : selectedCharActionOwner === "c2"
      ? characterActions2.find((a) => a.id === selectedCharActionId) ?? null
      : null;
  const activeCharacter: CharacterInstance = activeCharacterId === "c2"
    ? { id: "c2", enabled: showCharacter2, accentColor: "#3a3a5a", mode: characterMode2, actions: characterActions2, skin: characterSkin2, faceBlobUrl: characterFace2?.faceBlobUrl, faceAspect: characterFace2?.faceAspect, mouthAnchor: characterFace2?.mouthAnchor, start: characterStart2 ?? undefined }
    : { id: "c1", enabled: showCharacter, accentColor: "#2a2a2a", mode: characterMode, actions: characterActions, skin: characterSkin, faceBlobUrl: characterFace?.faceBlobUrl, faceAspect: characterFace?.faceAspect, mouthAnchor: characterFace?.mouthAnchor, start: characterStart ?? undefined };
  const characterDuration = characterProjectDuration(characterActions);
  const generatedDuration = cameraKeyframeMode === "character" && characterDuration > 0
    ? characterDuration
    : Math.max(0, ...clips.map((c) => c.startTime + c.duration));
  const timelineDuration = Math.max(10, generatedDuration + 2);
  const timelineWidth = timelineDuration * pxPerSec;
  const previewAspect = canvasW / canvasH;
  const previewW = Math.round(previewHeight * previewAspect);
  const mobilePreviewH = Math.max(88, Math.min(150, previewHeight * 0.55));
  const mobilePreviewW = Math.round(mobilePreviewH * previewAspect);
  const canGenerateCamera = cameraMode === "character"
    ? showCharacter
    : clips.some((clip) => clip.boardX !== undefined || clip.type === "pan" || clip.type === "characterZoom");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardCharacterCanvasRef = useRef<HTMLCanvasElement>(null);
  const mobileBoardCharacterCanvasRef = useRef<HTMLCanvasElement>(null);
  const boardImageCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const mobileBoardImageCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const drawBoardImageOverlaysRef = useRef<(time: number) => void>(() => {});
  const playCanvasRef = useRef<HTMLCanvasElement>(null);
  const playContainerRef = useRef<HTMLDivElement>(null);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<Clip[]>(clips);
  const selectedClipIdsRef = useRef<string[]>([]);
  const selectedAnnotationIdsRef = useRef<string[]>([]);
  const mutedLayersRef = useRef<Record<number, boolean>>({});
  const playheadRef = useRef(0);
  const isPlayingRef = useRef(false);
  const canvasWRef = useRef(canvasW);
  const canvasHRef = useRef(canvasH);
  const boardZoomRef = useRef(0.18);
  const boardPanRef = useRef({ x: 20, y: 20 });
  const isSpaceDownRef = useRef(false);
  const lastRafTimeRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const mediaUploadRef = useRef<HTMLInputElement>(null);
  const narrationUploadRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const exportCancelRef = useRef(false);
  const exportRafRef = useRef<number | null>(null);
  const isExportingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraKeyframesRef = useRef<CameraKeyframe[]>([]);
  const cameraModeRef = useRef<CameraMode>("clips");
  const cameraKeyframeModeRef = useRef<CameraMode>("clips");
  const characterDurationRef = useRef(0);
  const occupancyWindowsRef = useRef<OccupancyWindow[]>([]);
  const pxPerSecRef = useRef(DEFAULT_PX_PER_SEC);
  const timelineScrollRef = useRef(0);
  const pendingScrollLeftRef = useRef<number | null>(null);
  const timelineDragRef = useRef<TimelineDrag | null>(null);
  const boardMarqueeRef = useRef<BoardMarquee>(null);
  const timelineMarqueeRef = useRef<TimelineMarquee>(null);
  const boardMarqueeStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const timelineMarqueeStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const customZoomDrawModeRef = useRef(false);
  const rafCallbackRef = useRef<FrameRequestCallback>(() => {});
  const dividerDragRef = useRef<{ clipId: string; innerStartPx: number; innerWidthPx: number } | null>(null);
  const videoHiddenContainerRef = useRef<HTMLDivElement>(null);
  // Switch-based video playback: one dedicated <video> element per clip.id, even for duplicates sharing a sourceUrl.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map()); // clip.id → HTMLVideoElement
  const videoRangeStateRef = useRef<Map<string, boolean>>(new Map()); // clip.id → wasInRange (previous frame)
  const videoStuckFrameCountRef = useRef<Map<string, number>>(new Map()); // clip.id → consecutive failed-draw frames while active
  const videoPlaybackStateRef = useRef<Map<string, VideoPlaybackRuntime>>(new Map()); // clip.id → active/ambient/dormant runtime state
  const ambientVideoEnabledRef = useRef(ambientVideoEnabled);
  const ambientCandidateIdsRef = useRef<Set<string>>(new Set());
  const lastAmbientEvalAtRef = useRef(0);
  const lastAmbientCensusAtRef = useRef(0);
  const drawableFailureCountRef = useRef(0);
  const hasPrewarmedRef = useRef(false); // first-play autoplay unlock, once per session
  const thumbnailImagesRef = useRef<Map<string, HTMLImageElement | null>>(new Map()); // clip.id → pre-loaded thumbnail image (null = capture failed)
  const ytSliderTrackRef = useRef<HTMLDivElement>(null);
  const ytRangeRef = useRef({ start: 0, end: 30 });
  const prevPlayheadRef = useRef(-1); // previous frame's playhead for entry detection
  const annotationsRef = useRef<Annotation[]>([]);
  const annotationToolRef = useRef<AnnotationTool>("pointer");
  const annotationColorRef = useRef("#cc2200");
  const annotationFontRef = useRef("Caveat");
  const annotationHighlightStyleRef = useRef<"rect" | "underline" | "curlyBrace">("rect");
  const editingAnnotationTextRef = useRef("");
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const annotationEmojiRef = useRef("🎯");
  const clipboardRef = useRef<Clip | null>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const micStartSecRef = useRef(0);
  const micRafRef = useRef<number | null>(null);
  const micStartWallRef = useRef(0);
  const isRecordingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mobileYtIframeRef = useRef<HTMLIFrameElement | null>(null);
  const mobileBoardPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const mobileGestureRef = useRef<{
    type: "idle" | "deciding" | "pan" | "move" | "pinch";
    hitClipId: string | null;
    hitClipIsSelected: boolean;
    startX: number; startY: number;
    origPan: { x: number; y: number };
    clipOrigX: number; clipOrigY: number;
    pinchStartDist: number; pinchStartZoom: number; pinchStartPan: { x: number; y: number };
    longPressTimer: ReturnType<typeof setTimeout> | null;
  }>({
    type: "idle", hitClipId: null, hitClipIsSelected: false,
    startX: 0, startY: 0,
    origPan: { x: 0, y: 0 },
    clipOrigX: 0, clipOrigY: 0,
    pinchStartDist: 1, pinchStartZoom: 0.18, pinchStartPan: { x: 0, y: 0 },
    longPressTimer: null,
  });
  const activeNarrationRef = useRef<Map<string, { bufNode: AudioBufferSourceNode; gainNode: GainNode }>>(new Map());
  const videoAudioNodesRef = useRef<Map<string, { sourceNode: MediaElementAudioSourceNode; gainNode: GainNode }>>(new Map());
  const videoDimsRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const showCharacterRef = useRef(false);
  const showCharacter2Ref = useRef(false);
  const characterFaceRef = useRef<CharacterFaceSettings | null>(null);
  const characterFace2Ref = useRef<CharacterFaceSettings | null>(null);
  const characterFaceImageRef = useRef<HTMLImageElement | null>(null);
  const characterFace2ImageRef = useRef<HTMLImageElement | null>(null);
  const drawFrameRef = useRef<(time: number) => void>(() => {});
  const characterActionsRef = useRef<CharacterAction[]>([]);
  const characterActions2Ref = useRef<CharacterAction[]>([]);
  const selectedCharActionIdRef = useRef<string | null>(null);
  const resolvedCharActionsRef = useRef<ResolvedCharAction[]>([]);
  const resolvedCharActions2Ref = useRef<ResolvedCharAction[]>([]);
  const authoredAnimationsRef = useRef<Record<string, AuthoredAnimation>>({});
  const charInitXRef = useRef(BOARD_W / 2);
  const charInitYRef = useRef(BOARD_H * 0.75);
  const charInit2XRef = useRef(BOARD_W / 2 + 60);
  const charInit2YRef = useRef(BOARD_H * 0.75);
  const characterEntranceTimeRef = useRef(-Infinity);
  const characterEntranceTime2Ref = useRef(-Infinity);
  const characterAddModeRef = useRef<CharacterAddMode | null>(null);
  const characterModeRef = useRef<"auto" | "manual">("auto");
  const characterMode2Ref = useRef<"auto" | "manual">("auto");
  const characterSkinRef = useRef<CharacterSkin>("stick");
  const characterSkin2Ref = useRef<CharacterSkin>("stick");
  const characterVisemeModeRef = useRef<Viseme | "auto">("auto");
  const characterVisemeMode2Ref = useRef<Viseme | "auto">("auto");
  const characterVisemeRef = useRef<Viseme>("rest");
  const characterViseme2Ref = useRef<Viseme>("rest");
  const activeCharacterIdRef = useRef<CharacterId>("c1");
  const liveControlEnabledRef = useRef(false);
  const streamGuestSkinRef = useRef<CharacterSkin>("stick");
  const liveCameraModeRef = useRef<LiveCameraMode>("character");
  const liveSceneSurfaceKeyRef = useRef<string | null>(null);
  const liveSceneCameraRef = useRef<{ cameraX: number; cameraY: number; boardZoom: number } | null>(null);
  const liveCameraTransitionRef = useRef<{ from: { cameraX: number; cameraY: number; boardZoom: number }; startMs: number; durationMs: number } | null>(null);
  const liveHeldCommandRef = useRef<LiveCommandKey | null>(null);
  const liveRafIdRef = useRef<number | null>(null);
  const liveCameraRef = useRef<{ cameraX: number; cameraY: number; boardZoom: number } | null>(null);
  const streamChannelRef = useRef<RealtimeChannel | null>(null);
  const streamSessionIdRef = useRef("");
  const streamLastFrameAtRef = useRef(0);
  const streamFrameSeqRef = useRef(0);
  const streamLastDebugFrameAtRef = useRef(0);
  const streamSnapshotQueuedRef = useRef(false);
  const streamSnapshotBusyRef = useRef(false);
  const spawnDoorRef = useRef<SpawnDoor | null>(null);
  const streamGuestFramesRef = useRef<Map<string, GuestCharacterFrame>>(new Map());
  const streamRenderedGuestFramesRef = useRef<Map<string, GuestCharacterFrame>>(new Map());
  const streamGuestEntitiesRef = useRef<Map<string, CharacterEntity>>(new Map());
  const streamGuestSeqRef = useRef<Map<string, number>>(new Map());
  const streamGuestClockOffsetsRef = useRef<Map<string, number>>(new Map());
  const streamGuestFacesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const streamGuestSignsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const streamEliminationsRef = useRef<Map<string, StreamEliminationMessage>>(new Map());
  const streamChokeStatesRef = useRef<Map<string, StreamChokeMessage>>(new Map());
  const streamGuestKickTombstonesRef = useRef<Map<string, number>>(new Map());
  const streamMediaDataUrlCacheRef = useRef<Map<string, { signature: string; maxLongEdge: number; dataUrl: string }>>(new Map());
  const evaluateVideoPlaybackStatesRef = useRef<((time: number, currentClips: Clip[], currentCameraKeyframes: CameraKeyframe[], W: number, H: number, options?: { force?: boolean; audioMode?: "preview" | "silent"; overrideCamera?: { cameraX: number; cameraY: number; boardZoom: number } | null }) => void) | null>(null);
  const liveCharactersRef = useRef<Record<CharacterId, LiveCharacterRuntime>>({
    c1: { enabled: false, startWallMs: 0, initX: BOARD_W / 2, initY: BOARD_H * 0.75, actions: [], currentPose: null, blendFromPose: null, blendStartWallMs: 0, blendDuration: LIVE_BLEND_SEC, lastStationaryAction: null, emoteIndex: 0 },
    c2: { enabled: false, startWallMs: 0, initX: BOARD_W / 2 + 60, initY: BOARD_H * 0.75, actions: [], currentPose: null, blendFromPose: null, blendStartWallMs: 0, blendDuration: LIVE_BLEND_SEC, lastStationaryAction: null, emoteIndex: 0 },
  });
  const charActionDragRef = useRef<CharTimelineDrag | null>(null);
  const faceCropDragRef = useRef<{ mode: "move" | "resize"; corner?: FaceCropCorner; startX: number; startY: number; orig: typeof faceCrop; rectW: number; rectH: number } | null>(null);
  const faceMouthAnchorDragRef = useRef<{ startX: number; startY: number; orig: HeadLocalPoint; rectW: number; rectH: number } | null>(null);
  const playModeRef = useRef(false);
  const playOverlayInputActiveRef = useRef(false);
  const playTimeRef = useRef(0);
  const playWallStartRef = useRef(0);
  const playCameraRef = useRef({ cameraX: BOARD_W / 2, cameraY: BOARD_H / 2, boardZoom: 1 });
  const playHeldKeysRef = useRef(new Set<string>());
  const playPointerRef = useRef<{ id: number; clientX: number; clientY: number; down: boolean; lastSteerAt: number } | null>(null);
  const playCursorRef = useRef<{ x: number; y: number } | null>(null);
  const playPhysicsRef = useRef<PlayCharacterState | null>(null);
  const playActionRuntimeRef = useRef<LiveCharacterRuntime | null>(null);
  const playWeaponArmedRef = useRef(false);
  const playBazookaArmedRef = useRef(false);
  const playBazookaLastFireAtRef = useRef(0);
  const playBazookaEventsRef = useRef<BazookaVisualEvent[]>([]);
  const streamCratersRef = useRef<StreamCrater[]>([]);
  const streamRepairAtRef = useRef(0);
  const playWeaponShotsRef = useRef<PlayWeaponShot[]>([]);
  const playWeaponHitCountsRef = useRef<Map<string, number>>(new Map());
  const playWeaponLastShotAtRef = useRef(0);
  const playWeaponLastStateAtRef = useRef(0);
  const playEliminationKickSentRef = useRef<Set<string>>(new Set());
  const playFlipDebugRef = useRef<{ facing: 1 | -1; rotationDirection: 1 | -1; travelDx: number } | null>(null);
  const playForceChokeRef = useRef<{ pointerId: number; targetGuestId: string; startedAt: number; position: { x: number; y: number }; lastSentAt: number } | null>(null);
  const streamHostCharacterDebugRef = useRef<StreamCharacterDebugRow[]>([]);
  const streamGuestCharacterDebugRef = useRef<StreamCharacterDebugRow[]>([]);
  const streamLastDebugOverlayAtRef = useRef(0);
  const [streamCharacterDebugRows, setStreamCharacterDebugRows] = useState<StreamCharacterDebugRow[]>([]);
  const editorPlayheadBeforePlayRef = useRef(0);

  const liveBoardCenter = useCallback((fallbackX: number, fallbackY: number): { x: number; y: number } => {
    const placed = clipsRef.current.filter((c) => c.boardX !== undefined && c.boardY !== undefined && c.boardW !== undefined && c.boardH !== undefined);
    if (placed.length === 0) return { x: fallbackX, y: fallbackY };
    const minX = Math.min(...placed.map((c) => c.boardX!));
    const maxX = Math.max(...placed.map((c) => c.boardX! + c.boardW!));
    const minY = Math.min(...placed.map((c) => c.boardY!));
    const maxY = Math.max(...placed.map((c) => c.boardY! + c.boardH!));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }, []);

  const livePoseFor = useCallback((id: CharacterId, wallMs = performance.now()): CharPoseResult => {
    const runtime = liveCharactersRef.current[id];
    const hasFace = id === "c2" ? !!(characterFace2Ref.current && characterFace2ImageRef.current) : !!(characterFaceRef.current && characterFaceImageRef.current);
    const faceAspect = id === "c2" ? clamp(characterFace2Ref.current?.faceAspect ?? 1, 0.75, 1.6) : clamp(characterFaceRef.current?.faceAspect ?? 1, 0.75, 1.6);
    const pose = evalLiveCharacterAtWallTime(runtime, wallMs, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
    runtime.currentPose = pose;
    return pose;
  }, []);

  const resetLiveRuntimeFor = useCallback((id: CharacterId, startPose?: CharPoseResult) => {
    const now = performance.now();
    const fallback = id === "c2" ? { x: charInit2XRef.current, y: charInit2YRef.current } : { x: charInitXRef.current, y: charInitYRef.current };
    const center = liveBoardCenter(fallback.x, fallback.y);
    const pose = startPose ?? (id === "c2"
      ? evalCharAtTime(playheadRef.current, resolvedCharActions2Ref.current, fallback.x, fallback.y, clipsRef.current, authoredAnimationsRef.current)
      : evalCharAtTime(playheadRef.current, resolvedCharActionsRef.current, fallback.x, fallback.y, clipsRef.current, authoredAnimationsRef.current));
    const startX = Number.isFinite(pose.boardX) ? pose.boardX : center.x;
    const startY = Number.isFinite(pose.boardY) ? pose.boardY : resolveGroundY(center.x, center.y, clipsRef.current, streamCratersRef.current);
    liveCharactersRef.current[id] = {
      ...liveCharactersRef.current[id],
      enabled: true,
      startWallMs: now,
      initX: startX,
      initY: startY,
      actions: [],
      currentPose: standingCharPose(startX, startY, pose.facing ?? 1, now / 1000),
      blendFromPose: null,
      blendStartWallMs: 0,
      blendDuration: LIVE_BLEND_SEC,
      lastStationaryAction: null,
    };
  }, [liveBoardCenter]);

  const boardPointFromClient = useCallback((clientX: number, clientY: number): { rawX: number; rawY: number; x: number; y: number; surface?: RequiredSurfaceClip } | null => {
    const rect = boardContainerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const rawX = (clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
    const rawY = (clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
    const snapped = snapToClipTop(rawX, rawY, clipsRef.current, streamCratersRef.current);
    const surface = clipsRef.current
      .find((c): c is Clip & RequiredSurfaceClip =>
        isBoardSurface(c) &&
        rawX >= c.boardX && rawX <= c.boardX + c.boardW &&
        rawY >= c.boardY && rawY <= c.boardY + c.boardH
      );
    return { rawX, rawY, x: snapped.x, y: snapped.y, surface };
  }, []);

  const issueLiveAction = useCallback((id: CharacterId, command: LiveCommandKey, target?: { x: number; y: number; surface?: RequiredSurfaceClip }) => {
    const now = performance.now();
    let runtime = liveCharactersRef.current[id];
    if (!runtime.enabled) {
      resetLiveRuntimeFor(id);
      runtime = liveCharactersRef.current[id];
    }
    const currentPose = livePoseFor(id, now);
    const startX = currentPose.boardX;
    const startY = resolveGroundY(startX, currentPose.boardY, clipsRef.current, streamCratersRef.current);
    const t0 = 0;
    const mk = (type: CharacterAction["type"], duration: number, tx = startX, ty = startY): CharacterAction => ({
      id: generateId(),
      type,
      startTime: t0,
      duration,
      targetX: Math.round(tx),
      targetY: Math.round(ty),
      ...(type === "skateTo" && target?.surface?.id ? { targetClipId: target.surface.id } : {}),
    });
    const tx = target?.x ?? startX;
    const ty = target?.y ?? startY;
    const dist = Math.hypot(tx - startX, ty - startY);
    let action: CharacterAction | null = null;

    if (command === "stop") {
      action = null;
    } else if (command === "walkTo" || command === "runTo") {
      const speed = command === "runTo" ? LIVE_RUN_SPEED : LIVE_WALK_SPEED;
      action = mk("walkTo", clamp(dist / speed, 0.25, 4.5), tx, ty);
    } else if (command === "jumpTo") action = mk("jumpTo", clamp(dist / 900, 0.7, 1.6), tx, ty);
    else if (command === "flip") action = mk("flip", clamp(dist / 900, 0.8, 1.6), tx, ty);
    else if (command === "grapple") action = mk("grapple", GRAPPLE_MANUAL_DURATION_SEC, tx, ty);
    else if (command === "zipline") action = mk("zipline", clamp(dist / 650, 0.8, 2.5), tx, ty);
    else if (command === "skateTo") action = mk("skateTo", Math.max(1.2, Math.min(4.5, dist / SKATE_ROLL_SPEED + 0.8)), tx, ty);
    else if (command === "wallClimb") action = mk("wallClimb", clamp(Math.abs(ty - startY) / 350 + 0.8, 0.9, 2.8), tx, ty);
    else if (command === "dance") action = mk("dance", 2.5);
    else if (command === "pullUps") action = mk("pullUps", 4);
    else if (command === "mirrorCheck") action = mk("mirrorCheck", 5);
    else if (command === "sitAndWatch") action = mk("sitAndWatch", 3600);
    else if (command === "emote") {
      const emoji = LIVE_EMOTES[runtime.emoteIndex % LIVE_EMOTES.length];
      action = { ...mk("emote", 2), emoji };
      runtime.emoteIndex += 1;
    }

    liveCharactersRef.current[id] = {
      ...runtime,
      enabled: true,
      startWallMs: now,
      initX: startX,
      initY: startY,
      actions: action ? [action] : [],
      currentPose,
      blendFromPose: currentPose,
      blendStartWallMs: now,
      blendDuration: LIVE_BLEND_SEC,
      lastStationaryAction: action && CHAR_STATIONARY_TARGET_TYPES.has(action.type) ? action : null,
    };
  }, [livePoseFor, resetLiveRuntimeFor]);

  const liveSurfaceKeyForPose = useCallback((pose: CharPoseResult | null): string | null => {
    if (!pose) return null;
    const surface = clipsRef.current.find((c) =>
      isBoardSurface(c) &&
      pose.boardX >= c.boardX! &&
      pose.boardX <= c.boardX! + c.boardW! &&
      Math.abs(pose.boardY - c.boardY!) < Math.max(90, c.boardH! * 0.18)
    );
    return surface?.id ?? null;
  }, []);

  const liveCharacterCameraTarget = useCallback((pose: CharPoseResult | null, wide = false): { cameraX: number; cameraY: number; boardZoom: number } => {
    const p = pose ?? standingCharPose(charInitXRef.current, charInitYRef.current, 1, performance.now() / 1000);
    const targetHeight = wide ? 560 : 420;
    return {
      cameraX: p.boardX,
      cameraY: p.boardY - (wide ? 40 : 80),
      boardZoom: clamp(canvasHRef.current * BOARD_W / (canvasWRef.current * targetHeight), wide ? 0.25 : 0.35, wide ? 1.8 : 2.4),
    };
  }, []);

  const liveSceneCameraTarget = useCallback((pose: CharPoseResult | null): { camera: { cameraX: number; cameraY: number; boardZoom: number }; surfaceKey: string | null } => {
    if (!pose) return { camera: liveCharacterCameraTarget(null, true), surfaceKey: null };
    const surface = clipsRef.current.find((c) =>
      isBoardSurface(c) &&
      pose.boardX >= c.boardX! &&
      pose.boardX <= c.boardX! + c.boardW! &&
      Math.abs(pose.boardY - c.boardY!) < Math.max(90, c.boardH! * 0.18)
    );
    if (!surface) return { camera: liveCharacterCameraTarget(pose, true), surfaceKey: null };
    const sf = 0.70 * Math.min(canvasWRef.current / surface.boardW!, canvasHRef.current / surface.boardH!);
    return {
      surfaceKey: surface.id,
      camera: {
        cameraX: surface.boardX! + surface.boardW! / 2,
        cameraY: surface.boardY! + surface.boardH! / 2,
        boardZoom: clamp(sf * BOARD_W / canvasWRef.current, 0.25, 5),
      },
    };
  }, [liveCharacterCameraTarget]);

  const startLiveCameraTransition = useCallback(() => {
    liveCameraTransitionRef.current = {
      from: liveCameraRef.current ?? liveCharacterCameraTarget(liveCharactersRef.current[activeCharacterIdRef.current]?.currentPose ?? null),
      startMs: performance.now(),
      durationMs: LIVE_CAMERA_TRANSITION_MS,
    };
  }, [liveCharacterCameraTarget]);

  const toggleLiveCameraMode = useCallback(() => {
    const runtime = liveCharactersRef.current[activeCharacterIdRef.current];
    const pose = runtime.currentPose ?? livePoseFor(activeCharacterIdRef.current);
    startLiveCameraTransition();
    if (liveCameraModeRef.current === "scene") {
      liveCameraModeRef.current = "character";
      setLiveCameraMode("character");
      liveSceneSurfaceKeyRef.current = null;
      liveSceneCameraRef.current = null;
      return;
    }
    const scene = liveSceneCameraTarget(pose);
    liveCameraModeRef.current = "scene";
    setLiveCameraMode("scene");
    liveSceneSurfaceKeyRef.current = scene.surfaceKey;
    liveSceneCameraRef.current = scene.camera;
  }, [livePoseFor, liveSceneCameraTarget, startLiveCameraTransition]);

  const blobUrlToDataUrl = useCallback(async (url?: string | null): Promise<string | undefined> => {
    if (!url) return undefined;
    if (url.startsWith("data:")) return url;
    if (!url.startsWith("blob:")) return url;
    try {
      const blob = await fetch(url).then((r) => r.blob());
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  }, []);

  const loadStreamImage = useCallback(async (url: string): Promise<HTMLImageElement | null> => {
    if (!url) return null;
    const existing = imgCacheRef.current.get(url);
    if (existing?.complete && existing.naturalWidth > 0) return existing;
    const img = new Image();
    img.crossOrigin = "anonymous";
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Stream image failed to load"));
        img.src = url;
      });
      return img.naturalWidth > 0 ? img : null;
    } catch {
      return null;
    }
  }, []);

  const encodeStreamImageForSnapshot = useCallback(async (
    clipId: string,
    signature: string,
    image: HTMLImageElement | null,
    maxLongEdge: number
  ): Promise<string> => {
    const cached = streamMediaDataUrlCacheRef.current.get(clipId);
    if (cached && cached.signature === signature && cached.maxLongEdge === maxLongEdge) return cached.dataUrl;
    if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return "";
    const scale = Math.min(1, maxLongEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    try {
      ctx.drawImage(image, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      streamMediaDataUrlCacheRef.current.set(clipId, { signature, maxLongEdge, dataUrl });
      return dataUrl;
    } catch (error) {
      streamDebugLog("snapshot media encode failed", { clipId, signature, error });
      return "";
    }
  }, []);

  const buildStreamClips = useCallback(async (maxLongEdge: number) => {
    const streamable = clipsRef.current.filter((c) => c.type !== "narration" && c.type !== "pan" && c.type !== "characterZoom" && c.type !== "customZoom" && c.boardX !== undefined);
    return Promise.all(streamable.map(async (c) => {
      const isVideo = c.type === "video";
      const thumb = isVideo ? thumbnailImagesRef.current.get(c.id) ?? null : null;
      const loaded = thumb?.complete && thumb.naturalWidth > 0
        ? thumb
        : await loadStreamImage(isVideo ? (c.thumbnailBlobUrl || "") : c.sourceUrl);
      const signature = isVideo
        ? `video:${c.id}:${c.thumbnailBlobUrl || ""}:${c.sourceUrl || ""}`
        : `image:${c.id}:${c.sourceUrl || ""}`;
      const dataUrl = await encodeStreamImageForSnapshot(c.id, signature, loaded, maxLongEdge);
      return {
        id: c.id,
        type: c.type as "image" | "video",
        name: c.name,
        sourceUrl: dataUrl,
        thumbnailUrl: isVideo ? dataUrl : undefined,
        videoBadge: isVideo,
        boardX: c.boardX!,
        boardY: c.boardY!,
        boardW: c.boardW!,
        boardH: c.boardH!,
        layer: c.layer,
      };
    }));
  }, [encodeStreamImageForSnapshot, loadStreamImage]);

  const buildStreamSnapshot = useCallback(async (): Promise<StreamSnapshotMessage> => {
    const [face1, face2] = await Promise.all([
      blobUrlToDataUrl(characterFaceRef.current?.faceBlobUrl),
      blobUrlToDataUrl(characterFace2Ref.current?.faceBlobUrl),
    ]);
    const build = async (maxLongEdge: number): Promise<StreamSnapshotMessage> => ({
      kind: "snapshot",
      streamId: STREAM_OWNER_USER_ID,
      sessionId: streamSessionIdRef.current,
      sentAt: Date.now(),
      board: { width: BOARD_W, height: BOARD_H, backgroundColor: "#f7e5c1" },
      spawnDoor: spawnDoorRef.current,
      clips: await buildStreamClips(maxLongEdge),
      annotations: annotationsRef.current,
      craters: streamCratersRef.current,
      characters: [
        { id: "c1", enabled: showCharacterRef.current, name: "HOST", skin: "stick", physique: "slim", faceDataUrl: face1, faceAspect: characterFaceRef.current?.faceAspect, mouthAnchor: characterFaceRef.current?.mouthAnchor },
        { id: "c2", enabled: showCharacter2Ref.current, name: "HOST 2", skin: "stick", physique: "slim", faceDataUrl: face2, faceAspect: characterFace2Ref.current?.faceAspect, mouthAnchor: characterFace2Ref.current?.mouthAnchor },
      ],
    });
    let maxLongEdge = 512;
    let snapshot = await build(maxLongEdge);
    let snapshotBytes = new Blob([JSON.stringify(snapshot)]).size;
    if (snapshotBytes > 2 * 1024 * 1024) {
      maxLongEdge = 384;
      snapshot = await build(maxLongEdge);
      snapshotBytes = new Blob([JSON.stringify(snapshot)]).size;
    }
    streamDebugLog("snapshot size", {
      bytes: snapshotBytes,
      kb: Math.round(snapshotBytes / 1024),
      clips: snapshot.clips.length,
      maxLongEdge,
      chunking: false,
    });
    return snapshot;
  }, [blobUrlToDataUrl, buildStreamClips]);

  const publishStreamSnapshot = useCallback(async () => {
    if (!(liveControlEnabledRef.current || playModeRef.current) || !streamSessionIdRef.current || streamSnapshotBusyRef.current) {
      if (streamSnapshotBusyRef.current) streamSnapshotQueuedRef.current = true;
      return;
    }
    streamSnapshotBusyRef.current = true;
    try {
      const snapshot = await buildStreamSnapshot();
      streamDebugLog("snapshot broadcast", {
        channel: streamChannelName(STREAM_OWNER_USER_ID),
        sessionId: snapshot.sessionId,
        clips: snapshot.clips.length,
        characters: snapshot.characters.filter((ch) => ch.enabled).map((ch) => ch.id),
        mode: playModeRef.current ? "play" : "live-control",
      });
      streamChannelRef.current?.send({ type: "broadcast", event: "snapshot", payload: snapshot });
      const res = await fetch("/api/stream/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      }).catch((error) => {
        streamDebugLog("snapshot endpoint failed", error);
        return null;
      });
      if (DEBUG_STREAM && res) streamDebugLog("snapshot endpoint", res.status, res.ok ? "ok" : "failed");
    } finally {
      streamSnapshotBusyRef.current = false;
      if (streamSnapshotQueuedRef.current) {
        streamSnapshotQueuedRef.current = false;
        void publishStreamSnapshot();
      }
    }
  }, [buildStreamSnapshot]);

  function streamHostDebugRow(ch: StreamCharacterFrame): StreamCharacterDebugRow {
    const resolved = resolveStreamSkin(ch.skin, { isHost: true, sourceIfPublished: "own-setting", warnContext: `board2-host:${ch.id}` });
    const face = ch.id === "c2" ? characterFace2Ref.current : characterFaceRef.current;
    return {
      id: ch.id,
      isHost: true,
      skinPublished: resolved.published,
      skinResolved: resolved.skin,
      skinSource: resolved.source,
      actionType: ch.actionType,
      actionProgress: ch.progress,
      physique: ch.physique,
      facing: ch.facing,
      travelDx: ch.velocity?.x,
      rotationDirection: ch.actionType === "flip" ? ch.facing : undefined,
      construction: streamCharacterConstructionParams(resolved.skin, 1, { hasFace: !!face?.faceBlobUrl, faceAspect: face?.faceAspect ?? 1, jacked: ch.physique === "jacked" }),
    };
  }

  function streamGuestDebugRow(frame: GuestCharacterFrame): StreamCharacterDebugRow {
    const resolved = resolveStreamSkin(frame.skin, { isHost: false, sourceIfPublished: "presence", guestSkinOverride: streamGuestSkinRef.current, warnContext: `board2-guest:${frame.guestId}` });
    return {
      id: frame.guestId,
      isHost: false,
      skinPublished: resolved.published,
      skinResolved: resolved.skin,
      skinSource: resolved.source,
      actionType: frame.actionType,
      actionProgress: frame.actionProgress,
      physique: frame.physique ?? "slim",
      facing: frame.facing,
      travelDx: frame.velocity?.x,
      rotationDirection: frame.actionType === "flip" ? frame.facing : undefined,
      construction: streamCharacterConstructionParams(resolved.skin, 1, { hasFace: !!streamGuestFacesRef.current.get(frame.guestId), faceAspect: 1, jacked: (frame.physique ?? "slim") === "jacked" }),
    };
  }

  function refreshStreamDebugRows(wallMs: number) {
    if (!DEBUG_STREAM || wallMs - streamLastDebugOverlayAtRef.current < 600) return;
    streamLastDebugOverlayAtRef.current = wallMs;
    setStreamCharacterDebugRows([...streamHostCharacterDebugRef.current, ...streamGuestCharacterDebugRef.current]);
  }

  const publishStreamFrame = useCallback((wallMs: number) => {
    const channel = streamChannelRef.current;
    const cam = playModeRef.current ? playCameraRef.current : liveCameraRef.current;
    if (!channel || !cam || !streamSessionIdRef.current) return;
    if (wallMs - streamLastFrameAtRef.current < 1000 / STREAM_FPS) return;
    streamLastFrameAtRef.current = wallMs;
    const sentAt = Date.now();
    const seq = ++streamFrameSeqRef.current;
    const characters = playModeRef.current
      ? (["c1", "c2"] as CharacterId[]).map((id): StreamCharacterFrame => {
          const state = id === "c1" ? playPhysicsRef.current : null;
          const runtime = id === "c1" ? playActionRuntimeRef.current : null;
          const resolved = runtime?.enabled ? liveResolvedActions(runtime, clipsRef.current, streamCratersRef.current) : [];
          const t = runtime?.enabled ? liveRuntimeSeconds(runtime, wallMs) : 0;
          const active = resolved.find((a) => t >= a.startTime && t <= a.startTime + a.duration);
          let pose = runtime?.enabled && state
            ? (runtime.currentPose ?? evalLiveCharacterAtWallTime(runtime, wallMs, clipsRef.current, authoredAnimationsRef.current, false, 1, streamCratersRef.current))
            : state ? sharedPlayPoseFromPhysics(state, playTimeRef.current) : null;
          if (pose && id === "c1") {
            if (playBazookaArmedRef.current) pose = { ...pose, hideArms: true };
            pose = applyPlayForceChokePose(pose);
          }
          const viseme = resolvedCharacterViseme(id, runtime?.enabled ? t : playTimeRef.current, clipsRef.current, resolved);
          const face = id === "c2" ? characterFace2Ref.current : characterFaceRef.current;
          const moving = state ? Math.abs(state.vx) > 40 : false;
          const actionType = active?.type ?? (!state
            ? "idle"
            : !state.grounded ? "jumpTo"
              : moving ? (Math.abs(state.vx) >= PLAY_RUN_SPEED * 0.72 ? "runTo" : "walkTo")
              : "idle");
          const actionDuration = active?.duration ?? (!state?.grounded ? 1.1 : moving ? 0.8 : 2);
          const actionProgress = active ? clamp((t - active.startTime) / Math.max(0.001, active.duration), 0, 1) : state ? (actionType === "idle" ? 0 : moving ? ((state.stride / (Math.PI * 2)) % 1 + 1) % 1 : clamp((state.vy + PLAY_JUMP_SPEED) / (PLAY_JUMP_SPEED + PLAY_MAX_FALL_SPEED), 0, 1)) : 0;
          return {
            id,
            enabled: !!state,
            x: pose?.boardX ?? state?.x ?? 0,
            y: pose?.boardY ?? state?.y ?? 0,
            facing: pose?.facing ?? state?.facing ?? 1,
            physique: runtime?.enabled ? physiqueAt(t, resolved) : "slim",
            skin: HOST_STREAM_SKIN,
            actionType,
            progress: actionProgress,
            actionStartTime: sentAt - actionProgress * actionDuration * 1000,
            actionDuration,
            velocity: { x: state?.vx ?? 0, y: state?.vy ?? 0 },
            boardPose: pose ? { ...pose, viseme } : undefined,
            emoji: pose?.emojiText,
            emojiAlpha: pose?.emojiAlpha,
            viseme,
            mouthAnchor: face?.mouthAnchor,
          };
        })
      : (["c1", "c2"] as CharacterId[]).map((id): StreamCharacterFrame => {
          const runtime = liveCharactersRef.current[id];
          const t = liveRuntimeSeconds(runtime, wallMs);
          const resolved = liveResolvedActions(runtime, clipsRef.current, streamCratersRef.current);
          const active = resolved.find((a) => t >= a.startTime && t <= a.startTime + a.duration);
          const pose = runtime.currentPose ?? evalLiveCharacterAtWallTime(runtime, wallMs, clipsRef.current, authoredAnimationsRef.current, false, 1, streamCratersRef.current);
          const progress = active ? clamp((t - active.startTime) / Math.max(0.001, active.duration), 0, 1) : 0;
          const duration = active?.duration ?? 2;
          const viseme = resolvedCharacterViseme(id, t, clipsRef.current, resolved);
          const face = id === "c2" ? characterFace2Ref.current : characterFaceRef.current;
          return {
            id,
            enabled: runtime.enabled,
            x: pose.boardX,
            y: pose.boardY,
            facing: pose.facing,
            physique: physiqueAt(t, resolved),
            skin: HOST_STREAM_SKIN,
            actionType: active?.type ?? "idle",
            progress,
            actionStartTime: sentAt - progress * duration * 1000,
            actionDuration: duration,
            velocity: { x: 0, y: 0 },
            boardPose: { ...pose, viseme },
            emoji: pose.emojiText,
            emojiAlpha: pose.emojiAlpha,
            viseme,
            mouthAnchor: face?.mouthAnchor,
          };
        });
    streamHostCharacterDebugRef.current = characters.filter((ch) => ch.enabled).map(streamHostDebugRow);
    refreshStreamDebugRows(wallMs);
    if (DEBUG_STREAM && wallMs - streamLastDebugFrameAtRef.current > 2000) {
      streamLastDebugFrameAtRef.current = wallMs;
        streamDebugLog("frame broadcast", {
          channel: streamChannelName(STREAM_OWNER_USER_ID),
          mode: playModeRef.current ? "play" : "live-control",
          renderer: RENDERER_VERSION,
          guestSkin: streamGuestSkinRef.current,
          camera: cam,
        characters: streamHostCharacterDebugRef.current,
      });
    }
    channel.send({
      type: "broadcast",
      event: "frame",
      payload: {
        kind: "frame",
        seq,
        streamId: STREAM_OWNER_USER_ID,
        sessionId: streamSessionIdRef.current,
        sentAt,
        camera: cam,
        guestSkin: streamGuestSkinRef.current,
        weapon: playModeRef.current && playPhysicsRef.current
          ? {
              armed: playWeaponArmedRef.current || playBazookaArmedRef.current,
              kind: playBazookaArmedRef.current ? "bazooka" : "tommy",
              shooter: {
                x: playPhysicsRef.current.x,
                y: playPhysicsRef.current.y,
                facing: playPhysicsRef.current.facing,
              },
              aim: playCursorRef.current ?? {
                x: playPhysicsRef.current.x + playPhysicsRef.current.facing * 400,
                y: playPhysicsRef.current.y - 115,
              },
            }
          : { armed: false },
        characters,
      },
    });
  }, []);

  const kickStreamGuest = useCallback((guestId?: string, options?: { reason?: "instant" | "elimination_tommygun"; hostName?: string }) => {
    if (!guestId) return;
    const sentAt = Date.now();
    streamGuestKickTombstonesRef.current.set(guestId, sentAt);
    streamChannelRef.current?.send({ type: "broadcast", event: "kick", payload: { kind: "kick", streamId: STREAM_OWNER_USER_ID, sessionId: streamSessionIdRef.current, guestId, sentAt, reason: options?.reason ?? "instant", hostName: options?.hostName } });
    streamGuestFramesRef.current.delete(guestId);
    streamRenderedGuestFramesRef.current.delete(guestId);
    streamGuestEntitiesRef.current.delete(guestId);
    streamGuestSeqRef.current.delete(guestId);
    streamGuestClockOffsetsRef.current.delete(guestId);
    streamEliminationsRef.current.delete(guestId);
    streamChokeStatesRef.current.delete(guestId);
    streamGuestSignsRef.current.delete(guestId);
    playWeaponHitCountsRef.current.delete(guestId);
    playEliminationKickSentRef.current.delete(guestId);
    setStreamGuests((current) => current.filter((guest) => guest.guestId !== guestId));
  }, []);

  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { selectedClipIdsRef.current = selectedClipIds; }, [selectedClipIds]);
  useEffect(() => { selectedAnnotationIdsRef.current = selectedAnnotationIds; }, [selectedAnnotationIds]);
  useEffect(() => { mutedLayersRef.current = mutedLayers; }, [mutedLayers]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => {
    ambientVideoEnabledRef.current = ambientVideoEnabled;
    try { window.localStorage.setItem(AMBIENT_VIDEO_STORAGE_KEY, ambientVideoEnabled ? "1" : "0"); } catch {}
  }, [ambientVideoEnabled]);
  useEffect(() => { canvasWRef.current = canvasW; canvasHRef.current = canvasH; }, [canvasW, canvasH]);
  useEffect(() => { boardZoomRef.current = boardZoom; }, [boardZoom]);
  useEffect(() => { boardPanRef.current = boardPan; }, [boardPan]);
  useEffect(() => { customZoomDrawModeRef.current = customZoomDrawMode; }, [customZoomDrawMode]);
  useEffect(() => { cameraKeyframesRef.current = cameraKeyframes; }, [cameraKeyframes]);
  useEffect(() => { cameraModeRef.current = cameraMode; }, [cameraMode]);
  useEffect(() => { cameraKeyframeModeRef.current = cameraKeyframeMode; }, [cameraKeyframeMode]);
  useEffect(() => { characterDurationRef.current = characterDuration; }, [characterDuration]);
  useEffect(() => { pxPerSecRef.current = pxPerSec; }, [pxPerSec]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { annotationToolRef.current = annotationTool; }, [annotationTool]);
  useEffect(() => { annotationColorRef.current = annotationColor; }, [annotationColor]);
  useEffect(() => { annotationFontRef.current = annotationFont; }, [annotationFont]);
  useEffect(() => { annotationHighlightStyleRef.current = annotationHighlightStyle; }, [annotationHighlightStyle]);
  useEffect(() => { editingAnnotationTextRef.current = editingAnnotationText; }, [editingAnnotationText]);
  useEffect(() => { annotationEmojiRef.current = annotationEmoji; }, [annotationEmoji]);
  useEffect(() => {
    if (editingAnnotationId) {
      requestAnimationFrame(() => editingTextareaRef.current?.focus());
    }
  }, [editingAnnotationId]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { showCharacterRef.current = showCharacter; }, [showCharacter]);
  useEffect(() => { showCharacter2Ref.current = showCharacter2; }, [showCharacter2]);
  useEffect(() => { characterFaceRef.current = characterFace; }, [characterFace]);
  useEffect(() => { characterFace2Ref.current = characterFace2; }, [characterFace2]);
  useEffect(() => {
    characterFaceImageRef.current = null;
    if (!characterFace?.faceBlobUrl) {
      drawFrameRef.current(playheadRef.current);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      characterFaceImageRef.current = img;
      drawFrameRef.current(playheadRef.current);
    };
    img.onerror = () => {
      if (cancelled) return;
      characterFaceImageRef.current = null;
      drawFrameRef.current(playheadRef.current);
    };
    img.src = characterFace.faceBlobUrl;
    return () => { cancelled = true; };
  }, [characterFace?.faceBlobUrl]);
  useEffect(() => {
    characterFace2ImageRef.current = null;
    if (!characterFace2?.faceBlobUrl) {
      drawFrameRef.current(playheadRef.current);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      characterFace2ImageRef.current = img;
      drawFrameRef.current(playheadRef.current);
    };
    img.onerror = () => {
      if (cancelled) return;
      characterFace2ImageRef.current = null;
      drawFrameRef.current(playheadRef.current);
    };
    img.src = characterFace2.faceBlobUrl;
    return () => { cancelled = true; };
  }, [characterFace2?.faceBlobUrl]);
  // Live crop-modal preview — baked from the same helper as the final "Use Face" bake, so the
  // preview is a regression test: what's shown here is exactly the pixels that will be used.
  useEffect(() => {
    if (!faceCropSource) {
      const timer = window.setTimeout(() => {
        setFaceCropPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return null;
        });
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    bakeFaceCropImage(faceCropSource.url, faceCrop)
      .then(({ blob, aspect }) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setFaceCropPreview((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { url, aspect };
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [faceCropSource, faceCrop]);
  useEffect(() => { characterActionsRef.current = characterActions; }, [characterActions]);
  useEffect(() => { characterActions2Ref.current = characterActions2; }, [characterActions2]);
  useEffect(() => { selectedCharActionIdRef.current = selectedCharActionId; }, [selectedCharActionId]);
  useEffect(() => { authoredAnimationsRef.current = animationMap(authoredAnimations); }, [authoredAnimations]);
  useEffect(() => { characterModeRef.current = characterMode; }, [characterMode]);
  useEffect(() => { characterMode2Ref.current = characterMode2; }, [characterMode2]);
  useEffect(() => { characterSkinRef.current = characterSkin; }, [characterSkin]);
  useEffect(() => { characterSkin2Ref.current = characterSkin2; }, [characterSkin2]);
  useEffect(() => {
    characterVisemeModeRef.current = characterViseme;
    characterVisemeRef.current = characterViseme === "auto" ? "rest" : characterViseme;
  }, [characterViseme]);
  useEffect(() => {
    characterVisemeMode2Ref.current = characterViseme2;
    characterViseme2Ref.current = characterViseme2 === "auto" ? "rest" : characterViseme2;
  }, [characterViseme2]);
  useEffect(() => { activeCharacterIdRef.current = activeCharacterId; }, [activeCharacterId]);
  useEffect(() => { liveControlEnabledRef.current = liveControlEnabled; }, [liveControlEnabled]);
  useEffect(() => { streamGuestSkinRef.current = streamGuestSkin; }, [streamGuestSkin]);
  useEffect(() => { spawnDoorRef.current = spawnDoor; }, [spawnDoor]);
  useEffect(() => { liveCameraModeRef.current = liveCameraMode; }, [liveCameraMode]);
  useEffect(() => { liveHeldCommandRef.current = liveHeldCommand; }, [liveHeldCommand]);
  useEffect(() => { characterAddModeRef.current = characterAddMode; }, [characterAddMode]);

  function resolvedCharacterViseme(
    id: CharacterId,
    time: number,
    sourceClips: readonly Clip[] = clipsRef.current,
    actions: readonly ResolvedCharAction[] = id === "c2" ? resolvedCharActions2Ref.current : resolvedCharActionsRef.current,
  ): Viseme {
    const mode = id === "c2" ? characterVisemeMode2Ref.current : characterVisemeModeRef.current;
    if (mode !== "auto") return mode;
    const narration = narrationVisemeAt(time, sourceClips);
    if (narration !== "rest") return narration;
    return actionSpeechVisemeAt(time, actions, id);
  }
  useEffect(() => { playModeRef.current = playMode; }, [playMode]);
  useEffect(() => { playWeaponArmedRef.current = playWeaponArmed; }, [playWeaponArmed]);
  useEffect(() => {
    playOverlayInputActiveRef.current = playMode && (ytModalOpen || playAddMenuOpen);
    if (playOverlayInputActiveRef.current) {
      playHeldKeysRef.current.clear();
      playPointerRef.current = null;
      const state = playPhysicsRef.current;
      if (state) {
        state.vx = 0;
      }
    }
  }, [playMode, ytModalOpen, playAddMenuOpen]);
  // Resolved character actions are COMPUTED, not stored — this useMemo recomputes from scratch
  // whenever clips (reorder/add/delete/holdFraction/board-position — all produce a new `clips`
  // array reference), characterActions (manual edits), or characterMode change. There is no way
  // for this to go stale: a clip reorder is automatically reflected on the very next render.
  const defaultCharInit = useMemo(() => getCharInitPos(clips), [clips]);
  const charInit = characterStart ?? defaultCharInit;
  const charInit2 = useMemo(() => characterStart2 ?? { x: charInit.x + 60, y: charInit.y }, [characterStart2, charInit]);
  const resolvedCharActions = useMemo(() => {
    const merged = characterMode === "auto"
      ? mergeCharActions(deriveAutoCharActions(clips, charInit.x, charInit.y, cameraKeyframes, canvasW, canvasH), characterActions)
      : characterActions;
    return resolveCharActions(merged, charInit.x, charInit.y, clips);
  }, [clips, characterActions, characterMode, charInit, cameraKeyframes, canvasW, canvasH]);
  const characterEntranceTime = useMemo(() => {
    if (characterMode !== "auto") return -Infinity;
    const focusClips = clips.filter((c) => c.type !== "narration" && (c.type === "pan" || c.type === "characterZoom" || c.boardX !== undefined));
    if (focusClips.length > 0 && focusClips.every((c) => c.type === "pan" || c.type === "characterZoom")) return Infinity;
    const entrance = resolvedCharActions.find((a) => a.entranceFlip);
    return entrance ? entrance.startTime : -Infinity;
  }, [characterMode, clips, resolvedCharActions]);
  const resolvedCharActions2 = useMemo(() => {
    const merged = characterMode2 === "auto"
      ? mergeCharActions(deriveAutoCharActions(clips, charInit2.x, charInit2.y, cameraKeyframes, canvasW, canvasH), characterActions2)
      : characterActions2;
    return resolveCharActions(
      merged,
      charInit2.x,
      charInit2.y,
      clips,
      showCharacter ? [{ resolved: resolvedCharActions, initX: charInit.x, initY: charInit.y, entranceTime: characterEntranceTime }] : [],
      characterMode2 === "auto" ? 60 : 0
    );
  }, [clips, characterActions2, characterMode2, charInit, charInit2, cameraKeyframes, canvasW, canvasH, showCharacter, resolvedCharActions, characterEntranceTime]);

  // Character-camera mode resolves stored manual + AI choreography only. Clip-schedule auto
  // derivation stays exclusive to clips mode, while Character 2 retains the current collision
  // resolver and is available to widen settled framing without becoming the follow target.
  const cameraResolvedCharActions = useMemo(
    () => resolveCharActions(characterActions, charInit.x, charInit.y, clips),
    [characterActions, charInit, clips],
  );
  const cameraResolvedCharActions2 = useMemo(
    () => resolveCharActions(
      characterActions2,
      charInit2.x,
      charInit2.y,
      clips,
      showCharacter ? [{ resolved: cameraResolvedCharActions, initX: charInit.x, initY: charInit.y, entranceTime: -Infinity }] : [],
      60,
    ),
    [characterActions2, charInit, charInit2, clips, showCharacter, cameraResolvedCharActions],
  );
  const occupancyWindows = useMemo(() => {
    if (cameraKeyframeMode !== "character" || characterDuration <= 0) return [];
    return deriveOccupancyWindows({
      actions: cameraResolvedCharActions,
      clips,
      duration: characterDuration,
      positionAt: (time) => {
        const pose = evalCharAtTime(time, cameraResolvedCharActions, charInit.x, charInit.y, clips);
        return { x: pose.boardX, y: pose.boardY };
      },
    });
  }, [cameraKeyframeMode, characterDuration, cameraResolvedCharActions, clips, charInit]);
  useEffect(() => { occupancyWindowsRef.current = occupancyWindows; }, [occupancyWindows]);

  // Before the auto-derived entrance flip lands, the character isn't on the board at all (see
  // deriveAutoCharActions) — this is when that flip starts, or +Infinity if the timeline is
  // pan-only (no media to flip onto, so he never appears) or -Infinity outside auto mode.
  const characterEntranceTime2 = useMemo(() => {
    if (characterMode2 !== "auto") return -Infinity;
    const focusClips = clips.filter((c) => c.type !== "narration" && (c.type === "pan" || c.type === "characterZoom" || c.boardX !== undefined));
    if (focusClips.length > 0 && focusClips.every((c) => c.type === "pan" || c.type === "characterZoom")) return Infinity;
    const entrance = resolvedCharActions2.find((a) => a.entranceFlip);
    return entrance ? entrance.startTime : -Infinity;
  }, [characterMode2, clips, resolvedCharActions2]);

  // Mirror the memoized result into refs for the RAF draw loop (which must avoid stale closures)
  useEffect(() => {
    charInitXRef.current = charInit.x;
    charInitYRef.current = charInit.y;
    charInit2XRef.current = charInit2.x;
    charInit2YRef.current = charInit2.y;
    resolvedCharActionsRef.current = resolvedCharActions;
    resolvedCharActions2Ref.current = resolvedCharActions2;
    characterEntranceTimeRef.current = characterEntranceTime;
    characterEntranceTime2Ref.current = characterEntranceTime2;
  }, [charInit, charInit2, resolvedCharActions, resolvedCharActions2, characterEntranceTime, characterEntranceTime2]);

  useEffect(() => {
    const check = () => {
      setIsMobile(window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches);
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  useEffect(() => {
    if (!session?.user?.email) return;
    let cancelled = false;
    fetch("/api/board2/character-animations")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        const raw = Array.isArray(data) ? data : data.animations;
        const next = (raw ?? []).map(normalizeAnimation).filter(Boolean) as AuthoredAnimation[];
        setAuthoredAnimations(next);
      })
      .catch(() => {
        if (!cancelled) setAuthoredAnimations([]);
      });
    return () => { cancelled = true; };
  }, [session?.user?.email]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast]);

  useEffect(() => {
    if (!liveControlEnabled) return;
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return !!el.closest("input, textarea, select, [contenteditable='true']");
    };
    const keyToCommand = (key: string): LiveCommandKey | null => {
      const k = key.toLowerCase();
      if (k === "w") return "walkTo";
      if (k === "r") return "runTo";
      if (k === "j") return "jumpTo";
      if (k === "f") return "flip";
      if (k === "g") return "grapple";
      if (k === "z") return "zipline";
      if (k === "s") return "skateTo";
      if (k === "c") return "wallClimb";
      if (k === "d") return "dance";
      if (k === "p") return "pullUps";
      if (k === "m") return "mirrorCheck";
      if (k === "t") return "sitAndWatch";
      if (k === "e") return "emote";
      if (k === "x") return "stop";
      return null;
    };
    const tapCommands = new Set<LiveCommandKey>(["dance", "pullUps", "mirrorCheck", "sitAndWatch", "emote", "stop"]);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === "1" || e.key === "2" || e.key === "Tab") {
        e.preventDefault();
        const next: CharacterId = e.key === "1" ? "c1" : e.key === "2" ? "c2" : activeCharacterIdRef.current === "c1" ? "c2" : "c1";
        if (next === "c2") setShowCharacter2(true);
        setActiveCharacterId(next);
        resetLiveRuntimeFor(next);
        return;
      }
      if (e.key.toLowerCase() === "v") {
        e.preventDefault();
        toggleLiveCameraMode();
        return;
      }
      const cmd = keyToCommand(e.key);
      if (!cmd || e.repeat) return;
      e.preventDefault();
      if (tapCommands.has(cmd)) {
        issueLiveAction(activeCharacterIdRef.current, cmd);
        setLiveHeldCommand(null);
      } else {
        setLiveHeldCommand(cmd);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const cmd = keyToCommand(e.key);
      if (cmd && liveHeldCommandRef.current === cmd) setLiveHeldCommand(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [liveControlEnabled, issueLiveAction, resetLiveRuntimeFor, toggleLiveCameraMode]);

  useEffect(() => {
    if (!liveControlEnabled) {
      if (liveRafIdRef.current !== null) cancelAnimationFrame(liveRafIdRef.current);
      liveRafIdRef.current = null;
      liveHeldCommandRef.current = null;
      liveCameraRef.current = null;
      liveCameraModeRef.current = "character";
      liveSceneSurfaceKeyRef.current = null;
      liveSceneCameraRef.current = null;
      liveCameraTransitionRef.current = null;
      if (!playModeRef.current) drawFrameRef.current(playheadRef.current);
      return;
    }
    isPlayingRef.current = false;
    resetLiveRuntimeFor("c1");
    if (showCharacter2Ref.current) resetLiveRuntimeFor("c2");
    void publishStreamSnapshot();
    const loop = () => {
      const wallMs = performance.now();
      const t = playheadRef.current;
      drawFrameRef.current(t);
      evaluateVideoPlaybackStatesRef.current?.(t, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current, {
        audioMode: "silent",
        overrideCamera: liveCameraRef.current,
      });
      publishStreamFrame(wallMs);
      liveRafIdRef.current = requestAnimationFrame(loop);
    };
    liveRafIdRef.current = requestAnimationFrame(loop);
    return () => {
      if (liveRafIdRef.current !== null) cancelAnimationFrame(liveRafIdRef.current);
      liveRafIdRef.current = null;
    };
  }, [liveControlEnabled, publishStreamFrame, publishStreamSnapshot, resetLiveRuntimeFor]);

  useEffect(() => {
    const streamActive = liveControlEnabled || playMode;
    const channelName = streamChannelName(STREAM_OWNER_USER_ID);
    if (!streamActive) {
      window.setTimeout(() => setStreamPublishing(false), 0);
      if (streamSessionIdRef.current) {
        const endPayload = { kind: "session-end", streamId: STREAM_OWNER_USER_ID, sessionId: streamSessionIdRef.current, sentAt: Date.now() };
        streamDebugLog("session end", { channel: channelName, sessionId: streamSessionIdRef.current });
        streamChannelRef.current?.send({ type: "broadcast", event: "session-end", payload: endPayload });
        fetch("/api/stream/snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(endPayload),
        }).catch((error) => streamDebugLog("session-end endpoint failed", error));
      }
      if (streamChannelRef.current) {
        const supabase = getBrowserSupabase();
        supabase?.removeChannel(streamChannelRef.current);
        streamChannelRef.current = null;
      }
      streamSessionIdRef.current = "";
      streamGuestFramesRef.current.clear();
      streamRenderedGuestFramesRef.current.clear();
      streamGuestEntitiesRef.current.clear();
      streamGuestSeqRef.current.clear();
      streamGuestClockOffsetsRef.current.clear();
      streamGuestFacesRef.current.clear();
      streamGuestSignsRef.current.clear();
      streamEliminationsRef.current.clear();
      streamChokeStatesRef.current.clear();
      streamGuestKickTombstonesRef.current.clear();
      window.setTimeout(() => setStreamGuests([]), 0);
      return;
    }

    if (!streamSessionIdRef.current) {
      streamSessionIdRef.current = generateId();
      streamLastFrameAtRef.current = 0;
      streamFrameSeqRef.current = 0;
      streamLastDebugFrameAtRef.current = 0;
      streamDebugLog("session start", {
        channel: channelName,
        sessionId: streamSessionIdRef.current,
        mode: playMode ? "play" : "live-control",
        hasBrowserSupabase: !!getBrowserSupabase(),
        hasUserEmail: !!session?.user?.email,
      });
    }

    const supabase = getBrowserSupabase();
    if (supabase && session?.user?.email && !streamChannelRef.current) {
      streamDebugLog("join channel", { channel: channelName, presenceKey: session.user.email });
      const channel = supabase.channel(channelName, {
        config: { broadcast: { self: false }, presence: { key: session.user.email } },
      });
      streamChannelRef.current = channel;
      channel
        .on("broadcast", { event: "guest-state" }, ({ payload }) => {
          const frame = payload as GuestCharacterFrame;
          if (frame.sessionId === streamSessionIdRef.current) {
            const tombstoneAt = streamGuestKickTombstonesRef.current.get(frame.guestId);
            if (tombstoneAt) {
              streamDebugLog("ignore tombstoned guest-state", { guestId: frame.guestId, frameSentAt: frame.sentAt, tombstoneAt });
              return;
            }
            const previousSeq = streamGuestSeqRef.current.get(frame.guestId) ?? -1;
            if (frame.seq !== undefined && frame.seq <= previousSeq) {
              streamDebugLog("drop stale guest-state", { guestId: frame.guestId, seq: frame.seq, previousSeq });
              return;
            }
            if (frame.seq !== undefined) streamGuestSeqRef.current.set(frame.guestId, frame.seq);
            if (validGuestSignDataUrl(frame.signDataUrl) && streamGuestSignsRef.current.get(frame.guestId)?.src !== frame.signDataUrl) {
              const image = new Image();
              image.src = frame.signDataUrl;
              streamGuestSignsRef.current.set(frame.guestId, image);
            }
            const measuredOffset = Date.now() - frame.sentAt;
            const prevOffset = streamGuestClockOffsetsRef.current.get(frame.guestId) ?? measuredOffset;
            streamGuestClockOffsetsRef.current.set(frame.guestId, prevOffset * 0.85 + measuredOffset * 0.15);
            streamGuestFramesRef.current.set(frame.guestId, { ...frame, receivedAt: Date.now() });
          }
        })
        .on("broadcast", { event: "elimination" }, ({ payload }) => {
          const event = payload as StreamEliminationMessage;
          if (event.sessionId === streamSessionIdRef.current) streamEliminationsRef.current.set(event.targetGuestId, event);
        })
        .on("broadcast", { event: "choke_state" }, ({ payload }) => {
          const event = payload as StreamChokeMessage;
          if (event.sessionId !== streamSessionIdRef.current) return;
          if (event.phase === "end") streamChokeStatesRef.current.delete(event.targetGuestId);
          else streamChokeStatesRef.current.set(event.targetGuestId, event);
        })
        .on("broadcast", { event: "snapshot-request" }, ({ payload }) => {
          streamDebugLog("snapshot request", payload);
          void publishStreamSnapshot();
        })
        .on("presence", { event: "sync" }, () => {
          const people = Object.values(channel.presenceState()).flat() as unknown as StreamParticipantPresence[];
          streamDebugLog("presence sync", people);
          const guests = people.filter((person) => person.role === "guest").slice(0, MAX_GUESTS);
          setStreamGuests(guests);
          const activeGuestIds = new Set(guests.map((guest) => guest.guestId).filter(Boolean));
          for (const guestId of streamGuestFramesRef.current.keys()) {
            if (!activeGuestIds.has(guestId)) {
              streamGuestFramesRef.current.delete(guestId);
              streamRenderedGuestFramesRef.current.delete(guestId);
              streamGuestEntitiesRef.current.delete(guestId);
              streamGuestSeqRef.current.delete(guestId);
              streamGuestClockOffsetsRef.current.delete(guestId);
              streamEliminationsRef.current.delete(guestId);
              streamChokeStatesRef.current.delete(guestId);
              streamGuestSignsRef.current.delete(guestId);
              playWeaponHitCountsRef.current.delete(guestId);
              playEliminationKickSentRef.current.delete(guestId);
            }
          }
          for (const guest of guests) {
            if (!guest.guestId) continue;
            const staleElimination = streamEliminationsRef.current.get(guest.guestId);
            if (staleElimination && guest.joinedAt > staleElimination.sentAt) {
              streamDebugLog("clear stale elimination on rejoin", { guestId: guest.guestId, joinedAt: guest.joinedAt, eliminationSentAt: staleElimination.sentAt });
              streamEliminationsRef.current.delete(guest.guestId);
              streamChokeStatesRef.current.delete(guest.guestId);
              streamGuestFramesRef.current.delete(guest.guestId);
              streamRenderedGuestFramesRef.current.delete(guest.guestId);
              streamGuestEntitiesRef.current.delete(guest.guestId);
              streamGuestSeqRef.current.delete(guest.guestId);
              playWeaponHitCountsRef.current.delete(guest.guestId);
              playEliminationKickSentRef.current.delete(guest.guestId);
            }
            const kickedAt = streamGuestKickTombstonesRef.current.get(guest.guestId);
            if (kickedAt && guest.joinedAt > kickedAt) {
              streamDebugLog("clear kick tombstone on rejoin", { guestId: guest.guestId, joinedAt: guest.joinedAt, kickedAt });
              streamGuestKickTombstonesRef.current.delete(guest.guestId);
              playWeaponHitCountsRef.current.delete(guest.guestId);
              playEliminationKickSentRef.current.delete(guest.guestId);
            }
            if (guest.faceDataUrl && !streamGuestFacesRef.current.has(guest.guestId)) {
              const image = new Image(); image.src = guest.faceDataUrl;
              streamGuestFacesRef.current.set(guest.guestId, image);
            }
            if (validGuestSignDataUrl(guest.signDataUrl) && streamGuestSignsRef.current.get(guest.guestId)?.src !== guest.signDataUrl) {
              const sign = new Image(); sign.src = guest.signDataUrl;
              streamGuestSignsRef.current.set(guest.guestId, sign);
            }
          }
        })
        .subscribe(async (status) => {
          streamDebugLog("subscribe status", status);
          setStreamPublishing(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") {
            const presence = { role: "host", isHost: true, name: STREAM_OWNER_USER_ID, skin: HOST_STREAM_SKIN, physique: "slim", guestSkin: streamGuestSkinRef.current, joinedAt: Date.now() } satisfies StreamParticipantPresence;
            streamDebugLog("presence track send", presence);
            await channel.track(presence);
            void publishStreamSnapshot();
          }
        });
    } else if (!supabase || !session?.user?.email) {
      streamDebugLog("publisher not connected", {
        channel: channelName,
        hasBrowserSupabase: !!supabase,
        hasUserEmail: !!session?.user?.email,
      });
      window.setTimeout(() => setStreamPublishing(false), 0);
    }

    void publishStreamSnapshot();
  }, [liveControlEnabled, playMode, publishStreamSnapshot, session?.user?.email]);

  useEffect(() => {
    if (!(liveControlEnabled || playMode)) return;
    void publishStreamSnapshot();
  }, [liveControlEnabled, playMode, clips, annotations, characterFace, characterFace2, showCharacter, showCharacter2, spawnDoor, publishStreamSnapshot]);

  useEffect(() => {
    if (!(liveControlEnabled || playMode) || !streamChannelRef.current) return;
    const presence = { role: "host", isHost: true, name: STREAM_OWNER_USER_ID, skin: HOST_STREAM_SKIN, physique: "slim", guestSkin: streamGuestSkin, joinedAt: Date.now() } satisfies StreamParticipantPresence;
    streamDebugLog("presence track send", presence);
    void streamChannelRef.current.track(presence);
    publishStreamFrame(performance.now());
  }, [streamGuestSkin, liveControlEnabled, playMode, publishStreamFrame]);

  useEffect(() => {
    return () => {
      if (!streamSessionIdRef.current) return;
      const endPayload = { kind: "session-end", streamId: STREAM_OWNER_USER_ID, sessionId: streamSessionIdRef.current, sentAt: Date.now() };
      streamChannelRef.current?.send({ type: "broadcast", event: "session-end", payload: endPayload });
      fetch("/api/stream/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endPayload),
      }).catch(() => {});
      const supabase = getBrowserSupabase();
      if (streamChannelRef.current) supabase?.removeChannel(streamChannelRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (micRafRef.current !== null) cancelAnimationFrame(micRafRef.current);
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Apply pending scroll after pxPerSec changes
  useEffect(() => {
    if (pendingScrollLeftRef.current !== null) {
      const el = scrollerRef.current;
      if (el) el.scrollLeft = pendingScrollLeftRef.current;
      pendingScrollLeftRef.current = null;
    }
  }, [pxPerSec]);

  // Fit board to container on mount
  useEffect(() => {
    const timeout = setTimeout(() => {
      const container = boardContainerRef.current;
      if (!container) return;
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const zoom = Math.min((width - 60) / BOARD_W, (height - 60) / BOARD_H);
      const panX = (width - BOARD_W * zoom) / 2;
      const panY = (height - BOARD_H * zoom) / 2;
      setBoardZoom(zoom);
      setBoardPan({ x: panX, y: panY });
    }, 30);
    return () => clearTimeout(timeout);
  }, []);

  // Board wheel zoom (non-passive)
  useEffect(() => {
    const container = boardContainerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const pz = boardZoomRef.current;
      const pp = boardPanRef.current;
      const nz = Math.max(0.05, Math.min(3, pz * factor));
      const np = { x: mx - (mx - pp.x) * (nz / pz), y: my - (my - pp.y) * (nz / pz) };
      boardZoomRef.current = nz;
      boardPanRef.current = np;
      setBoardZoom(nz);
      setBoardPan(np);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // Timeline Cmd/Ctrl+scroll zoom (cursor-anchored)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const cursorTimeSec = cursorX / pxPerSecRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newPxPerSec = clamp(pxPerSecRef.current * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
      pxPerSecRef.current = newPxPerSec;
      setPxPerSec(newPxPerSec);
      pendingScrollLeftRef.current = Math.max(0, cursorTimeSec * newPxPerSec - (e.clientX - rect.left));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const drawStreamGuestsToCtx = useCallback((
    ctx: CanvasRenderingContext2D,
    cam: { cameraX: number; cameraY: number; boardZoom: number },
    sf: number,
    W: number,
    H: number,
  ) => {
    const now = Date.now();
    if (spawnDoorRef.current) drawPlacedSpawnDoor(ctx, spawnDoorRef.current, cam, sf, W, H);
    for (const [guestId, event] of streamEliminationsRef.current) {
      if (now - event.startTime > event.duration * 1000 + 800) streamEliminationsRef.current.delete(guestId);
      else drawEliminationSequence(ctx, event, cam, sf, W, H, now);
    }
    streamGuestCharacterDebugRef.current = [];
    for (const frame of streamGuestFramesRef.current.values()) {
      const elimination = streamEliminationsRef.current.get(frame.guestId);
      const choke = streamChokeStatesRef.current.get(frame.guestId);
      const clockOffset = streamGuestClockOffsetsRef.current.get(frame.guestId) ?? 0;
      const activeFrame = choke && choke.phase === "hold"
        ? { ...frame, position: choke.position, velocity: { x: 0, y: -20 }, actionType: "forceChoke" as const, actionProgress: choke.progress, actionStartTime: choke.sentAt - choke.progress * 1400, actionDuration: 1.4 }
        : choke && choke.phase === "drop"
          ? { ...frame, position: choke.position, velocity: { x: 0, y: 540 }, actionType: "jump" as const, actionProgress: 0.85, actionStartTime: choke.sentAt - 900, actionDuration: 1.1 }
          : elimination ? eliminationFrameForGuest(frame, elimination, now) : frame;
      if (!activeFrame) {
        streamRenderedGuestFramesRef.current.delete(frame.guestId);
        streamGuestFramesRef.current.delete(frame.guestId);
        streamGuestEntitiesRef.current.delete(frame.guestId);
        streamGuestSeqRef.current.delete(frame.guestId);
        if (!playEliminationKickSentRef.current.has(frame.guestId)) {
          playEliminationKickSentRef.current.add(frame.guestId);
          kickStreamGuest(frame.guestId, { reason: "elimination_tommygun", hostName: session?.user?.name || "Host" });
        }
        if (process.env.NODE_ENV !== "production") console.debug("[stream:despawn]", { where: "host-board", guestId: frame.guestId, event: elimination?.sequenceType, removedAt: now, gapFrames: 0 });
        continue;
      }
      const previous = streamRenderedGuestFramesRef.current.get(frame.guestId);
      const smoothed = previous
        ? {
            ...activeFrame,
            position: {
              x: lerp(previous.position.x, activeFrame.position.x, elimination ? 0.85 : 0.42),
              y: lerp(previous.position.y, activeFrame.position.y, elimination ? 0.85 : 0.42),
            },
          }
        : activeFrame;
      streamRenderedGuestFramesRef.current.set(frame.guestId, smoothed);
      const row = streamGuestDebugRow(smoothed);
      const existingIndex = streamGuestCharacterDebugRef.current.findIndex((item) => item.id === row.id);
      if (existingIndex >= 0) streamGuestCharacterDebugRef.current[existingIndex] = row;
      else streamGuestCharacterDebugRef.current.push(row);
      refreshStreamDebugRows(performance.now());
      let entity = streamGuestEntitiesRef.current.get(frame.guestId);
      if (!entity) {
        entity = new CharacterEntity({
          id: frame.guestId,
          isHost: false,
          name: frame.name,
          skin: streamGuestSkinRef.current,
          physique: frame.physique ?? "slim",
          mouthAnchor: frame.mouthAnchor,
        });
        streamGuestEntitiesRef.current.set(frame.guestId, entity);
      }
      entity.identity = {
        ...entity.identity,
        name: frame.name,
        skin: streamGuestSkinRef.current,
        physique: smoothed.physique ?? "slim",
        mouthAnchor: smoothed.mouthAnchor,
      };
      entity.setGuestFrame(smoothed, clockOffset, streamGuestSkinRef.current);
      entity.draw({
        ctx,
        cam,
        sf,
        width: W,
        height: H,
        face: streamGuestFacesRef.current.get(frame.guestId) ?? null,
        sign: streamGuestSignsRef.current.get(frame.guestId) ?? null,
        renderTimeMs: now,
      });
    }
  }, [kickStreamGuest, session?.user?.name]);

  // ─ Canvas draw ────────────────────────────────────────────────────────────

  const renderToCtx = useCallback((
    ctx: CanvasRenderingContext2D,
    time: number,
    currentClips: Clip[],
    currentCameraKeyframes: CameraKeyframe[],
    W: number,
    H: number,
    currentAnnotations: Annotation[],
    overrideCamera?: { cameraX: number; cameraY: number; boardZoom: number } | null,
    liveWallMs?: number
  ) => {
    ctx.fillStyle = "#f7e5c1";
    ctx.fillRect(0, 0, W, H);
    const cam = overrideCamera ?? interpolateCameraKeyframes(currentCameraKeyframes, time);
    const sf = cam.boardZoom * W / BOARD_W;
    const liveMode = liveControlEnabledRef.current;
    const authoredBazooka = !liveMode && !playModeRef.current
      ? authoredBazookaTimeline(time, [resolvedCharActionsRef.current, resolvedCharActions2Ref.current], currentClips, streamCratersRef.current)
      : { craters: [...streamCratersRef.current], events: [] as BazookaVisualEvent[] };
    const renderCraters = authoredBazooka.craters;
    const authoredShake = bazookaShake(authoredBazooka.events, time * 1000);
    ctx.save();
    ctx.translate(authoredShake.x, authoredShake.y);
    const sortedClips = [...currentClips].sort((a, b) => (a.layer ?? 1) - (b.layer ?? 1));
    for (const clip of sortedClips) {
      if (clip.boardX === undefined) continue;
      const bx = clip.boardX, by = clip.boardY!, bw = clip.boardW!, bh = clip.boardH!;
      const sx = (bx + bw / 2 - cam.cameraX) * sf + W / 2;
      const sy = (by + bh / 2 - cam.cameraY) * sf + H / 2;
      const sw = bw * sf, sh = bh * sf;
      ctx.globalAlpha = 1;
      if (clip.type === "image") {
        const img = imgCacheRef.current.get(clip.sourceUrl);
        if (img?.complete && img.naturalWidth > 0) {
          drawCrateredImage(ctx,img,sx-sw/2,sy-sh/2,sw,sh,bw,bh,renderCraters.filter(crater=>crater.clipId===clip.id));
        }
      } else if (clip.type === "customZoom") {
        // No pixels of its own — it's purely a camera target, so whatever else is on the board
        // at this position (or the bare board surface) shows through untouched.
      } else {
        const vid = videoElsRef.current.get(clip.id);
        const thumbEl = thumbnailImagesRef.current.get(clip.id);
        let drewLive = false;
        const playbackRuntime = videoPlaybackStateRef.current.get(clip.id);
        const playbackMode = playbackRuntime?.state ?? "dormant";
        const justRestartedActive = playbackMode === "active" && playbackRuntime ? performance.now() - playbackRuntime.lastRestartAt < 250 : false;
        // Ambient clips can wrap through currentTime=0 while looping, so drawable state is based
        // primarily on decoded future data + actually playing. The currentTime guard only applies
        // immediately after an active-range restart to avoid the first-play thumbnail/audio race.
        if (vid && vid.readyState >= 3 && !vid.paused && !vid.ended && (!justRestartedActive || vid.currentTime > 0.05)) {
          try { ctx.drawImage(vid, sx - sw / 2, sy - sh / 2, sw, sh); drewLive = true; } catch { drewLive = false; }
        }
        if (drewLive) {
          videoStuckFrameCountRef.current.set(clip.id, 0);
        } else if (playbackMode === "active" || playbackMode === "ambient") {
          drawableFailureCountRef.current++;
        }
        if (!drewLive && playbackMode === "active" && vid && !vid.paused) {
          // Clip should be actively playing but produced no drawable frame this render — track
          // consecutive misses and nudge playback if it's stuck for a few frames in a row.
          const misses = (videoStuckFrameCountRef.current.get(clip.id) ?? 0) + 1;
          videoStuckFrameCountRef.current.set(clip.id, misses);
          if (misses >= 3) {
            vid.currentTime = 0.1;
            vid.play().catch(() => {});
            videoStuckFrameCountRef.current.set(clip.id, 0);
            console.warn("[video] clip", clip.id, "stuck — nudging playback");
          }
        }
        if (!drewLive) {
          if (thumbEl) {
            ctx.drawImage(thumbEl, sx - sw / 2, sy - sh / 2, sw, sh);
          } else {
            // Thumbnail not yet captured or failed — draw black box with play icon
            ctx.fillStyle = "#111";
            ctx.fillRect(sx - sw / 2, sy - sh / 2, sw, sh);
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = `${Math.max(16, Math.min(sw, sh) * 0.3)}px sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("▶", sx, sy);
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    let speechBubbleAnchor: SpeechBubbleAnchor | null = null;
    const setSpeechAnchor = (id: CharacterId, anchor: SpeechBubbleAnchor) => {
      if (!speechBubbleAnchor || activeCharacterIdRef.current === id) speechBubbleAnchor = anchor;
    };
    if (liveMode) {
      const wallMs = liveWallMs ?? performance.now();
      const live = liveCharactersRef.current;
      if (live.c1.enabled) {
        const hasFace = !!(characterFaceRef.current && characterFaceImageRef.current);
        const faceAspect = clamp(characterFaceRef.current?.faceAspect ?? 1, 0.75, 1.6);
        const pose = evalLiveCharacterAtWallTime(live.c1, wallMs, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
        live.c1.currentPose = pose;
        if (poseAllowsSpeechBubble(pose)) setSpeechAnchor("c1", characterHeadSpeechAnchor(pose, cam, sf, W, H, hasFace, faceAspect, physiqueAt(liveRuntimeSeconds(live.c1, wallMs), liveResolvedActions(live.c1, clipsRef.current, streamCratersRef.current))));
        CharacterEntity.drawBoardCharacterToCanvas(
          ctx, liveRuntimeSeconds(live.c1, wallMs), liveResolvedActions(live.c1, clipsRef.current, streamCratersRef.current), true,
          cam, sf, W, H, live.c1.initX, live.c1.initY,
          clipsRef.current, -Infinity, authoredAnimationsRef.current,
          characterFaceRef.current && characterFaceImageRef.current
            ? { image: characterFaceImageRef.current, aspect: characterFaceRef.current.faceAspect, mouthAnchor: characterFaceRef.current.mouthAnchor }
            : null,
          characterSkinRef.current,
          { ...pose, viseme: resolvedCharacterViseme("c1", liveRuntimeSeconds(live.c1, wallMs), currentClips, liveResolvedActions(live.c1, clipsRef.current, streamCratersRef.current)) },
          boardCharacterDrawEvaluators()
        );
      }
      if (live.c2.enabled) {
        const hasFace = !!(characterFace2Ref.current && characterFace2ImageRef.current);
        const faceAspect = clamp(characterFace2Ref.current?.faceAspect ?? 1, 0.75, 1.6);
        const pose = evalLiveCharacterAtWallTime(live.c2, wallMs, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
        live.c2.currentPose = pose;
        if (poseAllowsSpeechBubble(pose)) setSpeechAnchor("c2", characterHeadSpeechAnchor(pose, cam, sf, W, H, hasFace, faceAspect, physiqueAt(liveRuntimeSeconds(live.c2, wallMs), liveResolvedActions(live.c2, clipsRef.current, streamCratersRef.current))));
        CharacterEntity.drawBoardCharacterToCanvas(
          ctx, liveRuntimeSeconds(live.c2, wallMs), liveResolvedActions(live.c2, clipsRef.current, streamCratersRef.current), true,
          cam, sf, W, H, live.c2.initX, live.c2.initY,
          clipsRef.current, -Infinity, authoredAnimationsRef.current,
          characterFace2Ref.current && characterFace2ImageRef.current
            ? { image: characterFace2ImageRef.current, aspect: characterFace2Ref.current.faceAspect, mouthAnchor: characterFace2Ref.current.mouthAnchor }
            : null,
          characterSkin2Ref.current,
          { ...pose, viseme: resolvedCharacterViseme("c2", liveRuntimeSeconds(live.c2, wallMs), currentClips, liveResolvedActions(live.c2, clipsRef.current, streamCratersRef.current)) },
          boardCharacterDrawEvaluators()
        );
      }
      drawStreamGuestsToCtx(ctx, cam, sf, W, H);
    } else if (showCharacterRef.current && !playModeRef.current) {
      const resolved = resolvedCharActionsRef.current;
      const pose = evalCharAtTime(time, resolved, charInitXRef.current, charInitYRef.current, clipsRef.current, authoredAnimationsRef.current, !!(characterFaceRef.current && characterFaceImageRef.current), characterFaceRef.current?.faceAspect ?? 1, renderCraters);
      if (poseAllowsSpeechBubble(pose)) setSpeechAnchor("c1", characterHeadSpeechAnchor(pose, cam, sf, W, H, !!(characterFaceRef.current && characterFaceImageRef.current), characterFaceRef.current?.faceAspect ?? 1, physiqueAt(time, resolved)));
      CharacterEntity.drawBoardCharacterToCanvas(
        ctx, time, resolved, true,
        cam, sf, W, H, charInitXRef.current, charInitYRef.current,
        clipsRef.current, characterEntranceTimeRef.current, authoredAnimationsRef.current,
        characterFaceRef.current && characterFaceImageRef.current
          ? { image: characterFaceImageRef.current, aspect: characterFaceRef.current.faceAspect, mouthAnchor: characterFaceRef.current.mouthAnchor }
          : null,
        characterSkinRef.current,
        { ...pose, viseme: resolvedCharacterViseme("c1", time, currentClips, resolved) },
        boardCharacterDrawEvaluators()
      );
      const active = authoredBazookaDisplayAction(time, resolved);
      if (active?.targetX !== undefined && active.targetY !== undefined) {
        const isActive=time>=active.startTime&&time<active.startTime+active.duration,progress=clamp((time-active.startTime)/active.duration,0,1),fireFraction=authoredBazookaFireFraction(active,resolved),recoilAge=time-(active.startTime+active.duration*fireFraction),recoil=isActive&&recoilAge>=0&&recoilAge<.26?Math.sin((1-recoilAge/.26)*Math.PI)*9:0,pickup=!isActive||authoredBazookaIsChained(active,resolved)?1:authoredBazookaPickupProgress(progress);
        drawBazookaHeld(ctx,{x:pose.boardX,y:pose.boardY,facing:pose.facing},{x:active.targetX,y:active.targetY},cam,sf,W,H,recoil,pickup,{bodyLean:pose.bodyLean,headBob:pose.headBob});
      }
    }
    if (!liveMode && showCharacter2Ref.current && !playModeRef.current) {
      const resolved = resolvedCharActions2Ref.current;
      const pose = evalCharAtTime(time, resolved, charInit2XRef.current, charInit2YRef.current, clipsRef.current, authoredAnimationsRef.current, !!(characterFace2Ref.current && characterFace2ImageRef.current), characterFace2Ref.current?.faceAspect ?? 1, renderCraters);
      if (poseAllowsSpeechBubble(pose)) setSpeechAnchor("c2", characterHeadSpeechAnchor(pose, cam, sf, W, H, !!(characterFace2Ref.current && characterFace2ImageRef.current), characterFace2Ref.current?.faceAspect ?? 1, physiqueAt(time, resolved)));
      CharacterEntity.drawBoardCharacterToCanvas(
        ctx, time, resolved, showCharacter2Ref.current,
        cam, sf, W, H, charInit2XRef.current, charInit2YRef.current,
        clipsRef.current, characterEntranceTime2Ref.current, authoredAnimationsRef.current,
        characterFace2Ref.current && characterFace2ImageRef.current
          ? { image: characterFace2ImageRef.current, aspect: characterFace2Ref.current.faceAspect, mouthAnchor: characterFace2Ref.current.mouthAnchor }
          : null,
        characterSkin2Ref.current,
        { ...pose, viseme: resolvedCharacterViseme("c2", time, currentClips, resolved) },
        boardCharacterDrawEvaluators()
      );
      const active = authoredBazookaDisplayAction(time, resolved);
      if (active?.targetX !== undefined && active.targetY !== undefined) {
        const isActive=time>=active.startTime&&time<active.startTime+active.duration,progress=clamp((time-active.startTime)/active.duration,0,1),fireFraction=authoredBazookaFireFraction(active,resolved),recoilAge=time-(active.startTime+active.duration*fireFraction),recoil=isActive&&recoilAge>=0&&recoilAge<.26?Math.sin((1-recoilAge/.26)*Math.PI)*9:0,pickup=!isActive||authoredBazookaIsChained(active,resolved)?1:authoredBazookaPickupProgress(progress);
        drawBazookaHeld(ctx,{x:pose.boardX,y:pose.boardY,facing:pose.facing},{x:active.targetX,y:active.targetY},cam,sf,W,H,recoil,pickup,{bodyLean:pose.bodyLean,headBob:pose.headBob});
      }
    }
    for (const event of authoredBazooka.events) drawBazookaEffect(ctx,event,cam,sf,W,H,time*1000);
    if (currentAnnotations.length > 0) {
      drawAnnotationsToCanvas(ctx, currentAnnotations, cam, sf, W, H);
    }
    ctx.restore();
    drawNarrationSpeechBubble(ctx, time, currentClips, W, H, speechBubbleAnchor);
  }, [drawStreamGuestsToCtx]);

  const drawFrame = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    let liveCam: { cameraX: number; cameraY: number; boardZoom: number } | null = null;
    if (liveControlEnabledRef.current) {
      const live = liveCharactersRef.current[activeCharacterIdRef.current];
      const pose = live.currentPose;
      if (liveCameraModeRef.current === "scene") {
        const currentSurfaceKey = liveSurfaceKeyForPose(pose);
        const expectedSurfaceKey = liveSceneSurfaceKeyRef.current;
        const leftScene = expectedSurfaceKey ? currentSurfaceKey !== expectedSurfaceKey : currentSurfaceKey !== null;
        if (leftScene) {
          liveCameraModeRef.current = "character";
          liveSceneSurfaceKeyRef.current = null;
          liveSceneCameraRef.current = null;
          startLiveCameraTransition();
          setLiveCameraMode("character");
        }
      }
      const target = liveCameraModeRef.current === "scene" && liveSceneCameraRef.current
        ? liveSceneCameraRef.current
        : liveCharacterCameraTarget(pose);
      const transition = liveCameraTransitionRef.current;
      if (transition) {
        const rawT = clamp((performance.now() - transition.startMs) / transition.durationMs, 0, 1);
        const eased = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;
        liveCam = {
          cameraX: lerp(transition.from.cameraX, target.cameraX, eased),
          cameraY: lerp(transition.from.cameraY, target.cameraY, eased),
          boardZoom: lerp(transition.from.boardZoom, target.boardZoom, eased),
        };
        if (rawT >= 1) liveCameraTransitionRef.current = null;
      } else {
        const prev = liveCameraRef.current ?? target;
        const alpha = liveCameraModeRef.current === "scene" ? 1 : 0.14;
        liveCam = {
          cameraX: lerp(prev.cameraX, target.cameraX, alpha),
          cameraY: lerp(prev.cameraY, target.cameraY, alpha),
          boardZoom: lerp(prev.boardZoom, target.boardZoom, liveCameraModeRef.current === "scene" ? 1 : 0.12),
        };
      }
      liveCameraRef.current = liveCam;
    }
    renderToCtx(ctx, time, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current, annotationsRef.current, liveCam);
  }, [renderToCtx]);

  useEffect(() => { drawFrameRef.current = drawFrame; }, [drawFrame]);

  const drawCharacterBoardOverlay = useCallback((canvas: HTMLCanvasElement, time: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showCharacterRef.current && !showCharacter2Ref.current) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const W = canvas.width;
    const H = canvas.height;
    const sf = W / BOARD_W;
    const cam = { cameraX: BOARD_W / 2, cameraY: BOARD_H / 2, boardZoom: 1 };
    const currentClips = clipsRef.current;
    const authoredBazooka = authoredBazookaTimeline(
      time,
      [resolvedCharActionsRef.current, resolvedCharActions2Ref.current],
      currentClips,
      streamCratersRef.current,
    );
    let speechBubbleAnchor: SpeechBubbleAnchor | null = null;
    const setSpeechAnchor = (id: CharacterId, anchor: SpeechBubbleAnchor) => {
      if (!speechBubbleAnchor || activeCharacterIdRef.current === id) speechBubbleAnchor = anchor;
    };

    const drawEditorCharacter = (
      id: CharacterId,
      resolved: ResolvedCharAction[],
      enabled: boolean,
      initX: number,
      initY: number,
      faceSettings: CharacterFaceSettings | null,
      faceImage: HTMLImageElement | null,
      skin: CharacterSkin,
      viseme: Viseme,
    ) => {
      if (!enabled) return;
      const pose = evalCharAtTime(
        time, resolved, initX, initY, currentClips, authoredAnimationsRef.current,
        !!(faceSettings && faceImage), faceSettings?.faceAspect ?? 1, authoredBazooka.craters,
      );
      if (poseAllowsSpeechBubble(pose)) setSpeechAnchor(id, characterHeadSpeechAnchor(pose, cam, sf, W, H, !!(faceSettings && faceImage), faceSettings?.faceAspect ?? 1, physiqueAt(time, resolved)));
      CharacterEntity.drawBoardCharacterToCanvas(
        ctx, time, resolved, true, cam, sf, W, H, initX, initY,
        currentClips, -Infinity, authoredAnimationsRef.current,
        faceSettings && faceImage ? { image: faceImage, aspect: faceSettings.faceAspect, mouthAnchor: faceSettings.mouthAnchor } : null,
        skin, { ...pose, viseme },
        boardCharacterDrawEvaluators(),
      );
      const active = authoredBazookaDisplayAction(time, resolved);
      if (active?.targetX === undefined || active.targetY === undefined) return;
      const isActive = time >= active.startTime && time < active.startTime + active.duration;
      const progress = clamp((time - active.startTime) / active.duration, 0, 1);
      const fireFraction = authoredBazookaFireFraction(active, resolved);
      const recoilAge = time - (active.startTime + active.duration * fireFraction);
      const recoil = isActive && recoilAge >= 0 && recoilAge < 0.26 ? Math.sin((1 - recoilAge / 0.26) * Math.PI) * 9 : 0;
      const pickup = !isActive || authoredBazookaIsChained(active, resolved) ? 1 : authoredBazookaPickupProgress(progress);
      drawBazookaHeld(
        ctx,
        { x: pose.boardX, y: pose.boardY, facing: pose.facing },
        { x: active.targetX, y: active.targetY },
        cam, sf, W, H, recoil, pickup,
        { bodyLean: pose.bodyLean, headBob: pose.headBob },
      );
    };

    drawEditorCharacter(
      "c1",
      resolvedCharActionsRef.current, showCharacterRef.current, charInitXRef.current, charInitYRef.current,
      characterFaceRef.current, characterFaceImageRef.current, characterSkinRef.current, resolvedCharacterViseme("c1", time, currentClips, resolvedCharActionsRef.current),
    );
    drawEditorCharacter(
      "c2",
      resolvedCharActions2Ref.current, showCharacter2Ref.current, charInit2XRef.current, charInit2YRef.current,
      characterFace2Ref.current, characterFace2ImageRef.current, characterSkin2Ref.current, resolvedCharacterViseme("c2", time, currentClips, resolvedCharActions2Ref.current),
    );
    for (const event of authoredBazooka.events) drawBazookaEffect(ctx, event, cam, sf, W, H, time * 1000);
    drawNarrationSpeechBubble(ctx, time, currentClips, W, H, speechBubbleAnchor);
  }, []);

  const drawBoardImageOverlays = useCallback((time: number) => {
    const currentClips = clipsRef.current;
    const authoredBazooka = authoredBazookaTimeline(
      time,
      [resolvedCharActionsRef.current, resolvedCharActions2Ref.current],
      currentClips,
      streamCratersRef.current,
    );
    const shake = bazookaShake(authoredBazooka.events, time * 1000);
    for (const clip of currentClips) {
      if (clip.type !== "image" || clip.boardX === undefined || clip.boardW === undefined || clip.boardH === undefined) continue;
      const image = imgCacheRef.current.get(clip.sourceUrl);
      for (const refs of [boardImageCanvasRefs.current, mobileBoardImageCanvasRefs.current]) {
        const canvas = refs.get(clip.id);
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.transform = `translate(${shake.x}px, ${shake.y}px)`;
        if (image?.complete && image.naturalWidth > 0) {
          drawCrateredImage(
            ctx, image, 0, 0, canvas.width, canvas.height, clip.boardW, clip.boardH,
            authoredBazooka.craters.filter((crater) => crater.clipId === clip.id),
          );
        }
      }
    }
  }, []);

  useEffect(() => { drawBoardImageOverlaysRef.current = drawBoardImageOverlays; }, [drawBoardImageOverlays]);

  useEffect(() => {
    for (const canvas of [boardCharacterCanvasRef.current, mobileBoardCharacterCanvasRef.current]) {
      if (canvas) drawCharacterBoardOverlay(canvas, playhead);
    }
    drawBoardImageOverlays(playhead);
  }, [clips, drawBoardImageOverlays, drawCharacterBoardOverlay, playhead, resolvedCharActions, resolvedCharActions2, showCharacter, showCharacter2, characterFace, characterFace2, characterSkin, characterSkin2]);

  // ─ Video audio routing ────────────────────────────────────────────────────

  // Lazily wires a video element into the Web Audio graph if it doesn't have nodes yet
  // (covers clips added while already playing, e.g. a background download completing mid-playback).
  function ensureVideoAudioNodes(clipId: string, vid: HTMLVideoElement) {
    if (videoAudioNodesRef.current.has(clipId)) return;
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
    try {
      const sourceNode = ctx.createMediaElementSource(vid);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      sourceNode.connect(gainNode);
      gainNode.connect(ctx.destination);
      videoAudioNodesRef.current.set(clipId, { sourceNode, gainNode });
    } catch {}
  }

  // Applies clip.volume/muted to whichever audio path is live for this clip: the Web Audio
  // gain node if one exists, otherwise the video element's native volume/muted as a fallback
  // (e.g. createMediaElementSource threw).
  function effectiveClipVolume(clip: Clip): number {
    if (clip.muted) return 0;
    if (clip.type === "video" && mutedLayersRef.current[clip.layer ?? 1]) return 0;
    return clip.volume ?? 1;
  }

  function currentPlaybackDuration(currentClips: Clip[]): number {
    if (cameraKeyframeModeRef.current === "character" && characterDurationRef.current > 0) {
      return characterDurationRef.current;
    }
    return currentClips.reduce((acc, clip) => Math.max(acc, clip.startTime + clip.duration), 0);
  }

  function activeVideoWindow(clip: Clip, time: number): { start: number; end: number } | undefined {
    if (cameraKeyframeModeRef.current === "character") {
      return occupancyWindowAt(occupancyWindowsRef.current, clip.id, time);
    }
    return time >= clip.startTime && time < clip.startTime + clip.duration
      ? { start: clip.startTime, end: clip.startTime + clip.duration }
      : undefined;
  }

  function toggleLayerMute(layer: number) {
    const next = { ...mutedLayersRef.current, [layer]: !mutedLayersRef.current[layer] };
    mutedLayersRef.current = next;
    setMutedLayers(next);
    for (const clip of clipsRef.current) {
      if (clip.type !== "video" || (clip.layer ?? 1) !== layer) continue;
      const vid = videoElsRef.current.get(clip.id);
      if (vid) updateVideoVolume(clip, vid);
    }
  }

  function updateVideoVolume(clip: Clip, vid: HTMLVideoElement) {
    const effectiveVolume = effectiveClipVolume(clip);
    const nodes = videoAudioNodesRef.current.get(clip.id);
    if (nodes) {
      nodes.gainNode.gain.value = effectiveVolume;
    } else {
      vid.muted = false;
      vid.volume = effectiveVolume;
    }
  }

  function setVideoGain(clipId: string, vid: HTMLVideoElement, gain: number) {
    const nodes = videoAudioNodesRef.current.get(clipId);
    if (nodes) {
      nodes.gainNode.gain.value = gain;
    } else {
      vid.muted = false;
      vid.volume = gain;
    }
  }

  // Pure play/pause mechanics shared by the preview RAF loop, togglePlay, and the export loop
  // so entry/exit behavior can't silently diverge between them. These never touch audio —
  // export schedules its own audio separately and must not un-silence the preview gain nodes.
  function restartAndPlay(vid: HTMLVideoElement, offsetSec: number) {
    vid.currentTime = Math.max(0, offsetSec);
    vid.play().catch(() => {});
  }
  function pauseAndReset(vid: HTMLVideoElement) {
    vid.pause();
    vid.currentTime = 0;
  }

  // Silences a clip's audio path (gain node if it exists, else native volume fallback) — the "off" state
  // shared by switchVideoOff and pre-warming.
  function setClipAudioOff(clipId: string, vid: HTMLVideoElement) {
    setVideoGain(clipId, vid, 0);
  }

  // Switch OFF: exit from a clip's active range, for the live preview.
  function switchVideoOff(clip: Clip, vid: HTMLVideoElement) {
    setClipAudioOff(clip.id, vid);
    pauseAndReset(vid);
  }

  function videoRuntimeFor(clipId: string): VideoPlaybackRuntime {
    let runtime = videoPlaybackStateRef.current.get(clipId);
    if (!runtime) {
      runtime = { state: "dormant", lastInViewportAt: 0, lastTransitionLogAt: 0, lastRestartAt: 0, reason: "init" };
      videoPlaybackStateRef.current.set(clipId, runtime);
    }
    return runtime;
  }

  function logVideoStateTransition(clipId: string, runtime: VideoPlaybackRuntime, state: VideoPlaybackMode, reason: string, now: number) {
    if (runtime.state === state && runtime.reason === reason) return;
    if (runtime.state !== state && now - runtime.lastTransitionLogAt > 250) {
      console.log(`[ambient] clip ${clipId} ${state} (${reason})`);
      runtime.lastTransitionLogAt = now;
    }
    runtime.state = state;
    runtime.reason = reason;
  }

  function videoViewportInfo(
    clip: Clip,
    cam: { cameraX: number; cameraY: number; boardZoom: number },
    W: number,
    H: number,
    now: number
  ): { candidate: boolean; distance: number; reason: string } {
    if (clip.boardX === undefined || clip.boardY === undefined || clip.boardW === undefined || clip.boardH === undefined) {
      return { candidate: false, distance: Number.POSITIVE_INFINITY, reason: "no-board-rect" };
    }
    const vp = cameraViewport(cam, W, H);
    const mx = vp.width * AMBIENT_VIEWPORT_EXPAND;
    const my = vp.height * AMBIENT_VIEWPORT_EXPAND;
    const left = vp.left - mx;
    const right = vp.right + mx;
    const top = vp.top - my;
    const bottom = vp.bottom + my;
    const clipLeft = clip.boardX;
    const clipRight = clip.boardX + clip.boardW;
    const clipTop = clip.boardY;
    const clipBottom = clip.boardY + clip.boardH;
    const intersects = clipRight >= left && clipLeft <= right && clipBottom >= top && clipTop <= bottom;
    const runtime = videoRuntimeFor(clip.id);
    if (intersects) runtime.lastInViewportAt = now;
    const withinHysteresis = runtime.state === "ambient" && now - runtime.lastInViewportAt <= AMBIENT_DORMANT_HYSTERESIS_MS;
    const cx = clip.boardX + clip.boardW / 2;
    const cy = clip.boardY + clip.boardH / 2;
    const distance = Math.hypot(cx - (vp.left + vp.width / 2), cy - (vp.top + vp.height / 2));
    if (intersects) return { candidate: true, distance, reason: "in-expanded-viewport" };
    if (withinHysteresis) return { candidate: true, distance, reason: "hysteresis" };
    return { candidate: false, distance, reason: "off-viewport" };
  }

  function evaluateVideoPlaybackStates(
    time: number,
    currentClips: Clip[],
    currentCameraKeyframes: CameraKeyframe[],
    W: number,
    H: number,
    options: { force?: boolean; audioMode?: "preview" | "silent"; overrideCamera?: { cameraX: number; cameraY: number; boardZoom: number } | null } = {}
  ) {
    // eslint-disable-next-line react-hooks/purity
    const now = performance.now();
    const videoClips = currentClips.filter((clip) => clip.type === "video");
    const activeWindows = new Map(
      videoClips
        .map((clip) => [clip.id, activeVideoWindow(clip, time)] as const)
        .filter((entry): entry is readonly [string, { start: number; end: number }] => !!entry[1])
    );
    const activeIds = new Set(activeWindows.keys());

    if (options.force || now - lastAmbientEvalAtRef.current >= AMBIENT_STATE_EVAL_INTERVAL_MS) {
      lastAmbientEvalAtRef.current = now;
      if (!ambientVideoEnabledRef.current) {
        ambientCandidateIdsRef.current = new Set();
      } else {
        const cam = options.overrideCamera ?? interpolateCameraKeyframes(currentCameraKeyframes, time);
        const ambientSlots = Math.max(0, AMBIENT_BUDGET - activeIds.size);
        const candidates = videoClips
          .filter((clip) => !activeIds.has(clip.id))
          .map((clip) => ({ clip, ...videoViewportInfo(clip, cam, W, H, now) }))
          .filter((item) => item.candidate)
          .sort((a, b) => {
            const dist = a.distance - b.distance;
            if (Math.abs(dist) > 0.001) return dist;
            const aUpcoming = a.clip.startTime >= time ? a.clip.startTime - time : Number.MAX_SAFE_INTEGER + a.clip.startTime;
            const bUpcoming = b.clip.startTime >= time ? b.clip.startTime - time : Number.MAX_SAFE_INTEGER + b.clip.startTime;
            return aUpcoming - bUpcoming;
          });
        ambientCandidateIdsRef.current = new Set(candidates.slice(0, ambientSlots).map((item) => item.clip.id));
      }
    }

    let activeCount = 0;
    let ambientCount = 0;
    let dormantCount = 0;
    const liveClipIds = new Set(videoClips.map((clip) => clip.id));

    for (const staleId of [...videoPlaybackStateRef.current.keys()]) {
      if (!liveClipIds.has(staleId)) videoPlaybackStateRef.current.delete(staleId);
    }

    for (const clip of videoClips) {
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      ensureVideoAudioNodes(clip.id, vid);
      const runtime = videoRuntimeFor(clip.id);
      const isActive = activeIds.has(clip.id);
      const isAmbient = !isActive && ambientVideoEnabledRef.current && ambientCandidateIdsRef.current.has(clip.id);
      const desired: VideoPlaybackMode = isActive ? "active" : isAmbient ? "ambient" : "dormant";
      const reason = isActive
        ? cameraKeyframeModeRef.current === "character" ? "character-occupancy-active" : "timeline-active"
        : !ambientVideoEnabledRef.current
          ? "ambient-disabled"
          : isAmbient
            ? "viewport-budget"
            : "off-viewport-or-over-budget";
      const previousState = runtime.state;

      logVideoStateTransition(clip.id, runtime, desired, reason, now);

      if (desired === "active") {
        activeCount++;
        vid.loop = false;
        const expected = Math.max(0, time - activeWindows.get(clip.id)!.start);
        if (previousState !== "active" || vid.paused || vid.ended) {
          restartAndPlay(vid, expected);
          runtime.lastRestartAt = now;
          console.log("[video] clip", clip.id, "entered — restart + play");
        } else if (Math.abs(vid.currentTime - expected) > 0.3) {
          vid.currentTime = expected;
        }
        if (options.audioMode === "silent") setClipAudioOff(clip.id, vid); else updateVideoVolume(clip, vid);
        videoRangeStateRef.current.set(clip.id, true);
      } else if (desired === "ambient") {
        ambientCount++;
        vid.loop = true;
        setClipAudioOff(clip.id, vid);
        if (vid.paused || vid.ended) {
          if (vid.ended) vid.currentTime = 0;
          vid.play().catch(() => {});
        }
        videoRangeStateRef.current.set(clip.id, false);
      } else {
        dormantCount++;
        if (!vid.paused || vid.currentTime !== 0) switchVideoOff(clip, vid);
        vid.loop = false;
        videoRangeStateRef.current.set(clip.id, false);
      }
    }

    if ((isPlayingRef.current || isExportingRef.current) && now - lastAmbientCensusAtRef.current >= AMBIENT_CENSUS_INTERVAL_MS) {
      console.log(`[ambient] census active ${activeCount} / ambient ${ambientCount} / dormant ${dormantCount} / drawable-failures ${drawableFailureCountRef.current}`);
      drawableFailureCountRef.current = 0;
      lastAmbientCensusAtRef.current = now;
    }
  }

  useEffect(() => {
    evaluateVideoPlaybackStatesRef.current = evaluateVideoPlaybackStates;
  });

  // Warms up a freshly created video element's decoder with a silent play()→pause() cycle so
  // its first "real" entry (restart-on-entry, Step 16.10) already has a decoded frame ready to
  // draw — otherwise the first playthrough plays audio while the canvas still shows the frozen
  // thumbnail until the decoder catches up. Runs once, as soon as the element can play.
  function prewarmVideoElement(clipId: string, vid: HTMLVideoElement) {
    vid.addEventListener("canplay", () => {
      // If the clip has already had a real entry by the time canplay fires (e.g. pasted
      // directly onto the currently-playing position), don't interfere — pausing/silencing it
      // here would kill playback that's already legitimately underway.
      if (videoRangeStateRef.current.get(clipId)) return;
      ensureVideoAudioNodes(clipId, vid);
      setClipAudioOff(clipId, vid); // keep the warm-up silent
      vid.play().then(() => {
        if (videoRangeStateRef.current.get(clipId)) return; // became active while warming up
        pauseAndReset(vid);
        console.log("[video] pre-warmed clip", clipId);
      }).catch((err) => {
        if (videoRangeStateRef.current.get(clipId)) return;
        pauseAndReset(vid);
        console.warn("[video] pre-warm failed for clip", clipId, err); // not fatal — will still try on entry
      });
    }, { once: true });
  }

  // ─ RAF playback loop ──────────────────────────────────────────────────────

  const rafLoop = useCallback(() => {
    if (!isPlayingRef.current) return;
    // eslint-disable-next-line react-hooks/purity
    const now = performance.now();
    const prevT = prevPlayheadRef.current;
    if (lastRafTimeRef.current !== null) {
      const dt = (now - lastRafTimeRef.current) / 1000;
      const next = playheadRef.current + dt;
      const maxEnd = currentPlaybackDuration(clipsRef.current);
      if (next >= maxEnd) {
        playheadRef.current = maxEnd; setPlayhead(maxEnd); setIsPlaying(false);
        isPlayingRef.current = false;
        // Switch off any clip still active or ambient — timeline ended mid-clip
        for (const clip of clipsRef.current) {
          if (clip.type !== "video") continue;
          const vid = videoElsRef.current.get(clip.id);
          if (!vid) continue;
          switchVideoOff(clip, vid);
          videoRangeStateRef.current.set(clip.id, false);
          const runtime = videoRuntimeFor(clip.id);
          runtime.state = "dormant";
          runtime.reason = "playback-ended";
        }
        for (const clipId of [...activeNarrationRef.current.keys()]) {
          const entry = activeNarrationRef.current.get(clipId);
          if (entry) { try { entry.bufNode.stop(); } catch {} try { entry.bufNode.disconnect(); } catch {} try { entry.gainNode.disconnect(); } catch {} }
        }
        activeNarrationRef.current.clear();
        prevPlayheadRef.current = maxEnd;
        drawFrame(maxEnd); return;
      }
      playheadRef.current = next; setPlayhead(next);
    }
    lastRafTimeRef.current = now;
    const t = playheadRef.current;
    prevPlayheadRef.current = t;
    evaluateVideoPlaybackStates(t, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current);
    // Narration audio: spawn on entry, stop on exit
    for (const clip of clipsRef.current) {
      if (clip.type !== "narration") continue;
      const isActive = t >= clip.startTime && t < clip.startTime + clip.duration;
      const wasActive = prevT >= clip.startTime && prevT < clip.startTime + clip.duration;
      if (isActive && !wasActive && !activeNarrationRef.current.has(clip.id)) {
        const clipId = clip.id;
        const blobUrl = clip.sourceUrl;
        const clipOffset = t - clip.startTime;
        let ctx = audioCtxRef.current;
        if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
        const audioCtxCapture = ctx;
        fetch(blobUrl)
          .then((r) => r.arrayBuffer())
          .then((ab) => audioCtxCapture.decodeAudioData(ab))
          .then((buffer) => {
            if (!isPlayingRef.current || activeNarrationRef.current.has(clipId)) return;
            const gainNode = audioCtxCapture.createGain();
            gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
            gainNode.connect(audioCtxCapture.destination);
            const bufNode = audioCtxCapture.createBufferSource();
            bufNode.buffer = buffer;
            bufNode.connect(gainNode);
            bufNode.start(0, Math.min(Math.max(0, (clip.sourceOffsetSec ?? 0) + clipOffset), Math.max(0, buffer.duration - 0.01)));
            bufNode.onended = () => activeNarrationRef.current.delete(clipId);
            activeNarrationRef.current.set(clipId, { bufNode, gainNode });
          })
          .catch(() => {});
      } else if (!isActive && wasActive) {
        const entry = activeNarrationRef.current.get(clip.id);
        if (entry) {
          try { entry.bufNode.stop(); } catch {}
          try { entry.bufNode.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
          activeNarrationRef.current.delete(clip.id);
        }
      }
    }
    drawFrame(t);
    rafIdRef.current = requestAnimationFrame(rafCallbackRef.current);
  }, [drawFrame]);

  useEffect(() => { rafCallbackRef.current = rafLoop; }, [rafLoop]);

  useEffect(() => {
    if (isPlaying) {
      lastRafTimeRef.current = null;
      rafIdRef.current = requestAnimationFrame(rafLoop);
      // Spawn narration audio for any clips already active at the current playhead
      const t = playheadRef.current;
      for (const clip of clipsRef.current) {
        if (clip.type !== "narration") continue;
        if (t < clip.startTime || t >= clip.startTime + clip.duration) continue;
        if (activeNarrationRef.current.has(clip.id)) continue;
        const clipId = clip.id;
        const blobUrl = clip.sourceUrl;
        const clipOffset = t - clip.startTime;
        let ctx = audioCtxRef.current;
        if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
        const audioCtxCapture = ctx;
        fetch(blobUrl)
          .then((r) => r.arrayBuffer())
          .then((ab) => audioCtxCapture.decodeAudioData(ab))
          .then((buffer) => {
            if (!isPlayingRef.current || activeNarrationRef.current.has(clipId)) return;
            const gainNode = audioCtxCapture.createGain();
            gainNode.gain.value = clip.muted ? 0 : (clip.volume ?? 1);
            gainNode.connect(audioCtxCapture.destination);
            const bufNode = audioCtxCapture.createBufferSource();
            bufNode.buffer = buffer;
            bufNode.connect(gainNode);
            bufNode.start(0, Math.min(Math.max(0, (clip.sourceOffsetSec ?? 0) + clipOffset), Math.max(0, buffer.duration - 0.01)));
            bufNode.onended = () => activeNarrationRef.current.delete(clipId);
            activeNarrationRef.current.set(clipId, { bufNode, gainNode });
          })
          .catch(() => {});
      }
    } else {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null;
      // Switch off every clip's video (paused clips render their frozen thumbnail)
      for (const nodes of videoAudioNodesRef.current.values()) { try { nodes.gainNode.gain.value = 0; } catch {} }
      for (const clip of clipsRef.current) {
        if (clip.type !== "video") continue;
        const vid = videoElsRef.current.get(clip.id);
        if (!vid) continue;
        switchVideoOff(clip, vid);
        const runtime = videoRuntimeFor(clip.id);
        runtime.state = "dormant";
        runtime.reason = "playback-paused";
        videoRangeStateRef.current.set(clip.id, false);
      }
      ambientCandidateIdsRef.current = new Set();
      // Stop all active narration audio
      for (const clipId of [...activeNarrationRef.current.keys()]) {
        const entry = activeNarrationRef.current.get(clipId);
        if (entry) {
          try { entry.bufNode.stop(); } catch {}
          try { entry.bufNode.disconnect(); } catch {}
          try { entry.gainNode.disconnect(); } catch {}
        }
      }
      activeNarrationRef.current.clear();
    }
    return () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
  }, [isPlaying, rafLoop]);

  useEffect(() => { if (!isPlaying) drawFrame(playhead); }, [playhead, clips, annotations, canvasAspect, isPlaying, drawFrame]);

  // ─ Media loading ──────────────────────────────────────────────────────────

  function loadMedia(url: string, type: "image" | "video") {
    if (type === "image") {
      if (!imgCacheRef.current.has(url)) {
        const img = new Image();
        img.onload = () => {
          drawFrame(playheadRef.current);
          drawBoardImageOverlaysRef.current(playheadRef.current);
        };
        img.src = url;
        imgCacheRef.current.set(url, img);
      }
    }
    // Video: per-clip elements are created by createVideoElement instead
  }

  async function captureVideoThumbnail(clipId: string, srcUrl: string): Promise<void> {
    if (thumbnailImagesRef.current.has(clipId)) return; // already captured or pre-set (pasted clip)
    try {
      // Use a SEPARATE temp element so we never seek the live per-clip playback element
      const tmpVid = document.createElement("video");
      tmpVid.preload = "auto";
      tmpVid.muted = true;
      tmpVid.crossOrigin = "anonymous";
      tmpVid.src = srcUrl;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 8000);
        tmpVid.addEventListener("canplay", () => { clearTimeout(timer); resolve(); }, { once: true });
        tmpVid.addEventListener("error", () => { clearTimeout(timer); reject(tmpVid.error); }, { once: true });
      });
      const seekTime = isFinite(tmpVid.duration) && tmpVid.duration < 1 ? 0 : 0.1;
      tmpVid.currentTime = seekTime;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("seeked timeout")), 5000);
        tmpVid.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      const w = tmpVid.videoWidth || 640;
      const h = tmpVid.videoHeight || 360;
      // Register natural dimensions for this URL if not yet known
      if (w > 0 && !videoDimsRef.current.has(srcUrl)) {
        const scale = Math.min(1, 800 / w, 600 / h);
        videoDimsRef.current.set(srcUrl, { w: Math.round(w * scale), h: Math.round(h * scale) });
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) throw new Error("no 2d ctx");
      ctx2d.drawImage(tmpVid, 0, 0, w, h);
      tmpVid.src = ""; // release temp element
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("toBlob failed");
      const thumbUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.src = thumbUrl;
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); });
      thumbnailImagesRef.current.set(clipId, img);
      setClips((prev) => prev.map((c) => c.id === clipId ? { ...c, thumbnailBlobUrl: thumbUrl } : c));
    } catch {
      thumbnailImagesRef.current.set(clipId, null); // mark failed — renders black box fallback
    }
  }

  // Creates a dedicated video element per clip.id — one element per clipId, never shared
  // Creates a dedicated <video> element for this clip.id. Duplicates (paste/drag from library)
  // get their own independent element sharing the same src — never a shared/cached element.
  // Stays switched OFF (paused) until the RAF loop or togglePlay switches it on for entry.
  function createVideoElement(clipId: string, url: string): HTMLVideoElement {
    const existing = videoElsRef.current.get(clipId);
    if (existing) return existing;
    const vid = document.createElement("video");
    vid.muted = false;
    vid.loop = false;
    vid.preload = "auto";
    vid.playsInline = true;
    vid.crossOrigin = "anonymous"; // must be set before src so the request is made with CORS mode
    vid.src = url;
    vid.style.position = "absolute";
    vid.style.left = "-9999px";
    vid.style.top = "-9999px";
    vid.onloadeddata = () => drawFrame(playheadRef.current);
    vid.addEventListener("loadedmetadata", () => {
      if (vid.videoWidth > 0 && !videoDimsRef.current.has(url)) {
        const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
        videoDimsRef.current.set(url, { w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale) });
      }
    }, { once: true });
    videoHiddenContainerRef.current?.appendChild(vid);
    videoElsRef.current.set(clipId, vid);
    videoRangeStateRef.current.set(clipId, false);
    videoStuckFrameCountRef.current.set(clipId, 0);
    videoPlaybackStateRef.current.set(clipId, { state: "dormant", lastInViewportAt: 0, lastTransitionLogAt: 0, lastRestartAt: 0, reason: "created" });
    // Warm the decoder now (silent play→pause) so the element's first real entry has a
    // drawable frame ready instead of showing the thumbnail while its audio already plays.
    // Also covers autoplay unlock for elements created after the session's first Play click
    // (e.g. a background YouTube download finishing mid-session).
    prewarmVideoElement(clipId, vid);
    captureVideoThumbnail(clipId, url); // fire-and-forget; uses a separate temp element, never seeks vid
    return vid;
  }

  function getVisibleBoardCenter(): { camX: number; camY: number } {
    const container = boardContainerRef.current;
    if (!container) return { camX: BOARD_W / 2, camY: BOARD_H / 2 };
    const { width, height } = container.getBoundingClientRect();
    const zoom = boardZoomRef.current;
    const pan = boardPanRef.current;
    return {
      camX: clamp((width / 2 - pan.x) / zoom, 0, BOARD_W),
      camY: clamp((height / 2 - pan.y) / zoom, 0, BOARD_H),
    };
  }

  function getMediaDimensions(url: string, type: "image" | "video"): { w: number; h: number } {
    if (type === "image") {
      const img = imgCacheRef.current.get(url);
      if (img && img.naturalWidth > 0) {
        const scale = Math.min(1, 800 / img.naturalWidth, 600 / img.naturalHeight);
        return { w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale) };
      }
    } else {
      const dims = videoDimsRef.current.get(url);
      if (dims) return dims;
      return { w: 800, h: 450 };
    }
    return { w: 800, h: 600 };
  }

  function findBoardPosForNewMedia(
    existing: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }>,
    clipW: number,
    clipH: number
  ): { boardX: number; boardY: number } {
    const state = playModeRef.current ? playPhysicsRef.current : null;
    if (state) {
      return findFreeBoardPosNearHost(existing, clipW, clipH, state.x, state.y, state.facing);
    }
    const { camX, camY } = getVisibleBoardCenter();
    return findFreeBoardPos(existing, clipW, clipH, camX, camY);
  }

  async function addClipAndPlaceOnBoard(item: MediaItem) {
    // Wait for image to load so we get natural dimensions
    if (item.type === "image") {
      const img = imgCacheRef.current.get(item.url);
      if (img && !img.complete) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        });
      }
    }
    const { w, h } = getMediaDimensions(item.url, item.type);
    const clipId = generateId();
    const clipDuration = item.duration ?? (item.type === "video" ? 5 : 4);
    if (item.type === "video") createVideoElement(clipId, item.url);
    setClips((prev) => {
      const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
      const layer = freeLayerAtTime(prev, endTime, clipDuration, clipId, 1);
      const pos = findBoardPosForNewMedia(prev, w, h);
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime: endTime, duration: clipDuration, layer,
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          sourceDurationSec: item.type === "video" ? item.duration : undefined,
          sourceBlob: item.type === "video" ? item.blob : undefined,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  function deleteClip(clipId: string) {
    const vid = videoElsRef.current.get(clipId);
    if (vid) {
      vid.pause(); vid.src = "";
      if (videoHiddenContainerRef.current?.contains(vid)) videoHiddenContainerRef.current.removeChild(vid);
      videoElsRef.current.delete(clipId);
    }
    videoRangeStateRef.current.delete(clipId);
    videoStuckFrameCountRef.current.delete(clipId);
    videoPlaybackStateRef.current.delete(clipId);
    ambientCandidateIdsRef.current.delete(clipId);
    const audioNodes = videoAudioNodesRef.current.get(clipId);
    if (audioNodes) {
      try { audioNodes.gainNode.gain.value = 0; audioNodes.sourceNode.disconnect(); audioNodes.gainNode.disconnect(); } catch {}
      videoAudioNodesRef.current.delete(clipId);
    }
    const clip = clipsRef.current.find((c) => c.id === clipId);
    // Every video clip now owns an independent blob (Step 16.12) — the only exception is a
    // clip still using the original upload's URL, which the media library needs to keep alive
    // so the same file can be dragged onto the board again later.
    if (clip?.type === "video" && clip.sourceUrl) {
      const stillInLibrary = mediaLibrary.some((m) => m.url === clip.sourceUrl);
      if (!stillInLibrary) URL.revokeObjectURL(clip.sourceUrl);
    }
    // Revoke thumbnail blob only if no other clip shares the same thumbnailBlobUrl
    if (clip?.thumbnailBlobUrl) {
      const thumbRefs = clipsRef.current.filter((c) => c.id !== clipId && c.thumbnailBlobUrl === clip.thumbnailBlobUrl);
      if (thumbRefs.length === 0) URL.revokeObjectURL(clip.thumbnailBlobUrl);
    }
    thumbnailImagesRef.current.delete(clipId);
    if (clip?.type === "narration") {
      stopNarrationAudio(clipId);
      URL.revokeObjectURL(clip.sourceUrl);
      setCharacterActions((prev) => prev.filter((action) => action.narrationGestureClipId !== clipId));
      setCharacterActions2((prev) => prev.filter((action) => action.narrationGestureClipId !== clipId));
    }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setSelectedClipIds((prev) => prev.filter((id) => id !== clipId));
    selectedClipIdsRef.current = selectedClipIdsRef.current.filter((id) => id !== clipId);
    setSelectedClipId((prev) => (prev === clipId ? null : prev));
  }

  function addPanClip(atTime?: number) {
    const id = generateId();
    const startTime = atTime ?? clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const clip: Clip = { id, type: "pan", name: "Pan", sourceUrl: "", startTime, duration: 5, holdFraction: 0.5, layer: 1 };
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(id);
    if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
  }

  function addCharacterZoomClip(atTime?: number) {
    const id = generateId();
    const startTime = atTime ?? clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const clip: Clip = { id, type: "characterZoom", name: "Character Zoom", sourceUrl: "", startTime, duration: 3, holdFraction: 0.65, layer: 1 };
    setClips((prev) => [...prev, clip]);
    setSelectedClipId(id);
    if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
  }

  // A custom zoom clip carries no media of its own — boardX/Y/W/H mark a hand-drawn region of
  // the board, and it flows through the same generic boardX-based camera-stop math (see
  // generateCameraKeyframes) that real image/video clips use, so it zooms in at the correct
  // aspect ratio without any special-casing there.
  function addCustomZoomClip(boardX: number, boardY: number, boardW: number, boardH: number, atTime?: number) {
    const id = generateId();
    const startTime = atTime ?? clipsRef.current.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
    const clip: Clip = {
      id, type: "customZoom", name: "Custom Zoom", sourceUrl: "",
      startTime, duration: 3, holdFraction: 0.65, layer: 1,
      boardX: Math.round(boardX), boardY: Math.round(boardY),
      boardW: Math.max(10, Math.round(boardW)), boardH: Math.max(10, Math.round(boardH)),
    };
    setClips((prev) => [...prev, clip]);
    setClipSelection([id]);
    if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
  }

  function openFaceCropFromSource(url: string, name: string) {
    setFaceCropSource({ url, name });
    setFaceCrop({ x: 0.25, y: 0.12, w: 0.5, h: 0.68 });
    setFaceMouthAnchor(DEFAULT_MOUTH_ANCHOR);
    setFacePickerOpen(false);
  }

  function handleFaceUpload(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setToast("Choose an image for the face");
      return;
    }
    openFaceCropFromSource(URL.createObjectURL(file), file.name || "Uploaded face");
  }

  function clampFaceCrop(next: typeof faceCrop): typeof faceCrop {
    const minW = 0.08;
    const minH = 0.08;
    const w = clamp(next.w, minW, 1);
    const h = clamp(next.h, minH, 1);
    return {
      x: clamp(next.x, 0, 1 - w),
      y: clamp(next.y, 0, 1 - h),
      w,
      h,
    };
  }

  function handleFaceCropPointerDown(e: React.PointerEvent, mode: "move" | "resize", corner?: FaceCropCorner) {
    e.preventDefault();
    e.stopPropagation();
    const measurementEl = mode === "resize"
      ? (e.currentTarget.parentElement?.parentElement as HTMLElement | null)
      : (e.currentTarget.parentElement as HTMLElement | null);
    const rect = measurementEl?.getBoundingClientRect();
    if (!rect) return;
    faceCropDragRef.current = { mode, corner, startX: e.clientX, startY: e.clientY, orig: faceCrop, rectW: rect.width || 1, rectH: rect.height || 1 };
    const onMove = (ev: PointerEvent) => {
      const drag = faceCropDragRef.current;
      if (!drag) return;
      const dx = (ev.clientX - drag.startX) / drag.rectW;
      const dy = (ev.clientY - drag.startY) / drag.rectH;
      if (drag.mode === "move") {
        setFaceCrop(clampFaceCrop({ ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy }));
        return;
      }
      let { x, y, w, h } = drag.orig;
      if (drag.corner?.includes("e")) w = drag.orig.w + dx;
      if (drag.corner?.includes("s")) h = drag.orig.h + dy;
      if (drag.corner?.includes("w")) { x = drag.orig.x + dx; w = drag.orig.w - dx; }
      if (drag.corner?.includes("n")) { y = drag.orig.y + dy; h = drag.orig.h - dy; }
      setFaceCrop(clampFaceCrop({ x, y, w, h }));
    };
    const onUp = () => {
      faceCropDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function handleMouthAnchorPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!rect) return;
    const anchorFromEvent = (ev: PointerEvent | React.PointerEvent): HeadLocalPoint => ({
      x: clamp(((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -0.8, 0.8),
      y: clamp(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1, -0.15, 0.85),
    });
    setFaceMouthAnchor(anchorFromEvent(e));
    faceMouthAnchorDragRef.current = { startX: e.clientX, startY: e.clientY, orig: faceMouthAnchor, rectW: rect.width || 1, rectH: rect.height || 1 };
    const onMove = (ev: PointerEvent) => setFaceMouthAnchor(anchorFromEvent(ev));
    const onUp = () => {
      faceMouthAnchorDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  async function confirmFaceCrop() {
    if (!faceCropSource) return;
    try {
      const { blob, aspect } = await bakeFaceCropImage(faceCropSource.url, faceCrop);
      const faceBlobUrl = URL.createObjectURL(blob);
      const activeFace = activeCharacterIdRef.current === "c2" ? characterFace2Ref.current : characterFaceRef.current;
      if (activeFace?.faceBlobUrl?.startsWith("blob:")) URL.revokeObjectURL(activeFace.faceBlobUrl);
      if (activeCharacterIdRef.current === "c2") setCharacterFace2({ faceBlobUrl, faceAspect: aspect, mouthAnchor: faceMouthAnchor });
      else setCharacterFace({ faceBlobUrl, faceAspect: aspect, mouthAnchor: faceMouthAnchor });
      setFaceCropSource(null);
      setToast("Face added");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Could not add face");
    }
  }

  function removeCharacterFace() {
    const activeFace = activeCharacterIdRef.current === "c2" ? characterFace2Ref.current : characterFaceRef.current;
    if (activeFace?.faceBlobUrl?.startsWith("blob:")) URL.revokeObjectURL(activeFace.faceBlobUrl);
    if (activeCharacterIdRef.current === "c2") setCharacterFace2(null);
    else setCharacterFace(null);
    setToast("Face removed");
  }

  function copyClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip) return;
    clipboardRef.current = { ...clip };
    setClipboardReady(true);
  }

  // Clones the underlying video bytes into a brand-new, independent Blob (+ object URL) so a
  // duplicate's <video> element gets its own genuinely separate source instead of sharing one
  // blob URL with the original — Chrome only renders live frames for the most recently active
  // of several elements pointed at the same blob URL, which showed as duplicates freezing on
  // their thumbnail while their audio still played. Falls back to sharing the original URL if
  // cloning fails (e.g. out of memory on a very large source) — not fatal, just re-exposes the
  // old shared-decoder limitation for that one duplicate.
  async function cloneVideoSource(clip: Clip): Promise<{ sourceUrl: string; sourceBlob?: Blob }> {
    if (!clip.sourceBlob) return { sourceUrl: clip.sourceUrl, sourceBlob: clip.sourceBlob };
    try {
      const arrayBuffer = await clip.sourceBlob.arrayBuffer();
      const clonedBlob = new Blob([arrayBuffer], { type: clip.sourceBlob.type });
      return { sourceUrl: URL.createObjectURL(clonedBlob), sourceBlob: clonedBlob };
    } catch {
      return { sourceUrl: clip.sourceUrl, sourceBlob: clip.sourceBlob };
    }
  }

  async function pasteClip() {
    const src = clipboardRef.current;
    if (!src) return;
    const startTime = playheadRef.current;
    const newId = generateId();
    const cloned = src.type === "video" ? await cloneVideoSource(src) : null;
    // Recompute against the freshest clips (cloning is async and other edits may land meanwhile)
    const layer = freeLayerAtTime(clipsRef.current, startTime, src.duration, "", src.layer ?? 1);
    const newClip: Clip = {
      ...src, id: newId, startTime, layer,
      ...(cloned ? { sourceUrl: cloned.sourceUrl, sourceBlob: cloned.sourceBlob } : {}),
    };
    if (src.type === "video") {
      // Pre-set thumbnail so createVideoElement skips re-capture (same source video)
      const srcThumb = thumbnailImagesRef.current.get(src.id);
      if (srcThumb !== undefined) thumbnailImagesRef.current.set(newClip.id, srcThumb);
      createVideoElement(newClip.id, newClip.sourceUrl);
    }
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  }

  async function duplicateClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip) return;
    const startTime = clip.startTime + clip.duration;
    const newId = generateId();
    const cloned = clip.type === "video" ? await cloneVideoSource(clip) : null;
    const layer = freeLayerAtTime(clipsRef.current, startTime, clip.duration, "", clip.layer ?? 1);
    const newClip: Clip = {
      ...clip, id: newId, startTime, layer,
      ...(cloned ? { sourceUrl: cloned.sourceUrl, sourceBlob: cloned.sourceBlob } : {}),
    };
    if (clip.type === "video") {
      // Pre-set thumbnail so createVideoElement skips re-capture (same source video)
      const srcThumb = thumbnailImagesRef.current.get(clip.id);
      if (srcThumb !== undefined) thumbnailImagesRef.current.set(newClip.id, srcThumb);
      createVideoElement(newClip.id, newClip.sourceUrl);
    }
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
  }

  // ─ Narration audio helpers ────────────────────────────────────────────────

  function stopNarrationAudio(clipId: string) {
    const entry = activeNarrationRef.current.get(clipId);
    if (!entry) return;
    try { entry.bufNode.stop(); } catch {}
    try { entry.bufNode.disconnect(); } catch {}
    try { entry.gainNode.disconnect(); } catch {}
    activeNarrationRef.current.delete(clipId);
  }

  function stopAllNarrationAudio() {
    for (const clipId of [...activeNarrationRef.current.keys()]) stopNarrationAudio(clipId);
  }

  async function generateNarrationWaveform(blobUrl: string): Promise<number[]> {
    const ctx = new AudioContext();
    try {
      const ab = await fetch(blobUrl).then((r) => r.arrayBuffer());
      const buffer = await ctx.decodeAudioData(ab);
      const data = buffer.getChannelData(0);
      const SAMPLES = 80;
      const blockSize = Math.max(1, Math.floor(data.length / SAMPLES));
      const peaks: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        let max = 0;
        for (let j = 0; j < blockSize; j++) {
          const v = Math.abs(data[i * blockSize + j] ?? 0);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      return peaks;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ─ Narration recording ────────────────────────────────────────────────────

  async function startNarrationRecording() {
    if (isRecordingRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      micChunksRef.current = [];
      micStartSecRef.current = playheadRef.current;
      micStartWallRef.current = performance.now();
      setRecElapsed(0);
      function elapsedTick() {
        setRecElapsed((performance.now() - micStartWallRef.current) / 1000);
        micRafRef.current = requestAnimationFrame(elapsedTick);
      }
      micRafRef.current = requestAnimationFrame(elapsedTick);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      micRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) micChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
        const blob = new Blob(micChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const blobUrl = URL.createObjectURL(blob);
        const dur: number = await new Promise((resolve) => {
          const audio = new Audio(blobUrl);
          audio.onloadedmetadata = () => resolve(isFinite(audio.duration) ? audio.duration : 1);
          audio.onerror = () => resolve(1);
        });
        if (dur < 0.1) { URL.revokeObjectURL(blobUrl); return; }
        const waveform = await generateNarrationWaveform(blobUrl).catch(() => undefined);
        setClips((prev) => [...prev, {
          id: generateId(),
          type: "narration" as const,
          name: "Narration",
          sourceUrl: blobUrl,
          audioBlob: blob,
          startTime: micStartSecRef.current,
          duration: dur,
          waveform,
        }]);
      };
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
      setToast(e instanceof Error ? e.message : "Microphone access denied");
    }
  }

  function stopNarrationRecording() {
    if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
    if (micRafRef.current !== null) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
    setIsRecording(false);
  }

  async function handleNarrationUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const isVideoFile = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
    setToast("Processing audio…");
    try {
      let blobUrl: string;
      let audioBlob: Blob;
      if (isVideoFile) {
        // Extract just the audio track from the video container
        const arrayBuffer = await file.arrayBuffer();
        const tmpCtx = new AudioContext();
        const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
        await tmpCtx.close().catch(() => {});
        const wavBlob = audioBufferToWav(audioBuffer);
        blobUrl = URL.createObjectURL(wavBlob);
        audioBlob = wavBlob;
      } else {
        audioBlob = file;
        blobUrl = URL.createObjectURL(file);
      }
      const dur: number = await new Promise((resolve) => {
        const audio = new Audio(blobUrl);
        audio.onloadedmetadata = () => resolve(isFinite(audio.duration) ? audio.duration : 1);
        audio.onerror = () => resolve(1);
      });
      if (dur < 0.1) { URL.revokeObjectURL(blobUrl); setToast("No audio found in file"); return; }
      const waveform = await generateNarrationWaveform(blobUrl).catch(() => undefined);
      setClips((prev) => [...prev, {
        id: generateId(),
        type: "narration" as const,
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 40),
        sourceUrl: blobUrl,
        audioBlob,
        startTime: playheadRef.current,
        duration: dur,
        waveform,
      }]);
      setToast(isVideoFile ? "Audio extracted from video" : "Narration added");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to process file");
    }
  }

  async function setNarrationSpeechBubbles(clip: Clip, enabled: boolean) {
    if (clip.type !== "narration") return;
    const owner = activeCharacterIdRef.current;
    const applyGestureActions = (updatedClip: Clip) => {
      const resolvedOwnerActions = owner === "c2" ? resolvedCharActions2Ref.current : resolvedCharActionsRef.current;
      updateCharacterActionsFor(owner, (prev) => [
        ...prev.filter((action) => action.narrationGestureClipId !== updatedClip.id),
        ...narrationSpeechGestureActions(updatedClip, resolvedOwnerActions, owner),
      ]);
    };
    if (!enabled) {
      setClips((current) => current.map((item) => item.id === clip.id ? { ...item, speechBubbles: false } : item));
      setCharacterActions((prev) => prev.filter((action) => action.narrationGestureClipId !== clip.id));
      setCharacterActions2((prev) => prev.filter((action) => action.narrationGestureClipId !== clip.id));
      return;
    }
    if (clip.transcriptSegments?.length) {
      const updatedClip = { ...clip, speechBubbles: true, speechBubbleGestures: clip.speechBubbleGestures !== false };
      setClips((current) => current.map((item) => item.id === clip.id ? updatedClip : item));
      if (updatedClip.speechBubbleGestures) applyGestureActions(updatedClip);
      if (owner === "c2") setShowCharacter2(true);
      else setShowCharacter(true);
      return;
    }
    setTranscribingNarrationId(clip.id);
    setToast("Transcribing narration for speech bubbles…");
    try {
      const audio: Blob = clip.audioBlob instanceof Blob
        ? clip.audioBlob
        : await fetch(clip.sourceUrl).then((response) => response.blob());
      const form = new FormData();
      form.append("audio", audio, `${clip.name || "narration"}.wav`);
      const response = await fetch("/api/board2/transcribe-audio", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Transcription failed");
      const segments: TranscriptSegment[] = Array.isArray(data.segments)
        ? data.segments
            .map((segment: TranscriptSegment) => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text ?? "").trim() }))
            .filter((segment: TranscriptSegment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
        : [];
      if (!segments.length) throw new Error("No spoken narration was detected");
      const updatedClip = { ...clip, speechBubbles: true, speechBubbleGestures: true, transcriptSegments: segments };
      setClips((current) => current.map((item) => item.id === clip.id ? updatedClip : item));
      applyGestureActions(updatedClip);
      if (owner === "c2") setShowCharacter2(true);
      else setShowCharacter(true);
      setToast(`Speech bubbles created · ${narrationSentenceCues(segments).length} sentences`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not create speech bubbles");
    } finally {
      setTranscribingNarrationId(null);
    }
  }

  function setNarrationSpeechGestures(clip: Clip, enabled: boolean) {
    if (clip.type !== "narration") return;
    const owner = activeCharacterIdRef.current;
    const updatedClip = { ...clip, speechBubbleGestures: enabled };
    setClips((current) => current.map((item) => item.id === clip.id ? { ...item, speechBubbleGestures: enabled } : item));
    setCharacterActions((prev) => prev.filter((action) => action.narrationGestureClipId !== clip.id));
    setCharacterActions2((prev) => prev.filter((action) => action.narrationGestureClipId !== clip.id));
    if (!enabled || !updatedClip.speechBubbles || !updatedClip.transcriptSegments?.length) return;
    const resolvedOwnerActions = owner === "c2" ? resolvedCharActions2Ref.current : resolvedCharActionsRef.current;
    updateCharacterActionsFor(owner, (prev) => [
      ...prev.filter((action) => action.narrationGestureClipId !== clip.id),
      ...narrationSpeechGestureActions(updatedClip, resolvedOwnerActions, owner),
    ]);
    if (owner === "c2") setShowCharacter2(true);
    else setShowCharacter(true);
    setToast("Speech hand motions on");
  }

  // ─ Media upload ───────────────────────────────────────────────────────────

  // Shared by file-input uploads and clipboard image paste — takes any File/Blob, registers it
  // in the media library, and places it on the board via addClipAndPlaceOnBoard.
  async function ingestMediaFile(file: File | Blob, name: string) {
    const url = URL.createObjectURL(file);
    const type: "image" | "video" = file.type.startsWith("video") ? "video" : "image";
    loadMedia(url, type);
    let duration: number | undefined;
    if (type === "video") {
      const meta = await getVideoMeta(url);
      duration = meta.duration;
      if (meta.w > 0 && !videoDimsRef.current.has(url)) {
        const scale = Math.min(1, 800 / meta.w, 600 / meta.h);
        videoDimsRef.current.set(url, { w: Math.round(meta.w * scale), h: Math.round(meta.h * scale) });
      }
    }
    const item: MediaItem = { id: generateId(), name, type, url, duration, blob: type === "video" ? file : undefined };
    setMediaLibrary((prev) => [...prev, item]);
    await addClipAndPlaceOnBoard(item);
  }

  async function handleMediaUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      await ingestMediaFile(file, file.name);
    }
  }

  function openPlayAddMenu() {
    setPlayCleanMenuOpen(false);
    setPlayAddMenuOpen((v) => !v);
  }

  function triggerPlayMediaUpload() {
    setPlayAddMenuOpen(false);
    playHeldKeysRef.current.clear();
    playPointerRef.current = null;
    mediaUploadRef.current?.click();
  }

  function openPlayYoutubeModal() {
    setPlayAddMenuOpen(false);
    setYtView("search");
    setYtTab("search");
    setYtSelected(null);
    setYtError("");
    setYtModalOpen(true);
  }

  // ─ YouTube ────────────────────────────────────────────────────────────────

  async function handleYtSearch(shortsOnlyOverride?: boolean) {
    if (!ytQuery.trim()) return;
    setYtLoading(true); setYtError(""); setYtResults([]);
    try {
      const res = await fetch("/api/yt-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: ytQuery, limit: 12, shortsOnly: shortsOnlyOverride !== undefined ? shortsOnlyOverride : ytShortsOnly }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setYtResults(Array.isArray(data) ? data : []);
    } catch (e) {
      setYtError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setYtLoading(false);
    }
  }

  function handleYtPasteUrl() {
    const videoId = extractYouTubeId(ytUrlInput.trim());
    if (!videoId) { setYtError("Couldn't find a YouTube video ID in that URL"); return; }
    setYtError("");
    setYtSelected({ id: videoId, title: "YouTube clip", channel: "", duration: 600, thumbnail: "" });
    setYtStart(0); setYtStartInput("0:00");
    setYtEnd(30); setYtEndInput("0:30");
    ytRangeRef.current = { start: 0, end: 30 };
    setYtView("trim");
  }

  function handleYtConfirm() {
    if (!ytSelected) return;
    const ytSel = ytSelected;
    const start = ytStart, end = ytEnd;
    const title = (ytSel.title ?? "YouTube clip").slice(0, 40);
    // Set when this download originated from a Neural Search placeholder click — reuse its
    // board position instead of auto-placing, and remove it once the real clip lands.
    const sourcePlaceholderId = ytSel.placeholderId;
    const placeholderBoardX = ytSel.boardX;
    const placeholderBoardY = ytSel.boardY;

    // Close the modal instantly — download continues in the background via a toast
    setYtModalOpen(false);
    setYtView("search"); setYtTab("search"); setYtSelected(null);
    setYtResults([]); setYtQuery(""); setYtUrlInput(""); setYtError("");

    const toastId = generateId();
    setDownloadToasts((prev) => [...prev, { id: toastId, title, status: "downloading" }]);

    (async () => {
      try {
        const url = `https://www.youtube.com/watch?v=${ytSel.id}`;
        const dlRes = await fetch("/api/ytdl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, start, end }),
        });
        if (!dlRes.ok) {
          const err = await dlRes.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error || `Download failed (${dlRes.status})`);
        }
        const blob = await dlRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const clipDuration = end - start;
        const clipId = generateId();

        const vid = createVideoElement(clipId, blobUrl);

        // Wait for metadata to get natural dimensions + source duration
        const meta = await new Promise<{ w: number; h: number; sourceDurationSec: number }>((resolve) => {
          const timer = setTimeout(() => resolve({ w: 800, h: 450, sourceDurationSec: clipDuration }), 3000);
          vid.addEventListener("loadedmetadata", () => {
            clearTimeout(timer);
            const sourceDurationSec = isFinite(vid.duration) ? vid.duration : clipDuration;
            if (vid.videoWidth > 0 && vid.videoHeight > 0) {
              const scale = Math.min(1, 800 / vid.videoWidth, 600 / vid.videoHeight);
              resolve({ w: Math.round(vid.videoWidth * scale), h: Math.round(vid.videoHeight * scale), sourceDurationSec });
            } else {
              resolve({ w: 800, h: 450, sourceDurationSec });
            }
          }, { once: true });
        });

        // Register dimensions so getMediaDimensions can use them for future duplicates
        if (meta.w > 0 && !videoDimsRef.current.has(blobUrl)) {
          videoDimsRef.current.set(blobUrl, { w: meta.w, h: meta.h });
        }
        setClips((prev) => {
          const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
          const layer = freeLayerAtTime(prev, endTime, clipDuration, clipId, 1);
          const pos = (placeholderBoardX !== undefined && placeholderBoardY !== undefined)
            ? { boardX: placeholderBoardX, boardY: placeholderBoardY }
            : findBoardPosForNewMedia(prev, meta.w, meta.h);
          return [...prev, {
            id: clipId, type: "video" as const, name: title, sourceUrl: blobUrl,
            startTime: endTime, duration: clipDuration, layer,
            boardX: pos.boardX, boardY: pos.boardY, boardW: meta.w, boardH: meta.h,
            sourceDurationSec: meta.sourceDurationSec,
            sourceBlob: blob,
            youtubeId: ytSel.id, ytStart: start, ytEnd: end,
          }];
        });
        setSelectedClipId(clipId);
        if (sourcePlaceholderId) {
          setNeuralPlaceholders((prev) => prev.filter((p) => p.id !== sourcePlaceholderId));
        }

        setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "done" } : t));
        setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 2000);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Download failed";
        setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "error", error: message } : t));
        setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
      }
    })();
  }

  // ─ Neural Search ──────────────────────────────────────────────────────────

  async function runNeuralSearch() {
    const concept = neuralConcept.trim();
    if (!concept) return;
    setNeuralError("");
    setNeuralPhase("Analyzing concept...");
    // The API call is a single round trip — stage the copy so the wait doesn't feel opaque.
    const t1 = setTimeout(() => setNeuralPhase("Searching YouTube..."), 1800);
    const t2 = setTimeout(() => setNeuralPhase("Ranking by popularity..."), 5000);
    try {
      const res = await fetch("/api/neural-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as {
        videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }>;
        images: Array<{ imageUrl: string; title: string; sourceUrl: string }>;
      };
      const videos = Array.isArray(data.videos) ? data.videos : [];
      const images = Array.isArray(data.images) ? data.images : [];
      if (videos.length === 0 && images.length === 0) {
        setNeuralError("Nothing found — try describing the concept differently");
        return;
      }

      // Place every candidate (videos + images) on the board through one shared occupied-rect
      // list, avoiding overlap with existing clips, existing placeholders, and each other — and
      // so the two types end up mixed spatially rather than videos landing in one cluster.
      const { camX, camY } = getVisibleBoardCenter();
      const occupied: Array<{ boardX?: number; boardY?: number; boardW?: number; boardH?: number }> =
        [...clipsRef.current, ...neuralPlaceholders, ...imagePlaceholders];
      const newVideoPlaceholders: NeuralPlaceholder[] = videos.map((v) => {
        const w = 800, h = 450;
        const pos = findFreeBoardPos(occupied, w, h, camX, camY);
        occupied.push({ boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h });
        return {
          id: generateId(), boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          videoId: v.videoId, title: v.title, channel: v.channel, thumbnailUrl: v.thumbnailUrl,
          viewCount: v.viewCount, durationSec: v.durationSec,
        };
      });
      const newImagePlaceholders: ImagePlaceholder[] = images.map((img) => {
        const w = 600, h = 400;
        const pos = findFreeBoardPos(occupied, w, h, camX, camY);
        occupied.push({ boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h });
        return {
          id: generateId(), boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          imageUrl: img.imageUrl, title: img.title, sourceUrl: img.sourceUrl,
        };
      });
      setNeuralPlaceholders((prev) => [...prev, ...newVideoPlaceholders]);
      setImagePlaceholders((prev) => [...prev, ...newImagePlaceholders]);
      setNeuralModalOpen(false);
      setNeuralConcept("");
    } catch (e) {
      setNeuralError(e instanceof Error ? e.message : "Search failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setNeuralPhase(null);
    }
  }

  function removeNeuralPlaceholder(id: string) {
    setNeuralPlaceholders((prev) => prev.filter((p) => p.id !== id));
  }

  // ─ Top 5 Neural Search ────────────────────────────────────────────────────

  async function runTop5Search() {
    const concept = top5Concept.trim();
    if (!concept) return;
    setTop5Error("");
    setTop5Phase("Generating list...");
    const t1 = setTimeout(() => setTop5Phase("Searching videos..."), 4000);
    const t2 = setTimeout(() => setTop5Phase("Arranging on board..."), 10000);
    try {
      const res = await fetch("/api/top5-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as {
        title: string;
        items: Array<{
          rank: number;
          label: string;
          blurb: string;
          videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }>;
        }>;
      };

      if (!data.items || data.items.length === 0) {
        setTop5Error("Nothing found — try a different concept");
        return;
      }

      // ── Column layout constants ──────────────────────────────────────────
      // 5 columns, each 750px wide, rank #5 on the left → rank #1 on the right
      const COL_STRIDE = 750;
      const COL_START_X = 100;
      const TITLE_Y = 60;
      const RANK_Y = 280;        // y of the big rank number (#5, #4, …)
      const LABEL_Y = 450;       // y of the item label below the rank number
      const VIDEO_Y_START = 540; // y of first video placeholder
      const VIDEO_GAP = 30;      // gap between stacked videos
      const VIDEO_W = 700;
      const VIDEO_H = 400;
      const VIDEO_X_PAD = 25;    // padding from column left edge

      const RANK_COLORS: Record<number, string> = {
        5: "#7c3d1a",  // brown
        4: "#d4651e",  // orange
        3: "#cc2200",  // red
        2: "#b00000",  // bold red
        1: "#c49a00",  // gold
      };

      const newAnnotations: Annotation[] = [];

      // Title annotation spanning all columns
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: COL_START_X,
        boardY: TITLE_Y,
        boardW: 3800,
        boardH: 250,
        color: "#cc2200",
        text: data.title,
        fontFamily: "Permanent Marker",
        fontSize: 180,
        fontWeight: "bold",
      });

      const newPlaceholders: NeuralPlaceholder[] = [];

      // items arrive sorted rank 5→1 from API
      data.items.forEach((item) => {
        const rankIndex = 5 - item.rank; // 0=rank5, 4=rank1
        const colX = COL_START_X + rankIndex * COL_STRIDE;
        const color = RANK_COLORS[item.rank] ?? "#2a2a2a";

        // Big rank number annotation
        newAnnotations.push({
          id: generateId(),
          type: "text",
          boardX: colX,
          boardY: RANK_Y,
          boardW: VIDEO_W,
          boardH: 180,
          color,
          text: `#${item.rank}`,
          fontFamily: "Permanent Marker",
          fontSize: item.rank === 2 ? 150 : 140,
          fontWeight: item.rank <= 2 ? "bold" : "normal",
        });

        // Item label annotation
        newAnnotations.push({
          id: generateId(),
          type: "text",
          boardX: colX,
          boardY: LABEL_Y,
          boardW: VIDEO_W,
          boardH: 80,
          color: "#2a2a2a",
          text: item.label,
          fontFamily: "Caveat",
          fontSize: 60,
          fontWeight: "normal",
        });

        // Video placeholders for this rank
        item.videos.forEach((v, vi) => {
          const boardY = VIDEO_Y_START + vi * (VIDEO_H + VIDEO_GAP);
          newPlaceholders.push({
            id: generateId(),
            boardX: colX + VIDEO_X_PAD,
            boardY,
            boardW: VIDEO_W,
            boardH: VIDEO_H,
            videoId: v.videoId,
            title: v.title,
            channel: v.channel,
            thumbnailUrl: v.thumbnailUrl,
            viewCount: v.viewCount,
            durationSec: v.durationSec,
          });
        });
      });

      setAnnotations((prev) => [...prev, ...newAnnotations]);
      setNeuralPlaceholders((prev) => [...prev, ...newPlaceholders]);
      setTop5ModalOpen(false);
      setTop5Concept("");
    } catch (e) {
      setTop5Error(e instanceof Error ? e.message : "Search failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setTop5Phase(null);
    }
  }

  // ─ Mobile Top 5 Tinder flow ──────────────────────────────────────────────

  function parseMobileTrimInput(str: string): number | null {
    const s = str.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const m = s.match(/^(\d+):(\d+)$/);
    if (m) {
      const secs = parseInt(m[2], 10);
      if (secs >= 60) return null;
      return parseInt(m[1], 10) * 60 + secs;
    }
    return null;
  }

  function formatMobileTrimTime(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function getMobileRankLabel(rank: number): string {
    return mobileTop5CustomLabels.get(rank)
      ?? mobileTop5Data?.items.find((i) => i.rank === rank)?.label
      ?? `#${rank}`;
  }

  function setMobileTop5Trim(start: number, end: number) {
    setMobileTop5TrimStart(start);
    setMobileTop5TrimEnd(end);
    setMobileTop5TrimStartInput(formatMobileTrimTime(start));
    setMobileTop5TrimEndInput(formatMobileTrimTime(end));
    setMobileTop5TrimError("");
  }

  function validateMobileTrim(startStr: string, endStr: string, maxDur: number): string {
    const start = parseMobileTrimInput(startStr);
    const end = parseMobileTrimInput(endStr);
    if (start === null) return "Invalid start time (use M:SS)";
    if (end === null) return "Invalid end time (use M:SS)";
    if (end <= start) return "End must be after start";
    if (end - start < 0.5) return "Clip must be at least 0.5 s";
    if (end - start > 30) return "Max clip length is 30 s";
    if (maxDur > 0 && end > maxDur + 1) return `End exceeds video duration (${formatMobileTrimTime(maxDur)})`;
    return "";
  }

  function seekMobileYtEmbed(seconds: number) {
    try {
      mobileYtIframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "seekTo", args: [seconds, true] }),
        "*"
      );
    } catch {}
  }

  async function runMobileTop5Search() {
    const concept = mobileTop5Concept.trim();
    if (!concept) return;
    setMobileTop5Error("");
    setMobileTop5Screen("loading");
    try {
      const res = await fetch("/api/top5-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept, itemCount: mobileTop5ListLength }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Search failed (${res.status})`);
      }
      const data = await res.json() as { title: string; items: Array<{ rank: number; label: string; blurb: string; videos: Array<{ videoId: string; title: string; channel: string; thumbnailUrl: string; viewCount: number; durationSec: number }> }> };
      if (!data.items || data.items.length === 0) throw new Error("Nothing found — try a different concept");

      setMobileTop5Data(data);

      const byRank = new Map<number, typeof data.items[0]["videos"]>();
      const idxByRank = new Map<number, number>();
      data.items.forEach((item) => {
        byRank.set(item.rank, item.videos);
        idxByRank.set(item.rank, 0);
      });
      setMobileTop5ResultsByRank(byRank);
      setMobileTop5IndexByRank(idxByRank);

      const topRank = data.items.reduce((mx, item) => Math.max(mx, item.rank), 1);
      const firstRankData = data.items.find((i) => i.rank === topRank);
      const firstDur = firstRankData?.videos[0]?.durationSec ?? 30;
      const firstEnd = Math.min(30, firstDur);
      setMobileTop5TrimStart(0);
      setMobileTop5TrimEnd(firstEnd);
      setMobileTop5TrimStartInput("0:00");
      setMobileTop5TrimEndInput(formatMobileTrimTime(firstEnd));
      setMobileTop5TrimError("");
      setMobileTop5CurrentRank(topRank);
      setMobileTop5AcceptedByRank(new Map());
      setMobileTop5CustomLabels(new Map());
      setMobileTop5EditingLabel(false);
      setMobileTop5Screen("swipe");
    } catch (e) {
      setMobileTop5Error(e instanceof Error ? e.message : "Search failed");
      setMobileTop5Screen("prompt");
    }
  }

  function getMobileCurrentVideo() {
    const results = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    const index = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
    return results[index] ?? null;
  }

  function advanceMobileToNextRank(accepted: Map<number, { videoId: string; trimStart: number; trimEnd: number; title: string }>) {
    const nextRank = mobileTop5CurrentRank - 1;
    if (nextRank < 1) {
      setMobileTop5AcceptedByRank(accepted);
      buildMobileTop5Video(accepted);
    } else {
      setMobileTop5EditingLabel(false);
      setMobileTop5CurrentRank(nextRank);
      const nextResults = mobileTop5ResultsByRank.get(nextRank) ?? [];
      const nextDur = nextResults[0]?.durationSec ?? 30;
      setMobileTop5Trim(0, Math.min(30, nextDur));
    }
  }

  function handleMobileAccept() {
    const video = getMobileCurrentVideo();
    if (!video || mobileTop5LoadingRank !== null || !!mobileTop5TrimError) return;
    setMobileTop5EditingLabel(false);
    setMobileTop5CardAnim("accept");
    setTimeout(() => {
      setMobileTop5CardAnim(null);
      const newAccepted = new Map(mobileTop5AcceptedByRank);
      newAccepted.set(mobileTop5CurrentRank, {
        videoId: video.videoId,
        trimStart: mobileTop5TrimStart,
        trimEnd: mobileTop5TrimEnd,
        title: video.title,
      });
      setMobileTop5AcceptedByRank(newAccepted);
      advanceMobileToNextRank(newAccepted);
    }, 320);
  }

  function handleMobileReject() {
    const results = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    if (mobileTop5LoadingRank !== null) return;
    setMobileTop5EditingLabel(false);
    setMobileTop5CardAnim("reject");
    setTimeout(() => {
      setMobileTop5CardAnim(null);
      const currentIdx = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
      const nextIdx = currentIdx + 1;
      if (nextIdx < results.length) {
        const nextDur = results[nextIdx]?.durationSec ?? 30;
        setMobileTop5Trim(0, Math.min(30, nextDur));
        setMobileTop5IndexByRank((prev) => {
          const m = new Map(prev);
          m.set(mobileTop5CurrentRank, nextIdx);
          return m;
        });
      } else {
        const label = getMobileRankLabel(mobileTop5CurrentRank);
        fetchMoreMobileVideos(mobileTop5CurrentRank, label);
      }
    }, 320);
  }

  async function fetchMoreMobileVideos(rank: number, label: string) {
    setMobileTop5LoadingRank(rank);
    try {
      const query = `${label} documentary highlights best moments`;
      const res = await fetch("/api/yt-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 8 }),
      });
      if (!res.ok) return;
      const raw = await res.json() as Array<Record<string, unknown>>;
      const newVideos = (Array.isArray(raw) ? raw : []).map((r) => {
        const dur = r.duration_seconds ?? r.durationSec;
        const durStr = typeof r.duration === "string" ? r.duration : undefined;
        let durationSec = typeof dur === "number" ? dur : 0;
        if (!durationSec && durStr) {
          const parts = durStr.split(":").map(Number);
          if (parts.length === 2) durationSec = (parts[0] || 0) * 60 + (parts[1] || 0);
          else if (parts.length === 3) durationSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        }
        return {
          videoId: (r.id ?? r.videoId) as string,
          title: String(r.title ?? "YouTube clip"),
          channel: String(r.channel ?? r.channelTitle ?? ""),
          thumbnailUrl: String(r.thumbnail ?? r.thumbnailUrl ?? ""),
          viewCount: Number(r.viewCount ?? r.view_count ?? r.views ?? 0),
          durationSec,
        };
      }).filter((v) => !!v.videoId);

      if (newVideos.length > 0) {
        setMobileTop5ResultsByRank((prev) => {
          const m = new Map(prev);
          const existing = m.get(rank) ?? [];
          m.set(rank, [...existing, ...newVideos]);
          return m;
        });
        const nextDur = newVideos[0]?.durationSec ?? 30;
        setMobileTop5Trim(0, Math.min(30, nextDur));
      }
    } finally {
      setMobileTop5LoadingRank(null);
    }
  }

  async function buildMobileTop5Video(accepted: Map<number, { videoId: string; trimStart: number; trimEnd: number; title: string }>) {
    setMobileTop5Screen("build");
    setMobileTop5BuildPhase("Setting up...");

    const topRank = mobileTop5ListLength;

    // Set 9:16 canvas
    setCanvasAspect("9:16");
    canvasWRef.current = CANVAS_H_LAND; // 1080
    canvasHRef.current = CANVAS_W_LAND; // 1920

    const RANK_COLORS: Record<number, string> = {
      5: "#7c3d1a", 4: "#d4651e", 3: "#cc2200", 2: "#b00000", 1: "#c49a00",
    };
    const CLIP_W = 750, CLIP_H = 422;
    const CLIP_STRIDE = CLIP_W + 80;
    const CLIP_START_X = 150;
    const CLIP_Y = 1280;

    // Add rank label annotations (uses getMobileRankLabel for custom labels)
    const newAnnotations: Annotation[] = [];
    for (let rank = topRank; rank >= 1; rank--) {
      const i = topRank - rank;
      const colX = CLIP_START_X + i * CLIP_STRIDE;
      const label = getMobileRankLabel(rank);
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: colX,
        boardY: CLIP_Y - 220,
        boardW: CLIP_W,
        boardH: 200,
        color: RANK_COLORS[rank] ?? "#2a2a2a",
        text: `#${rank}`,
        fontFamily: "Permanent Marker",
        fontSize: 170,
        fontWeight: "bold",
      });
      newAnnotations.push({
        id: generateId(),
        type: "text",
        boardX: colX,
        boardY: CLIP_Y - 60,
        boardW: CLIP_W,
        boardH: 60,
        color: "#2a2a2a",
        text: label,
        fontFamily: "Caveat",
        fontSize: 48,
        fontWeight: "normal",
      });
    }
    annotationsRef.current = [...annotationsRef.current, ...newAnnotations];
    setAnnotations((prev) => [...prev, ...newAnnotations]);

    const ranks = Array.from({ length: topRank }, (_, ii) => topRank - ii); // [N, N-1, ..., 1]
    for (let ri = 0; ri < ranks.length; ri++) {
      const rank = ranks[ri];
      const acc = accepted.get(rank);
      if (!acc) continue;
      const i = topRank - rank;
      const colX = CLIP_START_X + i * CLIP_STRIDE;
      const startTime = i * 5;

      setMobileTop5BuildPhase(`Downloading #${rank} (${ri + 1}/${topRank})...`);
      try {
        const dlRes = await fetch("/api/ytdl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${acc.videoId}`,
            start: acc.trimStart,
            end: acc.trimEnd,
          }),
        });
        if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);
        const blob = await dlRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const clipId = generateId();
        const clipDur = acc.trimEnd - acc.trimStart;
        createVideoElement(clipId, blobUrl);
        const clip: Clip = {
          id: clipId,
          type: "video",
          name: acc.title.slice(0, 40),
          sourceUrl: blobUrl,
          startTime,
          duration: Math.min(clipDur, 5),
          layer: 1,
          boardX: colX,
          boardY: CLIP_Y,
          boardW: CLIP_W,
          boardH: CLIP_H,
          sourceBlob: blob,
          youtubeId: acc.videoId,
          ytStart: acc.trimStart,
          ytEnd: acc.trimEnd,
        };
        clipsRef.current = [...clipsRef.current, clip];
        setClips((prev) => [...prev, clip]);
      } catch {
        // Continue even if one download fails
      }
    }

    setMobileTop5BuildPhase("Generating camera path...");
    generateCameraKeyframes();

    setMobileTop5BuildPhase(null);
    setMobileTop5Screen("done");
  }

  function renderMobileTop5Flow() {
    const totalRanks = mobileTop5ListLength;
    const acceptedCount = mobileTop5AcceptedByRank.size;
    const video = getMobileCurrentVideo();
    const currentResults = mobileTop5ResultsByRank.get(mobileTop5CurrentRank) ?? [];
    const currentIdx = mobileTop5IndexByRank.get(mobileTop5CurrentRank) ?? 0;
    const currentItem = mobileTop5Data?.items.find((i) => i.rank === mobileTop5CurrentRank);
    const currentLabel = getMobileRankLabel(mobileTop5CurrentRank);
    const acceptDisabled = !video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null || !!mobileTop5TrimError;

    const bg = "#fffdf5";
    const ink = "#2a2a2a";
    const accent = "#c8f135";

    // Card slide animation (button-triggered only — no swipe handlers)
    let cardTransform = "translateX(0)";
    let cardOpacity = 1;
    if (mobileTop5CardAnim === "accept") { cardTransform = "translateX(110%)"; cardOpacity = 0; }
    if (mobileTop5CardAnim === "reject") { cardTransform = "translateX(-110%)"; cardOpacity = 0; }

    function commitLabelEdit() {
      if (mobileTop5LabelInput.trim()) {
        setMobileTop5CustomLabels((prev) => {
          const m = new Map(prev);
          m.set(mobileTop5CurrentRank, mobileTop5LabelInput.trim());
          return m;
        });
      }
      setMobileTop5EditingLabel(false);
    }

    return (
      <div style={{ position: "fixed", inset: 0, background: bg, fontFamily: "monospace", display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
        <style>{`
          @keyframes m5spin { to { transform: rotate(360deg); } }
          @media (orientation: landscape) {
            .m5-landscape-warn { display: flex !important; }
            .m5-portrait-content { display: none !important; }
          }
          @supports not (height: 100dvh) { .m5-root { height: 100vh !important; } }
        `}</style>

        {/* Landscape warning */}
        <div className="m5-landscape-warn" style={{ display: "none", position: "fixed", inset: 0, zIndex: 9999, background: bg, flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
          <div style={{ fontSize: 40 }}>↕</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Rotate to portrait</div>
          <div style={{ fontSize: 11, color: "#6a6a6a", textAlign: "center", padding: "0 32px", lineHeight: 1.6 }}>The mobile Top 5 builder works in portrait mode</div>
        </div>

        <div className="m5-portrait-content" style={{ display: "flex", flexDirection: "column", height: "100dvh", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1.5px dashed rgba(42,42,42,0.25)", flexShrink: 0 }}>
            <span style={{ fontFamily: "'Caveat', cursive", fontSize: 20, fontWeight: 700, color: ink, flex: 1 }}>
              Top {totalRanks} Builder
            </span>
            <button
              onClick={() => setMobileDesktopOverride(true)}
              style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", background: "transparent", border: "1px solid rgba(42,42,42,0.3)", padding: "4px 8px", cursor: "pointer" }}
            >
              Desktop version
            </button>
          </div>

          {/* ── Screen 1: Prompt ── */}
          {mobileTop5Screen === "prompt" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20, gap: 16, overflowY: "auto" }}>
              <div>
                <div style={{ fontFamily: "'Caveat', cursive", fontSize: 30, fontWeight: 700, color: ink, lineHeight: 1.2, marginBottom: 8 }}>
                  What&apos;s your Top {totalRanks}?
                </div>
                <div style={{ fontSize: 11, color: "#6a6a6a", lineHeight: 1.5 }}>
                  Describe your concept. We&apos;ll find video candidates for each rank — tap ✓ to keep, ✕ to skip.
                </div>
              </div>
              {mobileTop5Error && (
                <div style={{ fontSize: 12, color: "#cc2200", background: "#fff0ee", border: "1px solid #cc2200", padding: "8px 12px" }}>
                  {mobileTop5Error}
                </div>
              )}
              <textarea
                value={mobileTop5Concept}
                onChange={(e) => setMobileTop5Concept(e.target.value)}
                placeholder="e.g. Top 5 conspiracies that turned out to be true"
                style={{
                  flex: 1, minHeight: "32dvh", width: "100%", boxSizing: "border-box",
                  fontFamily: "monospace", fontSize: 15, lineHeight: 1.6,
                  border: "1.5px solid #2a2a2a", padding: 14, resize: "none", background: "#fff",
                } as React.CSSProperties}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runMobileTop5Search(); }}
              />

              {/* List length segmented control */}
              <div>
                <div style={{ fontSize: 9, color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>List length</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {([3, 4, 5] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => setMobileTop5ListLength(n)}
                      style={{
                        flex: 1, padding: "12px 0", fontFamily: "monospace", fontSize: 18, fontWeight: 700,
                        background: mobileTop5ListLength === n ? ink : "#fff",
                        color: mobileTop5ListLength === n ? accent : ink,
                        border: `1.5px solid ${ink}`,
                        cursor: "pointer",
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <ProGated featureName="Top 5 Neural Search">
                <button
                  onClick={runMobileTop5Search}
                  disabled={!mobileTop5Concept.trim()}
                  style={{
                    width: "100%", padding: 18, fontFamily: "monospace", fontSize: 16, fontWeight: 700,
                    background: mobileTop5Concept.trim() ? ink : "#ccc",
                    color: mobileTop5Concept.trim() ? accent : "#888",
                    border: "none", cursor: mobileTop5Concept.trim() ? "pointer" : "not-allowed",
                    boxShadow: mobileTop5Concept.trim() ? "3px 3px 0 rgba(0,0,0,0.15)" : "none",
                    minHeight: 60,
                  }}
                >
                  Generate →
                </button>
              </ProGated>
            </div>
          )}

          {/* ── Screen 2: Loading ── */}
          {mobileTop5Screen === "loading" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: 32 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Caveat', cursive", fontSize: 22, fontWeight: 700, color: ink, marginBottom: 6 }}>
                  Generating list...
                </div>
                <div style={{ fontSize: 11, color: "#6a6a6a" }}>Finding the best video candidates for each rank</div>
              </div>
              <button
                onClick={() => { setMobileTop5Screen("prompt"); setMobileTop5Error(""); }}
                style={{ fontFamily: "monospace", fontSize: 12, background: "transparent", border: "1.5px solid rgba(42,42,42,0.4)", padding: "10px 20px", cursor: "pointer", color: "#6a6a6a" }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* ── Screen 3: Swipe (buttons only — no touch drag) ── */}
          {mobileTop5Screen === "swipe" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
              {/* Progress + editable rank label */}
              <div style={{ padding: "10px 16px 0", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "'Caveat', cursive", fontSize: 24, fontWeight: 700, color: ink, flexShrink: 0 }}>
                    #{mobileTop5CurrentRank}
                  </span>
                  {mobileTop5EditingLabel ? (
                    <input
                      autoFocus
                      value={mobileTop5LabelInput}
                      onChange={(e) => setMobileTop5LabelInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") commitLabelEdit(); }}
                      onBlur={commitLabelEdit}
                      style={{
                        fontFamily: "'Caveat', cursive", fontSize: 22, fontWeight: 700, color: ink,
                        border: "none", borderBottom: "2px solid #2a2a2a", background: "transparent",
                        outline: "none", flex: 1, minWidth: 0,
                      } as React.CSSProperties}
                    />
                  ) : (
                    <span
                      onClick={() => { setMobileTop5LabelInput(currentLabel); setMobileTop5EditingLabel(true); }}
                      style={{ fontFamily: "'Caveat', cursive", fontSize: 22, fontWeight: 700, color: ink, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, minWidth: 0, flex: 1 }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
                      <span style={{ fontSize: 13, opacity: 0.4, flexShrink: 0 }}>✎</span>
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: "#6a6a6a", flexShrink: 0 }}>{acceptedCount}/{totalRanks}</span>
                </div>
                <div style={{ height: 3, background: "rgba(42,42,42,0.1)", borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${(acceptedCount / totalRanks) * 100}%`, background: accent, borderRadius: 2, transition: "width 0.3s" }} />
                </div>
                {currentItem?.blurb && (
                  <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 5, lineHeight: 1.4 }}>{currentItem.blurb}</div>
                )}
              </div>

              {/* Card area */}
              <div style={{ flex: 1, padding: "8px 16px 0", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {mobileTop5LoadingRank === mobileTop5CurrentRank ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, border: "1.5px solid rgba(42,42,42,0.2)", background: "#fff" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", border: "2.5px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
                    <div style={{ fontSize: 11, color: "#6a6a6a" }}>Finding more videos...</div>
                  </div>
                ) : video ? (
                  <div
                    style={{
                      flex: 1, display: "flex", flexDirection: "column", border: "1.5px solid rgba(42,42,42,0.25)", background: "#fff",
                      transform: cardTransform, opacity: cardOpacity,
                      transition: mobileTop5CardAnim ? "transform 0.3s ease-in, opacity 0.3s" : "none",
                      overflow: "hidden", minHeight: 0,
                    }}
                  >
                    {/* YouTube embed with enablejsapi for seekTo */}
                    <div style={{ aspectRatio: "16/9", flexShrink: 0, background: "#000" }}>
                      <iframe
                        key={video.videoId}
                        ref={mobileYtIframeRef}
                        src={`https://www.youtube.com/embed/${video.videoId}?autoplay=1&mute=1&controls=1&modestbranding=1&rel=0&playsinline=1&enablejsapi=1`}
                        allow="autoplay; encrypted-media"
                        allowFullScreen
                        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                      />
                    </div>

                    {/* Video info */}
                    <div style={{ padding: "8px 12px 4px", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.3, marginBottom: 2, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {video.title}
                      </div>
                      <div style={{ fontSize: 10, color: "#6a6a6a" }}>
                        {video.channel}{video.viewCount > 0 ? ` · ${(video.viewCount / 1e6).toFixed(1)}M views` : ""}
                      </div>
                    </div>

                    {/* Trim: typed MM:SS fields */}
                    <div style={{ padding: "6px 12px 10px", flexShrink: 0 }}>
                      <div style={{ fontSize: 9, color: "#6a6a6a", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>TRIM</div>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 9, color: "#aaa", marginBottom: 3 }}>Start</div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={mobileTop5TrimStartInput}
                            onChange={(e) => {
                              const v = e.target.value;
                              setMobileTop5TrimStartInput(v);
                              const parsed = parseMobileTrimInput(v);
                              if (parsed !== null) setMobileTop5TrimStart(parsed);
                              setMobileTop5TrimError(validateMobileTrim(v, mobileTop5TrimEndInput, video.durationSec));
                            }}
                            onBlur={() => {
                              const parsed = parseMobileTrimInput(mobileTop5TrimStartInput);
                              if (parsed !== null) {
                                setMobileTop5TrimStartInput(formatMobileTrimTime(parsed));
                                setMobileTop5TrimStart(parsed);
                                seekMobileYtEmbed(parsed);
                              }
                              setMobileTop5TrimError(validateMobileTrim(mobileTop5TrimStartInput, mobileTop5TrimEndInput, video.durationSec));
                            }}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 20, padding: "8px 6px", border: `1.5px solid ${mobileTop5TrimError ? "#cc2200" : "#2a2a2a"}`, boxSizing: "border-box", textAlign: "center", background: "#fff" } as React.CSSProperties}
                          />
                        </div>
                        <div style={{ color: "#aaa", fontSize: 18, paddingTop: 22 }}>–</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 9, color: "#aaa", marginBottom: 3 }}>End</div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={mobileTop5TrimEndInput}
                            onChange={(e) => {
                              const v = e.target.value;
                              setMobileTop5TrimEndInput(v);
                              const parsed = parseMobileTrimInput(v);
                              if (parsed !== null) setMobileTop5TrimEnd(parsed);
                              setMobileTop5TrimError(validateMobileTrim(mobileTop5TrimStartInput, v, video.durationSec));
                            }}
                            onBlur={() => {
                              const parsed = parseMobileTrimInput(mobileTop5TrimEndInput);
                              if (parsed !== null) {
                                setMobileTop5TrimEndInput(formatMobileTrimTime(parsed));
                                setMobileTop5TrimEnd(parsed);
                              }
                              setMobileTop5TrimError(validateMobileTrim(mobileTop5TrimStartInput, mobileTop5TrimEndInput, video.durationSec));
                            }}
                            style={{ width: "100%", fontFamily: "monospace", fontSize: 20, padding: "8px 6px", border: `1.5px solid ${mobileTop5TrimError ? "#cc2200" : "#2a2a2a"}`, boxSizing: "border-box", textAlign: "center", background: "#fff" } as React.CSSProperties}
                          />
                        </div>
                      </div>
                      {mobileTop5TrimError && (
                        <div style={{ fontSize: 10, color: "#cc2200", marginTop: 4 }}>{mobileTop5TrimError}</div>
                      )}
                      <div style={{ fontSize: 9, color: "#aaa", textAlign: "right", marginTop: 4 }}>
                        {currentIdx + 1} / {currentResults.length}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", border: "1.5px dashed rgba(42,42,42,0.2)", color: "#6a6a6a", fontSize: 12 }}>
                    No more candidates
                  </div>
                )}
              </div>

              {/* Action buttons (buttons only, no swipe listeners) */}
              <div style={{ display: "flex", gap: 16, padding: "10px 20px", flexShrink: 0, paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}>
                <button
                  onClick={handleMobileReject}
                  disabled={!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null}
                  style={{
                    flex: 1, minHeight: 60, fontSize: 28, background: "#fff", border: "2px solid #2a2a2a",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "3px 3px 0 rgba(42,42,42,0.15)",
                    opacity: (!video || !!mobileTop5CardAnim || mobileTop5LoadingRank !== null) ? 0.4 : 1,
                  }}
                >
                  ✕
                </button>
                <button
                  onClick={handleMobileAccept}
                  disabled={acceptDisabled}
                  style={{
                    flex: 1, minHeight: 60, fontSize: 28, background: ink, color: accent, border: "2px solid #2a2a2a",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "3px 3px 0 rgba(0,0,0,0.3)",
                    opacity: acceptDisabled ? 0.4 : 1,
                  }}
                >
                  ✓
                </button>
              </div>
            </div>
          )}

          {/* ── Screen 4: Build & Done ── */}
          {(mobileTop5Screen === "build" || mobileTop5Screen === "done") && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 32, textAlign: "center" }}>
              {mobileTop5Screen === "build" && (
                <>
                  <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid rgba(42,42,42,0.1)", borderTopColor: ink, animation: "m5spin 0.8s linear infinite" }} />
                  <div>
                    <div style={{ fontFamily: "'Caveat', cursive", fontSize: 24, fontWeight: 700, color: ink, marginBottom: 6 }}>
                      Building your Top {totalRanks}...
                    </div>
                    <div style={{ fontSize: 12, color: "#6a6a6a" }}>{mobileTop5BuildPhase ?? "Preparing..."}</div>
                  </div>
                </>
              )}
              {mobileTop5Screen === "done" && (
                <>
                  <div style={{ fontSize: 56 }}>🏆</div>
                  <div>
                    <div style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: ink, marginBottom: 8 }}>
                      Your Top {totalRanks} is ready!
                    </div>
                    <div style={{ fontSize: 12, color: "#6a6a6a", lineHeight: 1.6 }}>
                      {totalRanks} clips downloaded, labels added, and camera path generated.
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
                    <button
                      onClick={() => { setMobileDesktopOverride(true); setTimeout(() => togglePlay(), 300); }}
                      style={{ ...sketchButton, width: "100%", padding: 16, fontSize: 15, textAlign: "center", background: "#c8f135" }}
                    >
                      ▶ Play Preview
                    </button>
                    <button
                      onClick={() => { setMobileDesktopOverride(true); setTimeout(() => startExport(), 300); }}
                      style={{ ...sketchButton, width: "100%", padding: 16, fontSize: 15, textAlign: "center" }}
                    >
                      ⬇ Export Video
                    </button>
                    <button
                      onClick={() => {
                        setMobileTop5Screen("prompt");
                        setMobileTop5Concept("");
                        setMobileTop5Data(null);
                        setMobileTop5AcceptedByRank(new Map());
                        setMobileTop5ResultsByRank(new Map());
                        setMobileTop5IndexByRank(new Map());
                        setMobileTop5CustomLabels(new Map());
                      }}
                      style={{ fontFamily: "monospace", fontSize: 12, background: "transparent", border: "1.5px solid rgba(42,42,42,0.3)", padding: "10px", cursor: "pointer", color: "#6a6a6a" }}
                    >
                      Start over
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    );
  }

  function removeImagePlaceholder(id: string) {
    setImagePlaceholders((prev) => prev.filter((p) => p.id !== id));
    setImagePreviewTarget((prev) => (prev?.id === id ? null : prev));
  }

  // "Add to Board" on an image placeholder: fetch the full image through /api/proxy-image
  // (server-side, sidesteps browser CORS on arbitrary Google Images sources), turn it into a
  // real image Clip at the placeholder's board position, and drop the placeholder.
  async function commitImagePlaceholder(ph: ImagePlaceholder) {
    setImagePreviewWorking(true);
    setImagePreviewError("");
    const toastId = generateId();
    setDownloadToasts((prev) => [...prev, { id: toastId, title: ph.title, status: "downloading" }]);
    try {
      const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(ph.imageUrl)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Fetch failed (${res.status})`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      loadMedia(blobUrl, "image");
      const img = imgCacheRef.current.get(blobUrl);
      if (img && !img.complete) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        });
      }
      const { w, h } = getMediaDimensions(blobUrl, "image");
      const clipId = generateId();
      setClips((prev) => {
        const endTime = prev.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
        const layer = freeLayerAtTime(prev, endTime, 4, clipId, 1);
        return [...prev, {
          id: clipId, type: "image" as const, name: ph.title.slice(0, 40), sourceUrl: blobUrl,
          startTime: endTime, duration: 4, layer,
          boardX: ph.boardX, boardY: ph.boardY, boardW: w, boardH: h,
        }];
      });
      setSelectedClipId(clipId);
      removeImagePlaceholder(ph.id);
      setImagePreviewTarget(null);

      setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "done" } : t));
      setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 2000);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to add image";
      setImagePreviewError(message);
      setDownloadToasts((prev) => prev.map((t) => t.id === toastId ? { ...t, status: "error", error: message } : t));
      setTimeout(() => setDownloadToasts((prev) => prev.filter((t) => t.id !== toastId)), 5000);
    } finally {
      setImagePreviewWorking(false);
    }
  }

  function openTrimModalForPlaceholder(ph: NeuralPlaceholder) {
    const initEnd = Math.min(30, ph.durationSec || 30);
    setYtSelected({
      id: ph.videoId, title: ph.title, channel: ph.channel, duration: ph.durationSec, thumbnail: ph.thumbnailUrl,
      placeholderId: ph.id, boardX: ph.boardX, boardY: ph.boardY,
    });
    setYtStart(0); setYtStartInput("0:00");
    setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
    ytRangeRef.current = { start: 0, end: initEnd };
    setYtView("trim");
    setYtError("");
    setYtModalOpen(true);
  }

  function setClipSelection(ids: string[]) {
    const unique = Array.from(new Set(ids));
    selectedClipIdsRef.current = unique;
    setSelectedClipIds(unique);
    setSelectedClipId(unique[unique.length - 1] ?? null);
    setSelectedCharActionId(null);
    if (unique.length > 0) setCharacterPanelOpen(false);
    if (unique.length > 0) {
      selectedAnnotationIdsRef.current = [];
      setSelectedAnnotationIds([]);
      setSelectedAnnotationId(null);
    }
  }

  function setAnnotationSelection(ids: string[]) {
    const unique = Array.from(new Set(ids));
    selectedAnnotationIdsRef.current = unique;
    setSelectedAnnotationIds(unique);
    setSelectedAnnotationId(unique[unique.length - 1] ?? null);
    setSelectedCharActionId(null);
    if (unique.length > 0) setCharacterPanelOpen(false);
    if (unique.length > 0) {
      selectedClipIdsRef.current = [];
      setSelectedClipIds([]);
      setSelectedClipId(null);
    }
  }

  function setMixedBoardSelection(clipIds: string[], annotationIds: string[]) {
    const uniqueClipIds = Array.from(new Set(clipIds));
    const uniqueAnnotationIds = Array.from(new Set(annotationIds));
    selectedClipIdsRef.current = uniqueClipIds;
    selectedAnnotationIdsRef.current = uniqueAnnotationIds;
    setSelectedClipIds(uniqueClipIds);
    setSelectedAnnotationIds(uniqueAnnotationIds);
    setSelectedClipId(uniqueClipIds[uniqueClipIds.length - 1] ?? null);
    setSelectedAnnotationId(uniqueAnnotationIds.length > 0 && uniqueClipIds.length === 0 ? uniqueAnnotationIds[uniqueAnnotationIds.length - 1] : null);
    setSelectedCharActionId(null);
    if (uniqueClipIds.length > 0 || uniqueAnnotationIds.length > 0) setCharacterPanelOpen(false);
  }

  function clearBoardSelection() {
    selectedClipIdsRef.current = [];
    selectedAnnotationIdsRef.current = [];
    setSelectedClipIds([]);
    setSelectedAnnotationIds([]);
    setSelectedClipId(null);
    setSelectedAnnotationId(null);
    setSelectedCharActionId(null);
    setRetargetCharActionId(null);
    setCharacterStartPickId(null);
  }

  function selectCharAction(id: string) {
    selectedClipIdsRef.current = [];
    selectedAnnotationIdsRef.current = [];
    setSelectedClipIds([]);
    setSelectedAnnotationIds([]);
    setSelectedClipId(null);
    setSelectedAnnotationId(null);
    selectedCharActionIdRef.current = id;
    setSelectedCharActionId(id);
    setActiveCharacterId(characterActions2Ref.current.some((a) => a.id === id) ? "c2" : "c1");
    setCharacterPanelOpen(true);
  }

  function openCharacterPanel() {
    selectedClipIdsRef.current = [];
    selectedAnnotationIdsRef.current = [];
    setSelectedClipIds([]);
    setSelectedAnnotationIds([]);
    setSelectedClipId(null);
    setSelectedAnnotationId(null);
    setSelectedCharActionId(null);
    selectedCharActionIdRef.current = null;
    setCharacterStartPickId(null);
    setCharacterPanelOpen(true);
    setCharacterToolbarOpen(false);
  }

  function deleteCharacterAction(id: string) {
    if (characterActions2Ref.current.some((a) => a.id === id)) {
      setCharacterActions2((prev) => prev.filter((a) => a.id !== id));
    } else {
      setCharacterActions((prev) => prev.filter((a) => a.id !== id));
    }
    if (selectedCharActionIdRef.current === id) {
      selectedCharActionIdRef.current = null;
      setSelectedCharActionId(null);
    }
    setRetargetCharActionId((prev) => (prev === id ? null : prev));
    setCharActionContextMenu((prev) => (prev?.actionId === id ? null : prev));
  }

  function updateCharacterActionsFor(id: CharacterId, updater: (prev: CharacterAction[]) => CharacterAction[]) {
    if (id === "c2") setCharacterActions2(updater);
    else setCharacterActions(updater);
  }

  function clientToBoardPoint(clientX: number, clientY: number) {
    const rect = boardContainerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current,
      y: (clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current,
    };
  }

  function rectsIntersect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function selectionFromBoardMarquee(marquee: NonNullable<BoardMarquee>) {
    const x = Math.min(marquee.startX, marquee.currentX);
    const y = Math.min(marquee.startY, marquee.currentY);
    const w = Math.abs(marquee.currentX - marquee.startX);
    const h = Math.abs(marquee.currentY - marquee.startY);
    const clipIds = clipsRef.current
      .filter((clip) => clip.boardX !== undefined && clip.boardY !== undefined && clip.boardW !== undefined && clip.boardH !== undefined)
      .filter((clip) => rectsIntersect({ x, y, w, h }, { x: clip.boardX!, y: clip.boardY!, w: clip.boardW!, h: clip.boardH! }))
      .map((clip) => clip.id);
    const annotationIds = annotationsRef.current
      .filter((ann) => rectsIntersect({ x, y, w, h }, { x: ann.boardX, y: ann.boardY, w: ann.boardW, h: ann.boardH }))
      .map((ann) => ann.id);
    return { clipIds, annotationIds };
  }

  function timelinePointFromClient(clientX: number, clientY: number) {
    const rect = scrollerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left + timelineScrollRef.current,
      y: clientY - rect.top,
    };
  }

  function selectedClipIdsInTimelineMarquee(marquee: NonNullable<TimelineMarquee>) {
    const left = Math.min(marquee.startX, marquee.currentX);
    const right = Math.max(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const bottom = Math.max(marquee.startY, marquee.currentY);
    return clipsRef.current
      .filter((clip) => {
        const clipLeft = clip.startTime * pxPerSecRef.current;
        const clipRight = clipLeft + Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSecRef.current);
        const clipTop = clip.type === "narration" ? TRACK_H + 8 : (clip.layer ?? 1) * LAYER_H + 2;
        const clipBottom = clipTop + (clip.type === "narration" ? NARRATION_TRACK_H - 8 : LAYER_H - 4);
        return clipLeft < right && clipRight > left && clipTop < bottom && clipBottom > top;
      })
      .sort((a, b) => a.startTime - b.startTime)
      .map((clip) => clip.id);
  }

  function maxPreviewHeight(): number {
    const boardRect = boardContainerRef.current?.getBoundingClientRect();
    const maxByBoardH = boardRect ? boardRect.height - 42 : window.innerHeight * 0.72;
    const maxByBoardW = boardRect ? (boardRect.width - 28) / previewAspect : window.innerWidth * 0.82 / previewAspect;
    return Math.max(PREVIEW_MIN_H_PX, Math.min(PREVIEW_MAX_H_PX, maxByBoardH, maxByBoardW));
  }

  function clampPreviewHeight(next: number): number {
    return Math.round(clamp(next, PREVIEW_MIN_H_PX, maxPreviewHeight()));
  }

  function handlePreviewResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startH = previewHeight;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nesw-resize";
    const onMove = (ev: PointerEvent) => {
      const byHeight = startH + (ev.clientY - startY);
      const byWidth = startH - (ev.clientX - startX) / previewAspect;
      setPreviewHeight(clampPreviewHeight(Math.max(byHeight, byWidth)));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Board clip drag ────────────────────────────────────────────────────────

  function handleBoardClipPointerDown(e: React.PointerEvent, clip: Clip) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const movingClipIds = selectedClipIdsRef.current.includes(clip.id) ? [...selectedClipIdsRef.current] : [clip.id];
    const movingAnnotationIds = selectedClipIdsRef.current.includes(clip.id) ? [...selectedAnnotationIdsRef.current] : [];
    if (!selectedClipIdsRef.current.includes(clip.id)) setClipSelection([clip.id]);
    const startX = e.clientX, startY = e.clientY;
    const origClips = new Map(
      clipsRef.current
        .filter((c) => movingClipIds.includes(c.id) && c.boardX !== undefined && c.boardY !== undefined)
        .map((c) => [c.id, { x: c.boardX!, y: c.boardY! }])
    );
    const origAnnotations = new Map(
      annotationsRef.current
        .filter((a) => movingAnnotationIds.includes(a.id))
        .map((a) => [a.id, {
          x: a.boardX, y: a.boardY,
          arrowStartX: a.arrowStartX, arrowStartY: a.arrowStartY, arrowEndX: a.arrowEndX, arrowEndY: a.arrowEndY,
          points: a.points ? a.points.map((p) => ({ ...p })) : undefined,
        }])
    );
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      setClips((prev) =>
        prev.map((c) =>
          !movingClipIds.includes(c.id) || !origClips.has(c.id) ? c : {
            ...c,
            boardX: Math.round(origClips.get(c.id)!.x + dx),
            boardY: Math.round(origClips.get(c.id)!.y + dy),
          }
        )
      );
      if (movingAnnotationIds.length > 0) {
        setAnnotations((prev) => prev.map((a) => {
          const orig = origAnnotations.get(a.id);
          if (!orig) return a;
          return {
            ...a,
            boardX: orig.x + dx,
            boardY: orig.y + dy,
            ...(orig.arrowStartX !== undefined ? {
              arrowStartX: orig.arrowStartX + dx,
              arrowStartY: orig.arrowStartY! + dy,
              arrowEndX: orig.arrowEndX! + dx,
              arrowEndY: orig.arrowEndY! + dy,
            } : {}),
            ...(orig.points ? { points: orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
          };
        }));
      }
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Board clip resize ──────────────────────────────────────────────────────

  function handleBoardResizePointerDown(
    e: React.PointerEvent,
    clip: Clip,
    corner: "nw" | "ne" | "sw" | "se"
  ) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const { boardX: ox, boardY: oy, boardW: ow, boardH: oh } = clip;
    if (ox === undefined || oy === undefined || ow === undefined || oh === undefined) return;
    const aspect = ow / oh;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      let nx = ox, ny = oy, nw = ow, nh = oh;
      if (corner === "se") { nw = Math.max(50, ow + dx); nh = nw / aspect; }
      else if (corner === "sw") { nw = Math.max(50, ow - dx); nh = nw / aspect; nx = ox + ow - nw; }
      else if (corner === "ne") { nw = Math.max(50, ow + dx); nh = nw / aspect; ny = oy + oh - nh; }
      else { nw = Math.max(50, ow - dx); nh = nw / aspect; nx = ox + ow - nw; ny = oy + oh - nh; }
      setClips((prev) =>
        prev.map((c) =>
          c.id !== clip.id ? c : {
            ...c, boardX: Math.round(nx), boardY: Math.round(ny), boardW: Math.round(nw), boardH: Math.round(nh),
          }
        )
      );
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Board pan (spacebar + drag) ────────────────────────────────────────────

  function handleBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!isSpaceDownRef.current) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const origPan = { ...boardPanRef.current };
    const onMove = (ev: PointerEvent) => {
      const np = { x: origPan.x + ev.clientX - startX, y: origPan.y + ev.clientY - startY };
      boardPanRef.current = np;
      setBoardPan(np);
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleBoardSurfacePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (isSpaceDownRef.current || annotationToolRef.current !== "pointer") {
      clearBoardSelection();
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = clientToBoardPoint(e.clientX, e.clientY);
    const marquee: NonNullable<BoardMarquee> = { startX: start.x, startY: start.y, currentX: start.x, currentY: start.y };
    boardMarqueeRef.current = marquee;
    boardMarqueeStartClientRef.current = { x: e.clientX, y: e.clientY };
    setBoardMarquee(marquee);
    const onMove = (ev: PointerEvent) => {
      const point = clientToBoardPoint(ev.clientX, ev.clientY);
      const next: NonNullable<BoardMarquee> = { ...marquee, currentX: point.x, currentY: point.y };
      boardMarqueeRef.current = next;
      setBoardMarquee(next);
      const { clipIds, annotationIds } = selectionFromBoardMarquee(next);
      setMixedBoardSelection(clipIds, annotationIds);
    };
    const onUp = (ev: PointerEvent) => {
      const startClient = boardMarqueeStartClientRef.current;
      const moved = startClient ? Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) : 0;
      if (moved < 4) clearBoardSelection();
      else if (boardMarqueeRef.current) {
        const { clipIds, annotationIds } = selectionFromBoardMarquee(boardMarqueeRef.current);
        setMixedBoardSelection(clipIds, annotationIds);
      }
      boardMarqueeRef.current = null;
      boardMarqueeStartClientRef.current = null;
      setBoardMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation helpers ─────────────────────────────────────────────────────

  function deleteAnnotation(id: string) {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedAnnotationIds((prev) => prev.filter((annId) => annId !== id));
    selectedAnnotationIdsRef.current = selectedAnnotationIdsRef.current.filter((annId) => annId !== id);
    setSelectedAnnotationId((prev) => (prev === id ? null : prev));
    setEditingAnnotationId((prev) => (prev === id ? null : prev));
  }

  function commitTextEdit(annId: string) {
    const text = editingAnnotationTextRef.current.trim();
    if (!text) {
      deleteAnnotation(annId);
    } else {
      setAnnotations((prev) => prev.map((a) => (a.id === annId ? { ...a, text } : a)));
      setEditingAnnotationId(null);
    }
  }

  // ─ Annotation drag (pointer tool) ────────────────────────────────────────

  function handleAnnotationPointerDown(e: React.PointerEvent, ann: Annotation) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const movingAnnotationIds = selectedAnnotationIdsRef.current.includes(ann.id) ? [...selectedAnnotationIdsRef.current] : [ann.id];
    const movingClipIds = selectedAnnotationIdsRef.current.includes(ann.id) ? [...selectedClipIdsRef.current] : [];
    if (!selectedAnnotationIdsRef.current.includes(ann.id)) setAnnotationSelection([ann.id]);
    const startX = e.clientX, startY = e.clientY;
    const origAnnotations = new Map(
      annotationsRef.current
        .filter((a) => movingAnnotationIds.includes(a.id))
        .map((a) => [a.id, {
          x: a.boardX, y: a.boardY,
          arrowStartX: a.arrowStartX, arrowStartY: a.arrowStartY, arrowEndX: a.arrowEndX, arrowEndY: a.arrowEndY,
          points: a.points ? a.points.map((p) => ({ ...p })) : undefined,
        }])
    );
    const origClips = new Map(
      clipsRef.current
        .filter((c) => movingClipIds.includes(c.id) && c.boardX !== undefined && c.boardY !== undefined)
        .map((c) => [c.id, { x: c.boardX!, y: c.boardY! }])
    );
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startX) / zoom;
      const dy = (ev.clientY - startY) / zoom;
      setAnnotations((prev) =>
        prev.map((a) => {
          const orig = origAnnotations.get(a.id);
          if (!orig) return a;
          return {
            ...a,
            boardX: orig.x + dx,
            boardY: orig.y + dy,
            ...(orig.arrowStartX !== undefined ? {
              arrowStartX: orig.arrowStartX + dx, arrowStartY: orig.arrowStartY! + dy,
              arrowEndX: orig.arrowEndX! + dx, arrowEndY: orig.arrowEndY! + dy,
            } : {}),
            ...(orig.points ? { points: orig.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
          };
        })
      );
      if (movingClipIds.length > 0) {
        setClips((prev) => prev.map((c) => {
          const orig = origClips.get(c.id);
          return orig ? { ...c, boardX: Math.round(orig.x + dx), boardY: Math.round(orig.y + dy) } : c;
        }));
      }
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation resize ─────────────────────────────────────────────────────

  function handleAnnotationCornerResize(e: React.PointerEvent, ann: Annotation, corner: "nw" | "ne" | "sw" | "se") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { boardX: origX, boardY: origY, boardW: origW, boardH: origH } = ann;
    const origPoints = ann.points ? ann.points.map((p) => ({ ...p })) : undefined;
    const origFontSize = ann.fontSize ?? 120;
    const startClientX = e.clientX, startClientY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startClientX) / zoom;
      const dy = (ev.clientY - startClientY) / zoom;
      let newX = origX, newY = origY, newW = origW, newH = origH;
      if (corner === "se") { newW = Math.max(20, origW + dx); newH = Math.max(20, origH + dy); }
      else if (corner === "sw") { newW = Math.max(20, origW - dx); newH = Math.max(20, origH + dy); newX = origX + origW - newW; }
      else if (corner === "ne") { newW = Math.max(20, origW + dx); newH = Math.max(20, origH - dy); newY = origY + origH - newH; }
      else { newW = Math.max(20, origW - dx); newH = Math.max(20, origH - dy); newX = origX + origW - newW; newY = origY + origH - newH; }
      setAnnotations((prev) => prev.map((a) => {
        if (a.id !== ann.id) return a;
        if (a.type === "pen" && origPoints && origW > 0 && origH > 0) {
          const scaleX = newW / origW, scaleY = newH / origH;
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH,
            points: origPoints.map((p) => ({ x: newX + (p.x - origX) * scaleX, y: newY + (p.y - origY) * scaleY })) };
        }
        if (a.type === "emoji") {
          const newFontSize = Math.max(20, origFontSize * (newW / origW));
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH, fontSize: newFontSize };
        }
        if (a.type === "text") {
          const scale = origW > 0 && origH > 0 ? Math.max(newW / origW, newH / origH) : 1;
          const newFontSize = Math.max(8, origFontSize * scale);
          return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH, fontSize: newFontSize };
        }
        return { ...a, boardX: newX, boardY: newY, boardW: newW, boardH: newH };
      }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleArrowEndpointDrag(e: React.PointerEvent, ann: Annotation, which: "start" | "end") {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const origSX = ann.arrowStartX!, origSY = ann.arrowStartY!;
    const origEX = ann.arrowEndX!, origEY = ann.arrowEndY!;
    const startClientX = e.clientX, startClientY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const zoom = boardZoomRef.current;
      const dx = (ev.clientX - startClientX) / zoom;
      const dy = (ev.clientY - startClientY) / zoom;
      const newSX = which === "start" ? origSX + dx : origSX;
      const newSY = which === "start" ? origSY + dy : origSY;
      const newEX = which === "end" ? origEX + dx : origEX;
      const newEY = which === "end" ? origEY + dy : origEY;
      const minX = Math.min(newSX, newEX), maxX = Math.max(newSX, newEX);
      const minY = Math.min(newSY, newEY), maxY = Math.max(newSY, newEY);
      setAnnotations((prev) => prev.map((a) => a.id !== ann.id ? a : {
        ...a, arrowStartX: newSX, arrowStartY: newSY, arrowEndX: newEX, arrowEndY: newEY,
        boardX: minX, boardY: minY, boardW: Math.max(1, maxX - minX), boardH: Math.max(1, maxY - minY),
      }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Annotation creation (glass pane) ──────────────────────────────────────

  function handleAnnotationGlassPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const container = boardContainerRef.current!;
    const rect = container.getBoundingClientRect();
    const bx = (e.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
    const by = (e.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
    const tool = annotationToolRef.current;

    if (tool === "text") {
      const newAnn: Annotation = {
        id: generateId(), type: "text",
        boardX: bx, boardY: by, boardW: 400, boardH: 100,
        color: annotationColorRef.current,
        text: "", fontFamily: annotationFontRef.current, fontSize: 80, fontWeight: "normal",
      };
      setAnnotations((prev) => [...prev, newAnn]);
      setSelectedAnnotationId(newAnn.id);
      setEditingAnnotationId(newAnn.id);
      setEditingAnnotationText("");
      return;
    }

    if (tool === "emoji") {
      const sz = 120;
      const newAnn: Annotation = {
        id: generateId(), type: "emoji",
        boardX: bx - sz / 2, boardY: by - sz / 2, boardW: sz, boardH: sz,
        color: "#000", emoji: annotationEmojiRef.current, fontSize: sz,
      };
      setAnnotations((prev) => [...prev, newAnn]);
      setSelectedAnnotationId(newAnn.id);
      return;
    }

    if (tool === "pen") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const pts: Array<{ x: number; y: number }> = [{ x: bx, y: by }];
      let lastSampleMs = performance.now();
      const onMove = (ev: PointerEvent) => {
        const now = performance.now();
        if (now - lastSampleMs < 10) return;
        lastSampleMs = now;
        const r = container.getBoundingClientRect();
        const px = (ev.clientX - r.left - boardPanRef.current.x) / boardZoomRef.current;
        const py = (ev.clientY - r.top - boardPanRef.current.y) / boardZoomRef.current;
        pts.push({ x: px, y: py });
        setPenPreviewPoints([...pts]);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setPenPreviewPoints(null);
        if (pts.length < 2) return;
        const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
        const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
        const id = generateId();
        setAnnotations((prev) => [...prev, {
          id, type: "pen", color: annotationColorRef.current, strokeWidth: 4,
          boardX: minX, boardY: minY, boardW: Math.max(1, maxX - minX), boardH: Math.max(1, maxY - minY),
          points: pts,
        }]);
        setSelectedAnnotationId(id);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startBX = bx, startBY = by;
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", onUp);
      const r = container.getBoundingClientRect();
      const ex = (ev.clientX - r.left - boardPanRef.current.x) / boardZoomRef.current;
      const ey = (ev.clientY - r.top - boardPanRef.current.y) / boardZoomRef.current;
      const minBX = Math.min(startBX, ex), maxBX = Math.max(startBX, ex);
      const minBY = Math.min(startBY, ey), maxBY = Math.max(startBY, ey);
      const bw = maxBX - minBX, bh = maxBY - minBY;
      if (bw < 5 && bh < 5) return;
      const t = annotationToolRef.current;
      const id = generateId();
      const color = annotationColorRef.current;
      if (t === "arrow") {
        setAnnotations((prev) => [...prev, {
          id, type: "arrow",
          boardX: minBX, boardY: minBY, boardW: Math.max(1, bw), boardH: Math.max(1, bh),
          color, arrowStartX: startBX, arrowStartY: startBY, arrowEndX: ex, arrowEndY: ey, strokeWidth: 3,
        }]);
      } else if (t === "circle") {
        setAnnotations((prev) => [...prev, {
          id, type: "circle",
          boardX: minBX, boardY: minBY, boardW: Math.max(10, bw), boardH: Math.max(10, bh),
          color, strokeWidth: 3,
        }]);
      } else if (t === "highlight") {
        setAnnotations((prev) => [...prev, {
          id, type: "highlight",
          boardX: minBX, boardY: minBY, boardW: Math.max(10, bw), boardH: Math.max(10, bh),
          color, highlightStyle: annotationHighlightStyleRef.current,
        }]);
      }
    };
    window.addEventListener("pointerup", onUp);
  }

  // ─ Custom zoom box creation (glass pane) ──────────────────────────────────
  // Same click-drag-release rectangle mechanic as the annotation tools above, but produces a
  // Clip (type "customZoom") instead of an Annotation, and auto-disarms draw mode after one box.

  function handleCustomZoomGlassPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const container = boardContainerRef.current!;
    const rect = container.getBoundingClientRect();
    const startBX = (e.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
    const startBY = (e.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setCustomZoomDrawPreview({ startX: startBX, startY: startBY, currentX: startBX, currentY: startBY });
    const onMove = (ev: PointerEvent) => {
      const bx = (ev.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
      const by = (ev.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
      setCustomZoomDrawPreview({ startX: startBX, startY: startBY, currentX: bx, currentY: by });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setCustomZoomDrawPreview(null);
      setCustomZoomDrawMode(false);
      const ex = (ev.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
      const ey = (ev.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
      const minBX = Math.min(startBX, ex), maxBX = Math.max(startBX, ex);
      const minBY = Math.min(startBY, ey), maxBY = Math.max(startBY, ey);
      const bw = maxBX - minBX, bh = maxBY - minBY;
      if (bw < 10 || bh < 10) return;
      addCustomZoomClip(minBX, minBY, bw, bh);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Timeline drag with cursor-anchored magnetic snap ───────────────────────

  function handleClipPointerDown(
    e: React.PointerEvent,
    clip: Clip,
    kind: "move" | "resize-left" | "resize-right"
  ) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!selectedClipIdsRef.current.includes(clip.id)) setClipSelection([clip.id]);
    const rect = scrollerRef.current!.getBoundingClientRect();
    const clickTimeSec = (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
    const cursorOffsetSec = kind === "move" ? clickTimeSec - clip.startTime : 0;
    const origLayer = clip.layer ?? 1;
    timelineDragRef.current = {
      kind, clipId: clip.id,
      origStartTime: clip.startTime, origDuration: clip.duration,
      origLayer,
      cursorOffsetSec,
    };
    const onMove = (ev: PointerEvent) => {
      const drag = timelineDragRef.current;
      if (!drag) return;
      const cursorSec = (ev.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
      const threshold = MAGNETIC_SNAP_PX / pxPerSecRef.current;
      const snapTargets = [0, playheadRef.current, ...allClipEdges(clipsRef.current, drag.clipId)];
      setClips((prev) =>
        prev.map((c) => {
          if (c.id !== drag.clipId) return c;
          if (drag.kind === "move") {
            const rawStart = Math.max(0, cursorSec - drag.cursorOffsetSec);
            const { snapped: snL, target: tL } = magneticSnap(rawStart, snapTargets, threshold);
            const { snapped: snR, target: tR } = magneticSnap(rawStart + drag.origDuration, snapTargets, threshold);
            const newStart = tL !== null ? Math.max(0, snL) : tR !== null ? Math.max(0, snR - drag.origDuration) : rawStart;
            // For non-narration clips: compute target layer from vertical cursor position
            if (c.type !== "narration") {
              const newLayer = clamp(Math.floor((ev.clientY - rect.top) / LAYER_H), 0, N_LAYERS - 1);
              if (!layerOverlap(prev, newStart, drag.origDuration, drag.clipId, newLayer)) {
                return { ...c, startTime: newStart, layer: newLayer };
              }
              // Try same layer if target layer is blocked
              const curLayer = c.layer ?? 1;
              if (!layerOverlap(prev, newStart, drag.origDuration, drag.clipId, curLayer)) {
                return { ...c, startTime: newStart };
              }
              return c; // reject — both positions overlap
            }
            return { ...c, startTime: newStart };
          }
          if (drag.kind === "resize-right") {
            const rawEnd = Math.max(drag.origStartTime + 0.1, cursorSec);
            const { snapped, target } = magneticSnap(rawEnd, snapTargets, threshold);
            let newEnd = target !== null ? Math.max(drag.origStartTime + 0.1, snapped) : rawEnd;
            // Clamp to not overlap next clip in same layer
            if (c.type !== "narration") {
              const layer = c.layer ?? 1;
              const nextInLayer = clipsRef.current
                .filter((cc) => cc.id !== drag.clipId && (cc.layer ?? 1) === layer && cc.type !== "narration" && cc.startTime >= drag.origStartTime)
                .sort((a, b) => a.startTime - b.startTime)[0];
              if (nextInLayer) newEnd = Math.min(newEnd, nextInLayer.startTime);
            }
            return { ...c, duration: Math.max(0.1, newEnd - drag.origStartTime) };
          }
          // resize-left
          const rawStart = clamp(cursorSec, 0, drag.origStartTime + drag.origDuration - 0.1);
          const { snapped, target } = magneticSnap(rawStart, snapTargets, threshold);
          let newStart = target !== null
            ? clamp(snapped, 0, drag.origStartTime + drag.origDuration - 0.1)
            : rawStart;
          // Clamp to not overlap previous clip in same layer
          if (c.type !== "narration") {
            const layer = c.layer ?? 1;
            const prevInLayer = clipsRef.current
              .filter((cc) => cc.id !== drag.clipId && (cc.layer ?? 1) === layer && cc.type !== "narration" && cc.startTime < drag.origStartTime + drag.origDuration)
              .sort((a, b) => b.startTime - a.startTime)[0];
            if (prevInLayer) newStart = Math.max(newStart, prevInLayer.startTime + prevInLayer.duration);
          }
          return {
            ...c,
            startTime: newStart,
            duration: Math.max(0.1, drag.origStartTime + drag.origDuration - newStart),
            ...(c.type === "narration" ? { sourceOffsetSec: (c.sourceOffsetSec ?? 0) + (newStart - drag.origStartTime) } : {}),
          };
        })
      );
    };
    const onUp = () => {
      timelineDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Character action timeline drag ────────────────────────────────────────

  function handleCharActionPointerDown(
    e: React.PointerEvent,
    action: CharacterAction,
    kind: "move" | "resize-left" | "resize-right"
  ) {
    e.stopPropagation();
    const owner: CharacterId = characterActions2Ref.current.some((a) => a.id === action.id) ? "c2" : "c1";
    selectCharAction(action.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = scrollerRef.current!.getBoundingClientRect();
    const clickTimeSec = (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
    const cursorOffsetSec = kind === "move" ? clickTimeSec - action.startTime : 0;
    charActionDragRef.current = {
      kind, actionId: action.id,
      origStartTime: action.startTime, origDuration: action.duration,
      cursorOffsetSec,
    };
    const onMove = (ev: PointerEvent) => {
      const drag = charActionDragRef.current;
      if (!drag) return;
      const cursorSec = (ev.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current;
      updateCharacterActionsFor(owner, (prev) =>
        prev.map((a) => {
          if (a.id !== drag.actionId) return a;
          if (drag.kind === "move") {
            const rawStart = Math.max(0, cursorSec - drag.cursorOffsetSec);
            // No-overlap: don't allow start time to produce overlap with other char actions
            const others = prev.filter((oa) => oa.id !== drag.actionId);
            const overlaps = others.some((oa) => rawStart < oa.startTime + oa.duration && rawStart + drag.origDuration > oa.startTime);
            if (overlaps) return a;
            return { ...a, startTime: rawStart };
          }
          if (drag.kind === "resize-right") {
            const newEnd = Math.max(drag.origStartTime + 0.1, cursorSec);
            return { ...a, duration: Math.max(0.1, newEnd - drag.origStartTime) };
          }
          // resize-left
          const newStart = clamp(cursorSec, 0, drag.origStartTime + drag.origDuration - 0.1);
          return {
            ...a,
            startTime: newStart,
            duration: Math.max(0.1, drag.origStartTime + drag.origDuration - newStart),
          };
        })
      );
    };
    const onUp = () => {
      charActionDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Ruler scrub ────────────────────────────────────────────────────────────

  function handleRulerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    setIsPlaying(false);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const scrub = (clientX: number) => {
      const x = clientX - rect.left + timelineScrollRef.current;
      setPlayhead(Math.max(0, x / pxPerSecRef.current));
    };
    scrub(e.clientX);
    const onMove = (ev: PointerEvent) => scrub(ev.clientX);
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleTimelinePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-clipblock]")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = timelinePointFromClient(e.clientX, e.clientY);
    const marquee: NonNullable<TimelineMarquee> = { startX: start.x, startY: start.y, currentX: start.x, currentY: start.y };
    timelineMarqueeRef.current = marquee;
    timelineMarqueeStartClientRef.current = { x: e.clientX, y: e.clientY };
    setTimelineMarquee(marquee);
    const onMove = (ev: PointerEvent) => {
      const point = timelinePointFromClient(ev.clientX, ev.clientY);
      const next: NonNullable<TimelineMarquee> = { ...marquee, currentX: point.x, currentY: point.y };
      timelineMarqueeRef.current = next;
      setTimelineMarquee(next);
      setClipSelection(selectedClipIdsInTimelineMarquee(next));
    };
    const onUp = (ev: PointerEvent) => {
      const startClient = timelineMarqueeStartClientRef.current;
      const moved = startClient ? Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) : 0;
      if (moved < 4) {
        clearBoardSelection();
        const point = timelinePointFromClient(ev.clientX, ev.clientY);
        setPlayhead(Math.max(0, point.x / pxPerSecRef.current));
        setIsPlaying(false);
      } else if (timelineMarqueeRef.current) {
        setClipSelection(selectedClipIdsInTimelineMarquee(timelineMarqueeRef.current));
      }
      timelineMarqueeRef.current = null;
      timelineMarqueeStartClientRef.current = null;
      setTimelineMarquee(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ Timeline drop ──────────────────────────────────────────────────────────

  function handleTimelineDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const itemId = e.dataTransfer.getData("mediaItemId");
    const item = mediaLibrary.find((m) => m.id === itemId);
    if (!item) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rawStart = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
    const dropLayer = clamp(Math.floor((e.clientY - rect.top) / LAYER_H), 0, N_LAYERS - 1);
    const duration = item.duration ?? (item.type === "video" ? 5 : 4);
    const clipId = generateId();
    loadMedia(item.url, item.type);
    if (item.type === "video") createVideoElement(clipId, item.url);
    const { w, h } = getMediaDimensions(item.url, item.type);
    const { camX, camY } = getVisibleBoardCenter();
    setClips((prev) => {
      const pos = findFreeBoardPos(prev, w, h, camX, camY);
      // Place in drop layer if no overlap; otherwise at end of that layer
      const startTime = layerOverlap(prev, rawStart, duration, clipId, dropLayer)
        ? endOfLayer(prev, dropLayer, clipId)
        : rawStart;
      return [
        ...prev,
        {
          id: clipId, type: item.type, name: item.name, sourceUrl: item.url,
          startTime, duration, layer: dropLayer,
          boardX: pos.boardX, boardY: pos.boardY, boardW: w, boardH: h,
          sourceDurationSec: item.type === "video" ? item.duration : undefined,
        },
      ];
    });
    setSelectedClipId(clipId);
  }

  // ─ Play / pause ───────────────────────────────────────────────────────────

  function togglePlay() {
    if (isPlaying) { setIsPlaying(false); return; }
    const maxEnd = currentPlaybackDuration(clips);
    const wrapped = playheadRef.current >= maxEnd && maxEnd > 0;
    const startPh = wrapped ? 0 : playheadRef.current;
    if (wrapped) setPlayhead(0);
    prevPlayheadRef.current = startPh;

    // Ensure AudioContext exists and is running (user-gesture required for audio unlock)
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioCtxRef.current = ctx; }
    ctx.resume().catch(() => {});

    // Create Web Audio nodes for any video element that doesn't have them yet
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (vid) ensureVideoAudioNodes(clip.id, vid);
    }

    // First-play unlock: every element gets a play() call inside this synchronous click-gesture
    // callback so the browser grants autoplay permission for later programmatic play() calls
    // this session. The promise only pauses clips that the state machine did not keep live.
    const firstPlay = !hasPrewarmedRef.current;
    hasPrewarmedRef.current = true;

    // Unlock video elements once inside the click gesture; the state machine below decides
    // which clips stay active/ambient after these promises settle.
    for (const clip of clipsRef.current) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      const isInRange = !!activeVideoWindow(clip, startPh);
      if (firstPlay && !isInRange) {
        setClipAudioOff(clip.id, vid);
        vid.play().then(() => {
          const state = videoPlaybackStateRef.current.get(clip.id)?.state ?? "dormant";
          if (state !== "ambient" && state !== "active") vid.pause();
        }).catch(() => {});
      }
    }
    evaluateVideoPlaybackStates(startPh, clipsRef.current, cameraKeyframesRef.current, canvasWRef.current, canvasHRef.current, { force: true });
    setIsPlaying(true);
  }

  // ─ Timeline fit ───────────────────────────────────────────────────────────

  function fitTimeline() {
    if (clips.length === 0) { pxPerSecRef.current = DEFAULT_PX_PER_SEC; setPxPerSec(DEFAULT_PX_PER_SEC); return; }
    const total = Math.max(...clips.map((c) => c.startTime + c.duration));
    if (total <= 0) return;
    const containerW = scrollerRef.current?.offsetWidth ?? 800;
    const next = clamp((containerW - 40) / total, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    pxPerSecRef.current = next;
    setPxPerSec(next);
    pendingScrollLeftRef.current = 0;
  }

  // ─ Adaptive ruler ticks ───────────────────────────────────────────────────

  function rulerTicks() {
    const tickSec = pxPerSec > 200 ? 0.5 : pxPerSec >= 100 ? 1 : pxPerSec >= 30 ? 5 : 10;
    const labelSec = pxPerSec > 200 ? 1 : pxPerSec >= 100 ? 5 : pxPerSec >= 30 ? 10 : 30;
    const ticks = [];
    for (let t = 0; t <= timelineDuration + labelSec; t += tickSec) {
      const isLabel = Math.round(t * 1000) % Math.round(labelSec * 1000) === 0;
      ticks.push(
        <div
          key={t.toFixed(3)}
          style={{
            position: "absolute",
            left: t * pxPerSec,
            top: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              width: 1,
              height: isLabel ? "55%" : "25%",
              background: "rgba(42,42,42,0.35)",
              flexShrink: 0,
            }}
          />
          {isLabel && (
            <span
              style={{
                fontSize: 8,
                fontFamily: "monospace",
                color: "#6a6a6a",
                userSelect: "none",
                whiteSpace: "nowrap",
                paddingLeft: 2,
              }}
            >
              {formatTime(t)}
            </span>
          )}
        </div>
      );
    }
    return ticks;
  }

  // ─ Generate camera keyframes ──────────────────────────────────────────────

  function generateCameraKeyframes() {
    if (cameraModeRef.current === "character") {
      if (!showCharacterRef.current) {
        setToast("Enable Character 1 before using character camera mode");
        return;
      }
      if (characterActionsRef.current.length === 0) {
        setToast("Add or generate Character 1 actions first");
        return;
      }

      const duration = characterProjectDuration(characterActionsRef.current);
      const W = canvasWRef.current;
      const H = canvasHRef.current;
      const positionAt = (time: number) => {
        const pose = evalCharAtTime(
          time,
          cameraResolvedCharActions,
          charInit.x,
          charInit.y,
          clipsRef.current,
          authoredAnimationsRef.current,
        );
        return { x: pose.boardX, y: pose.boardY };
      };
      const secondPositionAt = showCharacter2Ref.current
        ? (time: number) => {
            const pose = evalCharAtTime(
              time,
              cameraResolvedCharActions2,
              charInit2.x,
              charInit2.y,
              clipsRef.current,
              authoredAnimationsRef.current,
            );
            return { x: pose.boardX, y: pose.boardY };
          }
        : undefined;
      const newCameraKeyframes = deriveCharacterCameraKeyframes({
        actions: cameraResolvedCharActions,
        clips: clipsRef.current,
        duration,
        canvasW: W,
        canvasH: H,
        boardW: BOARD_W,
        positionAt,
        secondPositionAt,
      }) as CameraKeyframe[];

      setCameraKeyframes(newCameraKeyframes);
      cameraKeyframesRef.current = newCameraKeyframes;
      setCameraKeyframeMode("character");
      cameraKeyframeModeRef.current = "character";
      characterDurationRef.current = duration;
      occupancyWindowsRef.current = deriveOccupancyWindows({
        actions: cameraResolvedCharActions,
        clips: clipsRef.current,
        duration,
        positionAt,
      });
      setKeyframesOutOfDate(false);
      drawFrame(playheadRef.current);
      setToast(`Character camera generated from ${characterActionsRef.current.length} Character 1 action${characterActionsRef.current.length === 1 ? "" : "s"} · ${duration.toFixed(1)}s`);
      return;
    }

    const allClipsSorted = clipsRef.current
      .filter((c) => c.boardX !== undefined || c.type === "pan" || c.type === "characterZoom")
      .sort((a, b) => a.startTime - b.startTime);

    if (allClipsSorted.length === 0) {
      setToast("Place clips on the board first");
      return;
    }

    const boardPlacedClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    const hasBoardClips = boardPlacedClips.length > 0;
    const W = canvasWRef.current;
    const H = canvasHRef.current;

    type Stop = { camX: number; camY: number; zoom: number };

    // Bounding box of all board-placed clips
    const bboxMinX = hasBoardClips ? Math.min(...boardPlacedClips.map((c) => c.boardX!)) : 0;
    const bboxMaxX = hasBoardClips ? Math.max(...boardPlacedClips.map((c) => c.boardX! + c.boardW!)) : BOARD_W;
    const bboxMinY = hasBoardClips ? Math.min(...boardPlacedClips.map((c) => c.boardY!)) : 0;
    const bboxMaxY = hasBoardClips ? Math.max(...boardPlacedClips.map((c) => c.boardY! + c.boardH!)) : BOARD_H;
    const bboxWidth = bboxMaxX - bboxMinX || 1;
    const bboxHeight = bboxMaxY - bboxMinY || 1;
    const bbW = bboxWidth;
    const bbH = bboxHeight;

    // Frame-all stop
    const faSf = (1 - 2 * FRAME_ALL_PADDING) * Math.min(W / bbW, H / bbH);
    const frameAllStop: Stop = {
      camX: (bboxMinX + bboxMaxX) / 2,
      camY: (bboxMinY + bboxMaxY) / 2,
      zoom: faSf * BOARD_W / W,
    };

    // Pan sweep — horizontal math ported from /board's getPanSweepInfo;
    // zoom uses actual canvas dims for correct 90% vertical fill
    const margin = 100;
    const bboxH = bboxMaxY - bboxMinY;
    const panZoom = clamp(bboxH > 0 ? 0.9 * H * BOARD_W / (bboxH * W) : H * BOARD_W / (W * BOARD_H), 0.5, 5.0);
    const halfVW = BOARD_W / (2 * panZoom);
    const panCamY = (bboxMinY + bboxMaxY) / 2;
    const panStartX = clamp(bboxMinX - margin, halfVW, BOARD_W - halfVW);
    const panEndX = clamp(bboxMaxX + margin, halfVW, BOARD_W - halfVW);
    const characterZoomStopAt = (t: number): Stop => {
      const useC2 = activeCharacterIdRef.current === "c2" && showCharacter2Ref.current;
      const enabled = useC2 ? showCharacter2Ref.current : showCharacterRef.current;
      const entranceTime = useC2 ? characterEntranceTime2Ref.current : characterEntranceTimeRef.current;
      if (!enabled || t < entranceTime) {
        console.warn("Character zoom fell back to Frame All: character disabled or not entered yet", { time: t });
        return frameAllStop;
      }
      const pose = evalCharAtTime(
        t,
        useC2 ? resolvedCharActions2Ref.current : resolvedCharActionsRef.current,
        useC2 ? charInit2XRef.current : charInitXRef.current,
        useC2 ? charInit2YRef.current : charInitYRef.current,
        clipsRef.current,
        authoredAnimationsRef.current
      );
      const targetCharHeight = 170;
      const zoom = clamp(0.55 * H * BOARD_W / (W * targetCharHeight), 1.1, 8);
      return { camX: pose.boardX, camY: pose.boardY - 70, zoom };
    };

    // Hold-start stop for each clip (where camera is at the start of the hold phase)
    const holdStartStops: Stop[] = allClipsSorted.map((c) => {
      if (c.type === "pan") {
        return hasBoardClips
          ? { camX: panStartX, camY: panCamY, zoom: panZoom }
          : frameAllStop;
      }
      if (c.type === "characterZoom") return characterZoomStopAt(c.startTime);
      const bw = c.boardW!, bh = c.boardH!;
      const sf = CLIP_FOCUS_RATIO * Math.min(W / bw, H / bh);
      return { camX: c.boardX! + bw / 2, camY: c.boardY! + bh / 2, zoom: sf * BOARD_W / W };
    });
    const allStartStops: Stop[] = [...holdStartStops, frameAllStop];

    type CamEvent = { absTime: number; stop: Stop; easing: 'linear' | 'ease-in-out' };
    const events: CamEvent[] = [];

    for (let i = 0; i < allClipsSorted.length; i++) {
      const c = allClipsSorted[i];
      const hf = c.holdFraction ?? HOLD_FRACTION;
      const holdStart = c.startTime;
      const holdEnd = c.startTime + c.duration * hf;
      const transEnd = c.startTime + c.duration;
      const nextStop = allStartStops[i + 1];

      if (c.type === "pan") {
        if (!hasBoardClips) {
          console.warn(`Pan clip skipped: no board-placed clips`);
          continue;
        }
        // Two keyframes only — linear between them for constant-velocity sweep
        events.push({ absTime: holdStart, stop: { camX: panStartX, camY: panCamY, zoom: panZoom }, easing: 'ease-in-out' });
        events.push({ absTime: holdEnd,   stop: { camX: panEndX,   camY: panCamY, zoom: panZoom }, easing: 'linear' });
        events.push({ absTime: transEnd,  stop: nextStop,                                           easing: 'ease-in-out' });
      } else if (c.type === "characterZoom") {
        events.push({ absTime: holdStart, stop: characterZoomStopAt(holdStart), easing: 'ease-in-out' });
        for (let t = holdStart + 0.25; t < holdEnd - 0.001; t += 0.25) {
          events.push({ absTime: t, stop: characterZoomStopAt(t), easing: 'linear' });
        }
        events.push({ absTime: holdEnd, stop: characterZoomStopAt(holdEnd), easing: 'linear' });
        events.push({ absTime: transEnd, stop: nextStop, easing: 'ease-in-out' });
      } else {
        events.push({ absTime: holdStart, stop: holdStartStops[i], easing: 'ease-in-out' });
        events.push({ absTime: holdEnd,   stop: holdStartStops[i], easing: 'ease-in-out' });
        events.push({ absTime: transEnd,  stop: nextStop,           easing: 'ease-in-out' });
      }
    }

    if (events.length === 0) {
      setToast("No keyframes generated — add board clips or remove pan-only clips");
      return;
    }

    const seen = new Set<number>();
    const newCameraKeyframes: CameraKeyframe[] = [];
    for (const ev of events.sort((a, b) => a.absTime - b.absTime)) {
      const t = Math.round(ev.absTime * 1000);
      if (seen.has(t)) continue;
      seen.add(t);
      newCameraKeyframes.push({
        time: parseFloat(ev.absTime.toFixed(3)),
        cameraX: ev.stop.camX,
        cameraY: ev.stop.camY,
        boardZoom: ev.stop.zoom,
        easing: ev.easing,
      });
    }

    setCameraKeyframes(newCameraKeyframes);
    cameraKeyframesRef.current = newCameraKeyframes;
    setCameraKeyframeMode("clips");
    cameraKeyframeModeRef.current = "clips";
    setKeyframesOutOfDate(false);
    // Character choreography is a useMemo over [clips, cameraKeyframes, ...] (see resolvedCharActions
    // above), so setting cameraKeyframes here automatically re-derives auto actions from the new
    // keyframe order on the very next render — no separate re-sync call needed.
    drawFrame(playheadRef.current);
    const n = allClipsSorted.length;
    setToast(`Camera keyframes generated: ${n} clip${n !== 1 ? "s" : ""} + frame-all — character re-synced`);
  }

  // ─ Divider drag (hold/transition split per clip) ──────────────────────────

  function handleDividerPointerDown(e: React.PointerEvent, clip: Clip) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSecRef.current);
    const innerW = clipPx - HANDLE_W * 2;
    const innerStart = clip.startTime * pxPerSecRef.current + HANDLE_W;
    dividerDragRef.current = { clipId: clip.id, innerStartPx: innerStart, innerWidthPx: innerW };

    const onMove = (ev: PointerEvent) => {
      const drag = dividerDragRef.current;
      if (!drag) return;
      const rect = scrollerRef.current!.getBoundingClientRect();
      const cursorX = ev.clientX - rect.left + timelineScrollRef.current;
      let fraction = clamp((cursorX - drag.innerStartPx) / drag.innerWidthPx, 0.1, 0.95);
      for (const sp of [0.25, 0.5, 0.75]) {
        if (Math.abs(fraction - sp) < 0.05) { fraction = sp; break; }
      }
      const pct = Math.round(fraction * 100);
      setDividerTooltip({ label: `Hold: ${pct}% / Trans: ${100 - pct}%`, x: ev.clientX, y: ev.clientY });
      if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
      setClips((prev) => prev.map((c) => c.id !== drag.clipId ? c : { ...c, holdFraction: fraction }));
    };

    const onUp = () => {
      dividerDragRef.current = null;
      setDividerTooltip(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─ AI annotation generation ────────────────────────────────────────────────

  async function applyAnnotationsFromTranscript(transcript: string): Promise<boolean> {
    setAiPhase("Generating annotations...");
    const boardClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    const sendClips = boardClips.map((c) => ({
      id: c.id,
      type: c.type,
      boardX: c.boardX!,
      boardY: c.boardY!,
      boardW: c.boardW!,
      boardH: c.boardH!,
      ...(c.sourceUrl?.startsWith("http") ? { sourceUrl: c.sourceUrl } : {}),
    }));
    const r = await fetch("/api/board2/generate-annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        board: { width: BOARD_W, height: BOARD_H, backgroundColor: "#f7e5c1" },
        clips: sendClips,
      }),
    }).catch(() => null);
    if (!r) { setAiError("Network error. Try again."); setAiPhase(null); return false; }
    const d = await r.json();
    if (!r.ok) { setAiError(d.error || "Failed to generate annotations"); setAiPhase(null); return false; }
    const raw: Partial<Annotation>[] = Array.isArray(d.annotations) ? d.annotations : [];
    const validTypes = new Set(["text", "arrow", "circle", "highlight", "emoji"]);
    const newAnnotations: Annotation[] = raw
      .filter((a) => a.type && validTypes.has(a.type))
      .map((a) => ({
        id: generateId(),
        type: a.type as Annotation["type"],
        boardX: clamp(Number(a.boardX) || 0, 0, BOARD_W - 1),
        boardY: clamp(Number(a.boardY) || 0, 0, BOARD_H - 1),
        boardW: clamp(Number(a.boardW) || 200, 10, BOARD_W),
        boardH: clamp(Number(a.boardH) || 100, 10, BOARD_H),
        color: typeof a.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : "#cc2200",
        ...(a.text != null ? { text: String(a.text).slice(0, 300) } : {}),
        ...(a.fontFamily != null ? { fontFamily: String(a.fontFamily) } : {}),
        ...(a.fontSize != null ? { fontSize: Number(a.fontSize) } : {}),
        ...(a.fontWeight === "bold" || a.fontWeight === "normal" ? { fontWeight: a.fontWeight } : {}),
        ...(a.arrowStartX != null ? { arrowStartX: clamp(Number(a.arrowStartX), 0, BOARD_W) } : {}),
        ...(a.arrowStartY != null ? { arrowStartY: clamp(Number(a.arrowStartY), 0, BOARD_H) } : {}),
        ...(a.arrowEndX != null ? { arrowEndX: clamp(Number(a.arrowEndX), 0, BOARD_W) } : {}),
        ...(a.arrowEndY != null ? { arrowEndY: clamp(Number(a.arrowEndY), 0, BOARD_H) } : {}),
        ...(a.highlightStyle != null ? { highlightStyle: a.highlightStyle } : {}),
        ...(a.emoji != null ? { emoji: String(a.emoji) } : {}),
      }));
    setAnnotations((prev) => [...prev, ...newAnnotations]);
    setToast(`Generated ${newAnnotations.length} annotation${newAnnotations.length === 1 ? "" : "s"}`);
    setAiPhase(null);
    return true;
  }

  async function handleGenerateAnnotations() {
    const boardClips = clipsRef.current.filter((c) => c.boardX !== undefined);
    if (boardClips.length === 0) return;
    setAiError(null);

    let transcript = aiScriptText.trim();

    if (aiTab === "audio") {
      if (!aiAudioFile) return;
      setAiPhase("Transcribing audio...");
      const fd = new FormData();
      fd.append("audio", aiAudioFile);
      const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
      if (!r) { setAiError("Network error during transcription. Try again."); setAiPhase(null); return; }
      const d = await r.json();
      if (!r.ok) { setAiError(d.error || "Transcription failed"); setAiPhase(null); return; }
      if (!d.transcript?.trim()) { setAiError("Couldn't understand the audio. Try pasting the script instead."); setAiPhase(null); return; }
      transcript = d.transcript;
    }

    const ok = await applyAnnotationsFromTranscript(transcript);
    if (ok) {
      setAiModalOpen(false);
      setAiAudioFile(null);
      setAiScriptText("");
    }
  }

  async function generateAnnotationsFromNarration() {
    const narrationClips = clipsRef.current.filter((c) => c.type === "narration");
    if (narrationClips.length === 0) return;
    if (clipsRef.current.filter((c) => c.boardX !== undefined).length === 0) return;
    setAiError(null);

    let blob: Blob;
    try {
      setAiPhase("Preparing audio...");
      blob = await compileNarrationToBlob(narrationClips);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Failed to compile narration audio");
      setAiPhase(null);
      return;
    }

    if (blob.size > 25 * 1024 * 1024) {
      setAiError("Narration too long — exceeds 25MB. Please split into shorter recordings.");
      setAiPhase(null);
      return;
    }

    setAiPhase("Transcribing...");
    const fd = new FormData();
    fd.append("audio", blob, "narration.wav");
    const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
    if (!r) { setAiError("Network error during transcription. Try again."); setAiPhase(null); return; }
    const d = await r.json();
    if (!r.ok) { setAiError(d.error || "Transcription failed"); setAiPhase(null); return; }
    if (!d.transcript?.trim()) { setAiError("Couldn't understand the narration. Try pasting the script instead."); setAiPhase(null); return; }

    await applyAnnotationsFromTranscript(d.transcript);
  }

  // ─ AI character choreography ────────────────────────────────────────────────

  async function handleGenerateChoreography() {
    const allClips = clipsRef.current;
    const boardClips = allClips.filter((c) => c.boardX !== undefined && (c.type === "image" || c.type === "video"));
    if (boardClips.length === 0) { setChoreoError("Place some clips on the board first"); return; }

    const narrationClips = allClips.filter((c) => c.type === "narration");
    const wantsSync = syncEmotesToNarration && narrationClips.length > 0;
    const direction = characterDirection.trim();
    if (!direction && !wantsSync) {
      setChoreoError("Describe what the character should do, or enable narration sync");
      return;
    }
    setChoreoError(null);

    let transcriptPayload: { text: string; segments: { start: number; end: number; text: string }[] } | undefined;

    if (wantsSync) {
      setChoreoPhase("Transcribing...");
      let blob: Blob;
      try {
        blob = await compileNarrationToBlob(narrationClips);
      } catch (e) {
        setChoreoError(e instanceof Error ? e.message : "Failed to compile narration audio");
        setChoreoPhase(null);
        return;
      }
      if (blob.size > 25 * 1024 * 1024) {
        setChoreoError("Narration too long — exceeds 25MB. Please split into shorter recordings.");
        setChoreoPhase(null);
        return;
      }
      const fd = new FormData();
      fd.append("audio", blob, "narration.wav");
      const r = await fetch("/api/board2/transcribe-audio", { method: "POST", body: fd }).catch(() => null);
      if (!r) { setChoreoError("Network error during transcription. Try again."); setChoreoPhase(null); return; }
      const d = await r.json();
      if (!r.ok) { setChoreoError(d.error || "Transcription failed"); setChoreoPhase(null); return; }
      if (!d.transcript?.trim()) { setChoreoError("Couldn't understand the narration. Try pasting a direction instead."); setChoreoPhase(null); return; }
      // compileNarrationToBlob renders narration clips relative to the first clip's startTime —
      // segment timestamps come back relative to that same origin, so offset them back onto the
      // absolute timeline before they're used to time anything against clip start/holdEnd times.
      const firstStart = [...narrationClips].sort((a, b) => a.startTime - b.startTime)[0].startTime;
      const segments: { start: number; end: number; text: string }[] = Array.isArray(d.segments)
        ? d.segments.map((s: { start: number; end: number; text: string }) => ({
            start: s.start + firstStart, end: s.end + firstStart, text: s.text,
          }))
        : [];
      transcriptPayload = { text: d.transcript, segments };
    }

    setChoreoPhase("Choreographing...");

    const focusClips = [...boardClips].sort((a, b) => a.startTime - b.startTime);
    const cameraFocusOrder = focusClips.map((c) => {
      const hf = c.holdFraction ?? HOLD_FRACTION;
      return {
        clipId: c.id,
        holdStart: c.startTime,
        holdEnd: c.startTime + c.duration * hf,
        transitionEnd: c.startTime + c.duration,
      };
    });
    const timelineClips = focusClips.map((c) => ({
      id: c.id, type: c.type, startTime: c.startTime, duration: c.duration,
      boardX: c.boardX, boardY: c.boardY, boardW: c.boardW, boardH: c.boardH,
      label: c.name,
    }));
    const totalDurationSec = Math.max(0, ...allClips.map((c) => c.startTime + c.duration));

    const r2 = await fetch("/api/board2/character-choreography", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction,
        transcript: transcriptPayload,
        timeline: { totalDurationSec, clips: timelineClips, cameraFocusOrder },
      }),
    }).catch(() => null);
    if (!r2) { setChoreoError("Network error. Try again."); setChoreoPhase(null); return; }
    const d2 = await r2.json();
    if (!r2.ok) { setChoreoError(d2.error || "Failed to generate choreography"); setChoreoPhase(null); return; }

    // Server already dropped unknown types / dangling clip refs and clamped times — this pass
    // turns the raw actions into real CharacterAction objects and re-validates targetClipId
    // against the CURRENT clip set (it could have changed while the request was in flight).
    type RawAction = { type?: string; startTime?: number; duration?: number; targetClipId?: string; emoji?: string; viaSurfaceId?: string };
    const clipIds = new Set(timelineClips.map((c) => c.id));
    const rawActions: RawAction[] = Array.isArray(d2.actions) ? d2.actions : [];
    const cleaned: CharacterAction[] = rawActions
      .filter((a): a is Required<Pick<RawAction, "type">> & RawAction => typeof a.type === "string")
      .filter((a) => {
        if (a.type === "emote") return !!a.emoji;
        if (a.type === "pointAt") return !!a.targetClipId && clipIds.has(a.targetClipId);
        if (actionCanChangeRestPosition(a.type as CharacterAction["type"])) return !!a.targetClipId && clipIds.has(a.targetClipId);
        return !a.targetClipId || clipIds.has(a.targetClipId);
      })
      .map((a) => {
        const startTime = clamp(Number(a.startTime) || 0, 0, totalDurationSec);
        const rawDuration = Number(a.duration) > 0 ? Number(a.duration) : 1.5;
        const duration = clamp(rawDuration, 0.1, Math.max(0.1, totalDurationSec - startTime));
        return {
          id: generateId(),
          type: a.type as CharacterAction["type"],
          startTime, duration,
          ...(a.targetClipId ? { targetClipId: a.targetClipId } : {}),
          ...(a.viaSurfaceId ? { viaSurfaceId: a.viaSurfaceId } : {}),
          ...(a.type === "emote" && a.emoji ? { emoji: a.emoji } : {}),
          aiGenerated: true,
        } as CharacterAction;
      });

    // Regenerate = clean slate for AI actions, but hand-placed ones are never touched. Then
    // enforce no-overlap across the whole character row: later-starting action wins, the one
    // that starts earlier gets truncated to make room (matches the drag/resize invariant that
    // no two blocks on this row ever overlap).
    const targetCharacterId = activeCharacterIdRef.current;
    updateCharacterActionsFor(targetCharacterId, (prev) => {
      const handPlaced = prev.filter((a) => !a.aiGenerated);
      const combined = [...handPlaced, ...cleaned].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < combined.length - 1; i++) {
        const end = combined[i].startTime + combined[i].duration;
        if (end > combined[i + 1].startTime) {
          combined[i] = { ...combined[i], duration: Math.max(0.1, combined[i + 1].startTime - combined[i].startTime) };
        }
      }
      return combined;
    });

    setToast(`Generated ${cleaned.length} choreographed action${cleaned.length === 1 ? "" : "s"}`);
    setChoreoPhase(null);
    setDirectCharacterOpen(false);
  }

  // ─ Export ─────────────────────────────────────────────────────────────────

  function cancelExport() { exportCancelRef.current = true; }

  async function startExport() {
    if (isRecordingRef.current) { setToast("Stop recording before exporting"); return; }
    if (clips.length === 0) { alert("No clips to export"); return; }
    if (isPlayingRef.current) setIsPlaying(false);
    setIsExporting(true); isExportingRef.current = true; exportCancelRef.current = false; setExportProgress(0);
    const currentClips = clipsRef.current;
    const currentCameraKeyframes = cameraKeyframesRef.current;
    const currentAnnotations = annotationsRef.current;
    const exportCameraMode = cameraKeyframeModeRef.current;
    const exportOccupancyWindows = [...occupancyWindowsRef.current];
    const totalDur = currentPlaybackDuration(currentClips);
    const W = canvasWRef.current, H = canvasHRef.current;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = W; exportCanvas.height = H;
    const exportCtx = exportCanvas.getContext("2d")!;
    exportCtx.imageSmoothingEnabled = true;
    exportCtx.imageSmoothingQuality = "high";
    // Silence preview-context gain nodes (export uses its own decodeAudioData audio)
    for (const nodes of videoAudioNodesRef.current.values()) { try { nodes.gainNode.gain.value = 0; } catch {} }
    // Switch off every video element before export starts — same switch model as preview
    for (const clip of currentClips) {
      if (clip.type !== "video") continue;
      const vid = videoElsRef.current.get(clip.id);
      if (!vid) continue;
      vid.loop = false;
      vid.pause();
      vid.currentTime = 0;
    }
    ambientCandidateIdsRef.current = new Set();
    lastAmbientEvalAtRef.current = 0;
    drawableFailureCountRef.current = 0;
    const canvasStream = exportCanvas.captureStream(EXPORT_FPS);
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4" : "video/webm";

    // ── Audio setup (narration + video clips) ────────────────────────────────
    const audioClips = currentClips.filter((c) => c.type === "narration" || c.type === "video");
    let exportAudioCtx: AudioContext | null = null;
    let exportAudioDest: MediaStreamAudioDestinationNode | null = null;
    type AudioItem = { clip: Clip; buffer: AudioBuffer };
    let audioBuffers: AudioItem[] = [];

    if (audioClips.length > 0) {
      exportAudioCtx = new AudioContext();
      exportAudioDest = exportAudioCtx.createMediaStreamDestination();
      const results = await Promise.all(
        audioClips.map(async (clip) => {
          try {
            const ab = await fetch(clip.sourceUrl).then((r) => r.arrayBuffer());
            const buffer = await exportAudioCtx!.decodeAudioData(ab);
            return { clip, buffer } as AudioItem;
          } catch {
            return null; // video with no audio track, unsupported codec, etc.
          }
        })
      );
      audioBuffers = results.filter((x): x is AudioItem => x !== null);
    }

    const exportStream = exportAudioDest
      ? new MediaStream([...canvasStream.getVideoTracks(), ...exportAudioDest.stream.getAudioTracks()])
      : canvasStream;

    const recorder = new MediaRecorder(exportStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      exportAudioCtx?.close().catch(() => {});
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = mimeType === "video/mp4" ? "board2-export.mp4" : "board2-export.webm";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setIsExporting(false); isExportingRef.current = false; setExportProgress(0);
    };
    recorder.start(100);

    // Schedule audio relative to export start (export runs at real-time 1x speed)
    if (exportAudioCtx && exportAudioDest && audioBuffers.length > 0) {
      const exportStartAcTime = exportAudioCtx.currentTime;
      for (const { clip, buffer } of audioBuffers) {
        if (clip.type === "video" && exportCameraMode === "character") {
          for (const window of exportOccupancyWindows.filter((item) => item.clipId === clip.id)) {
            const gainNode = exportAudioCtx.createGain();
            gainNode.gain.value = effectiveClipVolume(clip);
            gainNode.connect(exportAudioDest);
            const bufNode = exportAudioCtx.createBufferSource();
            bufNode.buffer = buffer;
            bufNode.connect(gainNode);
            bufNode.start(exportStartAcTime + window.start);
            bufNode.stop(exportStartAcTime + Math.min(window.end, window.start + buffer.duration));
          }
        } else {
          const gainNode = exportAudioCtx.createGain();
          gainNode.gain.value = effectiveClipVolume(clip);
          gainNode.connect(exportAudioDest);
          const bufNode = exportAudioCtx.createBufferSource();
          bufNode.buffer = buffer;
          bufNode.connect(gainNode);
          if (clip.type === "narration") {
            const offset = Math.min(Math.max(0, clip.sourceOffsetSec ?? 0), Math.max(0, buffer.duration - 0.01));
            bufNode.start(exportStartAcTime + clip.startTime, offset, Math.min(clip.duration, buffer.duration - offset));
          } else {
            bufNode.start(exportStartAcTime + clip.startTime);
          }
          // For video clips, stop at clip end (buffer may be longer than clip.duration)
          if (clip.type === "video") {
            bufNode.stop(exportStartAcTime + clip.startTime + clip.duration);
          }
        }
      }
    }

    // Pauses+resets any video element still active at export end/cancel so the live preview
    // (which shares these elements) doesn't keep rendering a drifting frame afterward.
    function pauseAllExportVideos() {
      for (const clip of currentClips) {
        if (clip.type !== "video") continue;
        const vid = videoElsRef.current.get(clip.id);
        if (vid) pauseAndReset(vid);
        videoRangeStateRef.current.set(clip.id, false);
        const runtime = videoRuntimeFor(clip.id);
        runtime.state = "dormant";
        runtime.reason = "export-ended";
      }
      ambientCandidateIdsRef.current = new Set();
    }

    // eslint-disable-next-line react-hooks/purity
    const exportWallStart = performance.now();
    let prevExportElapsed = -1; // tracks previous frame for entry detection
    function exportFrame() {
      if (exportCancelRef.current) {
        pauseAllExportVideos();
        exportAudioCtx?.close().catch(() => {});
        recorder.stop(); setIsExporting(false); isExportingRef.current = false; setExportProgress(0); return;
      }
      const elapsed = (performance.now() - exportWallStart) / 1000;
      if (elapsed >= totalDur) {
        pauseAllExportVideos();
        recorder.stop(); return;
      }
      setExportProgress(elapsed / totalDur);
      evaluateVideoPlaybackStates(elapsed, currentClips, currentCameraKeyframes, W, H, { force: prevExportElapsed < 0, audioMode: "silent" });
      prevExportElapsed = elapsed;
      renderToCtx(exportCtx, elapsed, currentClips, currentCameraKeyframes, W, H, currentAnnotations);
      exportRafRef.current = requestAnimationFrame(exportFrame);
    }
    exportRafRef.current = requestAnimationFrame(exportFrame);
  }

  // ─ Play Mode / direct character control ───────────────────────────────────

  function playBoardPointFromClient(clientX: number, clientY: number, canvas: HTMLCanvasElement): { rawX: number; rawY: number; x: number; y: number; surface?: RequiredSurfaceClip } | null {
    const rect = canvas.getBoundingClientRect();
    const cam = playCameraRef.current;
    const sf = cam.boardZoom * rect.width / BOARD_W;
    const rawX = (clientX - rect.left - rect.width / 2) / sf + cam.cameraX;
    const rawY = (clientY - rect.top - rect.height / 2) / sf + cam.cameraY;
    const snapped = snapToClipTop(rawX, rawY, clipsRef.current, streamCratersRef.current);
    const surface = clipsRef.current.find((c): c is Clip & RequiredSurfaceClip =>
      isBoardSurface(c) &&
      rawX >= c.boardX &&
      rawX <= c.boardX + c.boardW &&
      rawY >= c.boardY - 180 &&
      rawY <= c.boardY + c.boardH + 80
    );
    return { rawX, rawY, x: snapped.x, y: snapped.y, surface };
  }

  function currentPlayPose(wallMs = performance.now()): CharPoseResult | null {
    const runtime = playActionRuntimeRef.current;
    if (runtime?.enabled && runtime.actions.length > 0) {
      const hasFace = !!(characterFaceRef.current && characterFaceImageRef.current);
      const faceAspect = clamp(characterFaceRef.current?.faceAspect ?? 1, 0.75, 1.6);
      const pose = evalLiveCharacterAtWallTime(runtime, wallMs, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
      runtime.currentPose = pose;
      return pose;
    }
    const state = playPhysicsRef.current;
    return state ? sharedPlayPoseFromPhysics(state, playTimeRef.current) : null;
  }

  function sharedPlayPoseFromPhysics(state: PlayCharacterState, time: number): CharPoseResult {
    const speed = Math.abs(state.vx);
    const moving = state.grounded && speed > 25;
    const faceAspect = clamp(characterFaceRef.current?.faceAspect ?? 1, 0.75, 1.6);
    const hasFace = !!(characterFaceRef.current && characterFaceImageRef.current);
    let sampleTime = 0;
    let resolved: ResolvedCharAction[] = [];

    if (!state.grounded) {
      const airborneAge = Math.max(0, time - (state.airborneAt ?? time));
      const isFlip = Math.abs(state.spin) > 0.08 || speed > PLAY_RUN_SPEED * 0.7;
      const duration = isFlip ? 1.05 : 0.85;
      const progress = clamp(airborneAge / duration, 0, 0.98);
      const type: CharacterAction["type"] = isFlip ? "flip" : "jumpTo";
      playFlipDebugRef.current = isFlip ? { facing: state.facing, rotationDirection: state.facing, travelDx: state.vx } : null;
      sampleTime = progress * duration;
      resolved = [{
        id: "play-physics-air",
        type,
        startTime: 0,
        duration,
        fromX: 0,
        fromY: state.y,
        targetX: state.facing * 520,
        targetY: state.y,
      }];
    } else if (moving) {
      playFlipDebugRef.current = null;
      const duration = 1;
      sampleTime = (((state.stride / (Math.PI * 2)) % 1) + 1) % 1;
      resolved = [{
        id: "play-physics-walk",
        type: "walkTo",
        startTime: 0,
        duration,
        fromX: 0,
        fromY: state.y,
        targetX: state.facing * 220,
        targetY: state.y,
      }];
    } else {
      playFlipDebugRef.current = null;
    }

    const pose = evalCharAtTime(sampleTime, resolved, 0, state.y, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
    const terrain=clipsRef.current.filter(isBoardSurface).map(({id,type,boardX,boardY,boardW,boardH})=>({id:id??"surface",type,boardX,boardY,boardW,boardH})) as TerrainClip[];
    const directGround=groundProfileY(terrain,streamCratersRef.current,state.x),slope=directGround?.slope??0;
    return {
      ...pose,
      boardX: state.x,
      boardY: state.y,
      facing: state.facing,
      bodyLean: pose.bodyLean+clamp(slope*.4,-.12,.12),
      actionType:state.grounded?(moving?"walk":"idle"):"punchThroughFall",
      terrainGrounded:isGrounded({actionType:state.grounded?(moving?"walk":"idle"):"punchThroughFall",explicitGrounded:state.grounded,airY:pose.airY}),
      terrainLeftFootY:(groundProfileY(terrain,streamCratersRef.current,state.x-14)?.y??state.y)-state.y,
      terrainRightFootY:(groundProfileY(terrain,streamCratersRef.current,state.x+14)?.y??state.y)-state.y,
      airY: 0,
      emojiText: state.action === "emote" ? "🤔" : pose.emojiText,
      emojiAlpha: state.action === "emote" ? 1 : pose.emojiAlpha,
    };
  }

  function issuePlayCharacterAction(command: LiveCommandKey, target?: { x: number; y: number; rawX?: number; rawY?: number; surface?: RequiredSurfaceClip }) {
    const state = playPhysicsRef.current;
    if (!state) return;
    const now = performance.now();
    const currentPose = currentPlayPose(now) ?? sharedPlayPoseFromPhysics(state, playTimeRef.current);
    const startX = currentPose.boardX;
    const startY = currentPose.boardY;
    if (command === "stop") {
      playActionRuntimeRef.current = null;
      state.x = startX;
      state.y = resolveGroundY(startX, startY, clipsRef.current, streamCratersRef.current);
      state.vx = 0;
      state.vy = 0;
      state.grounded = true;
      state.surfaceId = findSurfaceAtFeet(state.x, state.y, clipsRef.current)?.id ?? null;
      state.action = "none";
      state.airborneAt = undefined;
      state.grappleX = null;
      state.grappleY = null;
      return;
    }

    let tx = target?.x ?? startX;
    let ty = target?.y ?? startY;
    if (command === "wallClimb" && target?.surface) {
      const left = target.surface.boardX;
      const right = target.surface.boardX + target.surface.boardW;
      tx = Math.abs((target.rawX ?? tx) - left) <= Math.abs((target.rawX ?? tx) - right) ? left : right;
      ty = clamp(target.rawY ?? ty, target.surface.boardY + 60, target.surface.boardY + target.surface.boardH - 30);
    }
    const dist = Math.hypot(tx - startX, ty - startY);
    if (["walkTo", "runTo", "jumpTo", "flip", "grapple", "zipline", "skateTo", "wallClimb"].includes(command) && Math.abs(tx - startX) > 4) {
      state.facing = tx >= startX ? 1 : -1;
    }
    const mk = (type: CharacterAction["type"], duration: number, ax = tx, ay = ty): CharacterAction => ({
      id: generateId(),
      type,
      startTime: 0,
      duration,
      targetX: Math.round(ax),
      targetY: Math.round(ay),
      ...(type === "skateTo" && target?.surface?.id ? { targetClipId: target.surface.id } : {}),
    });
    let action: CharacterAction | null = null;
    if (command === "walkTo" || command === "runTo") {
      const speed = command === "runTo" ? LIVE_RUN_SPEED : LIVE_WALK_SPEED;
      action = mk("walkTo", clamp(dist / speed, 0.25, 4.5));
    } else if (command === "jumpTo") action = mk("jumpTo", clamp(dist / 900, 0.7, 1.6));
    else if (command === "flip") action = mk("flip", clamp(Math.max(260, dist) / 900, 0.8, 1.6), target?.x ?? startX + currentPose.facing * 520, target?.y ?? startY);
    else if (command === "grapple") action = mk("grapple", GRAPPLE_MANUAL_DURATION_SEC);
    else if (command === "zipline") action = mk("zipline", clamp(dist / 650, 0.8, 2.5));
    else if (command === "skateTo") action = mk("skateTo", Math.max(1.2, Math.min(4.5, dist / SKATE_ROLL_SPEED + 0.8)));
    else if (command === "wallClimb") action = mk("wallClimb", clamp(Math.abs(ty - startY) / 350 + 0.8, 0.9, 2.8));
    else if (command === "dance") action = mk("dance", 2.5, startX, startY);
    else if (command === "pullUps") action = mk("pullUps", 4, startX, startY);
    else if (command === "mirrorCheck") action = mk("mirrorCheck", 5, startX, startY);
    else if (command === "sitAndWatch") action = mk("sitAndWatch", 4, startX, startY);
    else if (command === "emote") {
      const previous = playActionRuntimeRef.current;
      const emojiIndex = (previous?.emoteIndex ?? 0) + 1;
      action = { ...mk("emote", 2, startX, startY), emoji: LIVE_EMOTES[(emojiIndex - 1) % LIVE_EMOTES.length] };
    }
    if (!action) return;
    if(action.type==="skateTo"){const plan=buildSkateToPlan({...action,fromX:startX,fromY:startY},clipsRef.current,streamCratersRef.current);if(plan?.terrainAutoOllie)streamDebugLog("terrain auto-ollie host",{gapWidth:plan.terrainGapWidth,popPoint:plan.edgeX,path:"existing-skate-pop-land"});}

    state.x = startX;
    state.y = startY;
    state.vx = 0;
    state.vy = 0;
    state.grounded = true;
    state.surfaceId = findSurfaceAtFeet(startX, startY, clipsRef.current)?.id ?? null;
    state.action = "none";
    state.airborneAt = undefined;
    state.grappleX = null;
    state.grappleY = null;
    const previousRuntime = playActionRuntimeRef.current;
    playActionRuntimeRef.current = {
      enabled: true,
      startWallMs: now,
      initX: startX,
      initY: startY,
      actions: [action],
      currentPose,
      blendFromPose: currentPose,
      blendStartWallMs: now,
      blendDuration: LIVE_BLEND_SEC,
      lastStationaryAction: CHAR_STATIONARY_TARGET_TYPES.has(action.type) ? action : null,
      emoteIndex: command === "emote" ? (previousRuntime?.emoteIndex ?? 0) + 1 : (previousRuntime?.emoteIndex ?? 0),
    };
  }

  function heldPlayTargetCommand(): LiveCommandKey | null {
    if (playHeldKeysRef.current.has("KeyG")) return "grapple";
    if (playHeldKeysRef.current.has("KeyS")) return "skateTo";
    if (playHeldKeysRef.current.has("KeyC")) return "wallClimb";
    if (playHeldKeysRef.current.has("KeyZ")) return "zipline";
    return null;
  }

  function playWeaponOrigin(state: PlayCharacterState): { x: number; y: number } {
    const aim = playCursorRef.current ?? { x: state.x + state.facing * 400, y: state.y - 115 };
    const dx = aim.x - state.x;
    const dy = aim.y - (state.y - 110);
    const len = Math.max(1, Math.hypot(dx, dy));
    return { x: state.x + (dx / len) * 92, y: state.y - 110 + (dy / len) * 92 };
  }

  function guestAtPlayPoint(point: { rawX: number; rawY: number }): GuestCharacterFrame | null {
    let best: { frame: GuestCharacterFrame; d: number } | null = null;
    for (const frame of streamGuestFramesRef.current.values()) {
      if (streamEliminationsRef.current.has(frame.guestId)) continue;
      const dx = point.rawX - frame.position.x;
      const dy = point.rawY - (frame.position.y - 92);
      const d = Math.hypot(dx, dy);
      if (d <= 105 && (!best || d < best.d)) best = { frame, d };
    }
    return best?.frame ?? null;
  }

  function sendForceChokeState(targetGuestId: string, phase: StreamChokeMessage["phase"], position: { x: number; y: number }) {
    const state = playPhysicsRef.current;
    if (!state || !streamSessionIdRef.current) return;
    const startedAt = playForceChokeRef.current?.startedAt ?? performance.now();
    const payload: StreamChokeMessage = {
      kind: "choke_state",
      streamId: STREAM_OWNER_USER_ID,
      sessionId: streamSessionIdRef.current,
      sentAt: Date.now(),
      targetGuestId,
      phase,
      holder: { x: state.x, y: state.y, facing: state.facing },
      position,
      progress: clamp((performance.now() - startedAt) / 1400, 0, 1),
    };
    if (phase === "end") streamChokeStatesRef.current.delete(targetGuestId);
    else streamChokeStatesRef.current.set(targetGuestId, payload);
    streamChannelRef.current?.send({ type: "broadcast", event: "choke_state", payload });
  }

  function updateForceChokeFromPointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const choke = playForceChokeRef.current;
    if (!choke || choke.pointerId !== e.pointerId) return false;
    const point = playBoardPointFromClient(e.clientX, e.clientY, e.currentTarget);
    if (!point) return true;
    choke.position = { x: point.rawX, y: point.rawY + 120 };
    if (performance.now() - choke.lastSentAt > 1000 / STREAM_FPS) {
      choke.lastSentAt = performance.now();
      sendForceChokeState(choke.targetGuestId, "hold", choke.position);
    }
    return true;
  }

  function applyPlayForceChokePose(pose: CharPoseResult): CharPoseResult {
    const choke = playForceChokeRef.current;
    if (!choke) return pose;
    const facing: 1 | -1 = choke.position.x >= pose.boardX ? 1 : -1;
    return {
      ...pose,
      facing,
      bodyLean: pose.bodyLean + 0.08 * facing,
      pointTargetBX: choke.position.x,
      pointTargetBY: choke.position.y - 78,
      forceHandOpen: true,
      leftArmA: facing >= 0 ? 0.42 : pose.leftArmA,
      leftForeA: facing >= 0 ? 0.14 : pose.leftForeA,
      rightArmA: facing < 0 ? -0.42 : pose.rightArmA,
      rightForeA: facing < 0 ? -0.14 : pose.rightForeA,
    };
  }

  function playAimFacing(current: 1 | -1, originX: number, originY: number, aim?: { x: number; y: number } | null): 1 | -1 {
    if (!aim) return current;
    const dx = aim.x - originX;
    const dy = aim.y - originY;
    const dead = Math.tan((8 * Math.PI) / 180) * Math.max(120, Math.abs(dy));
    if (Math.abs(dx) <= dead) return current;
    return dx >= 0 ? 1 : -1;
  }

  function applyPlayWeaponPose(pose: CharPoseResult, state: PlayCharacterState): CharPoseResult {
    const aim = playCursorRef.current ?? { x: state.x + state.facing * 400, y: state.y - 115 };
    const facing = playAimFacing(state.facing, state.x, state.y - 110, aim);
    const aimA = aimAngleFromPoint(pose.boardX, pose.boardY, facing, aim.x, aim.y);
    const firingArmA = clamp(aimA, -1.15, 1.15);
    const supportArmA = clamp(aimA * 0.78 + 0.08, -0.95, 0.95);
    const armedPose: CharPoseResult = {
      ...pose,
      facing,
      hideArms: playBazookaArmedRef.current,
      bodyLean: pose.bodyLean + 0.06 * facing,
      leftLegA: pose.leftLegA + 0.16,
      rightLegA: pose.rightLegA - 0.16,
      leftShinA: (pose.leftShinA ?? pose.leftLegA) + 0.18,
      rightShinA: (pose.rightShinA ?? pose.rightLegA) - 0.18,
    };
    if (facing >= 0) {
      armedPose.rightArmA = firingArmA;
      armedPose.rightForeA = firingArmA;
      armedPose.leftArmA = supportArmA;
      armedPose.leftForeA = supportArmA * 0.75;
    } else {
      armedPose.leftArmA = firingArmA;
      armedPose.leftForeA = firingArmA;
      armedPose.rightArmA = -supportArmA;
      armedPose.rightForeA = -supportArmA * 0.75;
    }
    return armedPose;
  }

  function broadcastWeaponState(force = false) {
    const state = playPhysicsRef.current;
    if (!state || !streamSessionIdRef.current) return;
    const now = Date.now();
    if (!force && now - playWeaponLastStateAtRef.current < 1000 / STREAM_FPS) return;
    playWeaponLastStateAtRef.current = now;
    // Weapon/verb state is authoritative in the sequenced frame stream. Keep this
    // hook for local throttling only so old weapon_state broadcasts cannot linger.
    streamDebugLog("weapon state folded into frame packet", { armed: playWeaponArmedRef.current });
  }

  function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 <= 0.0001 ? 0 : clamp((wx * vx + wy * vy) / len2, 0, 1);
    const x = ax + vx * t;
    const y = ay + vy * t;
    return Math.hypot(px - x, py - y);
  }

  function launchGuestFromWeaponHit(guestId: string, frame: GuestCharacterFrame, shot: PlayWeaponShot) {
    if (!streamSessionIdRef.current || playEliminationKickSentRef.current.has(guestId)) return;
    const host = playPhysicsRef.current;
    if (!host) return;
    const duration = 1.65;
    const launchStartFraction = 0.58;
    const now = Date.now();
    const event: StreamEliminationMessage = {
      kind: "elimination",
      sequenceType: "elimination_tommygun",
      streamId: STREAM_OWNER_USER_ID,
      sessionId: streamSessionIdRef.current,
      sentAt: now,
      startTime: now - launchStartFraction * duration * 1000,
      duration,
      targetGuestId: guestId,
      hostName: session?.user?.name || "Host",
      seed: shot.seed,
      shooter: { x: host.x, y: host.y, facing: shot.dir.x >= 0 ? 1 : -1 },
      target: { x: frame.position.x, y: frame.position.y },
    };
    streamEliminationsRef.current.set(guestId, event);
    streamChannelRef.current?.send({ type: "broadcast", event: "elimination", payload: event });
    streamDebugLog("weapon third hit launch", { guestId, sentAt: now, startTime: event.startTime, t: launchStartFraction });
  }

  function registerWeaponHit(guestId: string, frame: GuestCharacterFrame, shot: PlayWeaponShot) {
    const count = (playWeaponHitCountsRef.current.get(guestId) ?? 0) + 1;
    playWeaponHitCountsRef.current.set(guestId, count);
    const payload: StreamWeaponHitMessage = {
      kind: "hit",
      streamId: STREAM_OWNER_USER_ID,
      sessionId: streamSessionIdRef.current,
      sentAt: Date.now(),
      guestId,
      count,
      origin: shot.origin,
      dir: shot.dir,
    };
    streamChannelRef.current?.send({ type: "broadcast", event: "hit", payload });
    if (count >= 3) launchGuestFromWeaponHit(guestId, frame, shot);
  }

  function firePlayWeaponBurst() {
    const state = playPhysicsRef.current;
    const aim = playCursorRef.current;
    if (!state || !aim || !playWeaponArmedRef.current || !streamSessionIdRef.current) return;
    const now = Date.now();
    if (now - playWeaponLastShotAtRef.current < PLAY_WEAPON_FIRE_INTERVAL_MS) return;
    playWeaponLastShotAtRef.current = now;
    const origin = playWeaponOrigin(state);
    const dx = aim.x - origin.x;
    const dy = aim.y - origin.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const shot: PlayWeaponShot = {
      shotId: generateId(),
      origin,
      dir: { x: dx / len, y: dy / len },
      seed: Math.floor(Math.random() * 1_000_000),
      sentAt: now,
      hitGuestIds: new Set(),
    };
    playWeaponShotsRef.current = [...playWeaponShotsRef.current, shot];
    const payload: StreamShotFiredMessage = {
      kind: "shot_fired",
      streamId: STREAM_OWNER_USER_ID,
      sessionId: streamSessionIdRef.current,
      sentAt: now,
      shotId: shot.shotId,
      origin: shot.origin,
      dir: shot.dir,
      seed: shot.seed,
    };
    streamChannelRef.current?.send({ type: "broadcast", event: "shot_fired", payload });
  }

  function firePlayBazooka() {
    const state=playPhysicsRef.current,cursor=playCursorRef.current;if(!state||!cursor||!playBazookaArmedRef.current||!streamSessionIdRef.current)return;const now=Date.now();if(now-playBazookaLastFireAtRef.current<1200)return;playBazookaLastFireAtRef.current=now;const from=playWeaponOrigin(state),target=rocketRayEnd(from,cursor),seed=Math.floor(Math.random()*1_000_000),clips=rocketTerrainClips(clipsRef.current),impact=raycastSolid(clips,streamCratersRef.current,from,target);const event:StreamBazookaFireMessage={kind:"bazooka_fire",sequenceType:"bazookaFire",streamId:STREAM_OWNER_USER_ID,sessionId:streamSessionIdRef.current,sentAt:now,startTime:now,from,target,seed},visualEvent:BazookaVisualEvent={...event,target:impact?.point??target,fizzle:!impact};playBazookaEventsRef.current=[...playBazookaEventsRef.current,visualEvent].slice(-12);
    if(impact){const clip=clips.find(candidate=>candidate.id===impact.imageId)!;const crater=craterForImpact(clip,impact.point,seed),impactDelay=Math.hypot(impact.point.x-from.x,impact.point.y-from.y)/1100*1000;window.setTimeout(()=>{if(event.startTime<streamRepairAtRef.current)return;streamCratersRef.current=[...streamCratersRef.current.filter(c=>c.clipId!==clip.id),...streamCratersRef.current.filter(c=>c.clipId===clip.id).slice(-23),crater];streamDebugLog("bazooka impact host",impact.point);streamDebugLog("bazooka crater host",crater);const standing=playPhysicsRef.current,profile=standing&&groundProfileY(rocketTerrainClips(clipsRef.current),streamCratersRef.current,standing.x),base=profile&&clipsRef.current.find(c=>c.id===profile.imageId);if(standing&&profile&&base?.boardY!==undefined)streamDebugLog("terrain standing host",{x:standing.x,groundY:profile.y,baseTopY:base.boardY,depth:profile.y-base.boardY,slope:profile.slope});void publishStreamSnapshot();},impactDelay);}else streamDebugLog("bazooka fizzle host",target);
    state.x-=state.facing*12;state.vx-=state.facing*90;streamChannelRef.current?.send({type:"broadcast",event:"bazooka_fire",payload:event});streamDebugLog("bazooka fire host",event);
  }

  function repairBoard(){streamCratersRef.current=[];streamRepairAtRef.current=Date.now();const payload:StreamRepairBoardMessage={kind:"repair_board",streamId:STREAM_OWNER_USER_ID,sessionId:streamSessionIdRef.current,sentAt:streamRepairAtRef.current};streamChannelRef.current?.send({type:"broadcast",event:"repair_board",payload});void publishStreamSnapshot();}

  function updatePlayWeaponShots(nowMs: number, previousNowMs: number) {
    if (playWeaponShotsRef.current.length === 0) return;
    const survivors: PlayWeaponShot[] = [];
    for (const shot of playWeaponShotsRef.current) {
      if (nowMs - shot.sentAt > PLAY_WEAPON_SHOT_LIFETIME_MS) continue;
      const prev = projectilePoint(shot.origin, shot.dir, shot.sentAt, Math.max(shot.sentAt, previousNowMs), STREAM_PROJECTILE_SPEED);
      const curr = projectilePoint(shot.origin, shot.dir, shot.sentAt, nowMs, STREAM_PROJECTILE_SPEED);
      for (const frame of streamGuestFramesRef.current.values()) {
        if (shot.hitGuestIds.has(frame.guestId) || streamEliminationsRef.current.has(frame.guestId)) continue;
        const centerX = frame.position.x;
        const centerY = frame.position.y - 86;
        const d = distancePointToSegment(centerX, centerY, prev.x, prev.y, curr.x, curr.y);
        if (d <= PLAY_WEAPON_HIT_RADIUS) {
          shot.hitGuestIds.add(frame.guestId);
          registerWeaponHit(frame.guestId, frame, shot);
          break;
        }
      }
      survivors.push(shot);
    }
    playWeaponShotsRef.current = survivors;
  }

  function enterPlayMode() {
    editorPlayheadBeforePlayRef.current = playheadRef.current;
    const sourcePose = evalCharAtTime(playheadRef.current, resolvedCharActionsRef.current, charInitXRef.current, charInitYRef.current, clipsRef.current, authoredAnimationsRef.current);
    const startSurface = findSurfaceAtFeet(sourcePose.boardX, sourcePose.boardY, clipsRef.current)
      ?? clipsRef.current.filter((clip): clip is Clip & RequiredSurfaceClip => isBoardSurface(clip)).sort((a, b) => {
        const ax = clampInsideClipX(a, sourcePose.boardX);
        const bx = clampInsideClipX(b, sourcePose.boardX);
        return Math.hypot(ax - sourcePose.boardX, a.boardY - sourcePose.boardY) - Math.hypot(bx - sourcePose.boardX, b.boardY - sourcePose.boardY);
      })[0];
    if (!startSurface) {
      setToast("Add an image or video to the board before entering Play Mode");
      return;
    }
    const startX = clampInsideClipX(startSurface, sourcePose.boardX);
    const startY = startSurface.boardY;
    playPhysicsRef.current = {
      x: startX, y: startY, vx: 0, vy: 0, facing: sourcePose.facing ?? 1,
      grounded: true, surfaceId: startSurface.id ?? null, stride: 0, spin: 0,
      spawnX: startX, spawnY: startY, action: "none", actionUntil: 0, landedAt: -Infinity,
      grappleX: null, grappleY: null, grappleLength: 0,
    };
    playTimeRef.current = 0;
    playWallStartRef.current = 0;
    playCameraRef.current = { cameraX: sourcePose.boardX, cameraY: sourcePose.boardY - 120, boardZoom: 1.35 };
    playActionRuntimeRef.current = null;
    playWeaponShotsRef.current = [];
    playWeaponHitCountsRef.current.clear();
    playEliminationKickSentRef.current.clear();
    setPlayWeaponArmed(false);
    playWeaponArmedRef.current = false;
    setPlayBazookaArmed(false); playBazookaArmedRef.current=false; playBazookaEventsRef.current=[];
    setPlaySceneShot(false);
    setPlayMode(true);
    setIsPlaying(false);
  }

  function exitPlayMode() {
    const choke = playForceChokeRef.current;
    if (choke) {
      sendForceChokeState(choke.targetGuestId, "end", choke.position);
      playForceChokeRef.current = null;
    }
    setPlayMode(false);
    playHeldKeysRef.current.clear();
    playPointerRef.current = null;
    playCursorRef.current = null;
    playPhysicsRef.current = null;
    playActionRuntimeRef.current = null;
    playWeaponShotsRef.current = [];
    setPlayWeaponArmed(false);
    playWeaponArmedRef.current = false;
    setPlayBazookaArmed(false); playBazookaArmedRef.current=false; playBazookaEventsRef.current=[];
    broadcastWeaponState(true);
    setPlayhead(editorPlayheadBeforePlayRef.current);
    playheadRef.current = editorPlayheadBeforePlayRef.current;
    requestAnimationFrame(() => drawFrameRef.current(editorPlayheadBeforePlayRef.current));
  }

  function dismissPlayWheel() { setPlayWheelOpen(false); setPlayWheelMenuOpen(false); }
  async function exitPlayFullscreen() { const doc=document as BoardFullscreenDocument;if(document.fullscreenElement||doc.webkitFullscreenElement){if(document.exitFullscreen)await document.exitFullscreen();else await doc.webkitExitFullscreen?.();}setPlayMaximize(false);setPlayNativeFullscreen(false); }
  async function togglePlayFullscreen() { const doc=document as BoardFullscreenDocument;if(document.fullscreenElement||doc.webkitFullscreenElement||playMaximize){await exitPlayFullscreen();return;}const target=playContainerRef.current as BoardFullscreenElement|null;if(!target)return;if(target.requestFullscreen){await target.requestFullscreen();setPlayNativeFullscreen(true);}else if(target.webkitRequestFullscreen){await target.webkitRequestFullscreen();setPlayNativeFullscreen(true);}else setPlayMaximize(true); }

  function steerPlayCharacter(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const cam = playCameraRef.current;
    const sf = cam.boardZoom * rect.width / BOARD_W;
    const rawX = (clientX - rect.left - rect.width / 2) / sf + cam.cameraX;
    const rawY = (clientY - rect.top - rect.height / 2) / sf + cam.cameraY;
    playCursorRef.current = { x: rawX, y: rawY };
    const state = playPhysicsRef.current;
    if (!state) return;
    const cursorDx = rawX - state.x;
    const cursorDy = rawY - (state.y - PLAY_CHARACTER_HEIGHT * 0.56);
    const cursorDistance = Math.hypot(cursorDx, cursorDy);
    playActionRuntimeRef.current = null;
    const travelSpeed = cursorDistance <= PLAY_WALK_RADIUS_PX ? PLAY_WALK_SPEED : PLAY_RUN_SPEED;
    if (Math.abs(cursorDx) > 18) {
      state.facing = cursorDx >= 0 ? 1 : -1;
      state.vx = state.facing * travelSpeed;
    }
    if (cursorDy < -PLAY_JUMP_CURSOR_PX && state.grounded) {
      const jumpBoost = clamp((-cursorDy - PLAY_JUMP_CURSOR_PX) * 0.45, 0, 170);
      state.vy = -(PLAY_JUMP_SPEED + jumpBoost);
      state.grounded = false;
      state.surfaceId = null;
      state.spin = 0;
      state.airborneAt = playTimeRef.current;
    }
  }

  function handlePlayPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button === 2) return;
    const point = playBoardPointFromClient(e.clientX, e.clientY, e.currentTarget);
    if (point) playCursorRef.current = { x: point.rawX, y: point.rawY };
    if (playBazookaArmedRef.current) { e.preventDefault(); firePlayBazooka(); return; }
    const guest = point ? guestAtPlayPoint(point) : null;
    if (guest) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (playWeaponArmedRef.current || playBazookaArmedRef.current) {
        playWeaponArmedRef.current = false;
        setPlayWeaponArmed(false);
        playBazookaArmedRef.current=false;setPlayBazookaArmed(false);
        playWeaponShotsRef.current = [];
        broadcastWeaponState(true);
      }
      playPointerRef.current = null;
      const position = { x: guest.position.x, y: guest.position.y - 70 };
      playForceChokeRef.current = { pointerId: e.pointerId, targetGuestId: guest.guestId, startedAt: performance.now(), position, lastSentAt: 0 };
      sendForceChokeState(guest.guestId, "hold", position);
      return;
    }
    if (playWeaponArmedRef.current) {
      e.preventDefault();
      firePlayWeaponBurst();
      return;
    }
    const heldCommand = heldPlayTargetCommand();
    if (heldCommand) {
      if (point) {
        e.preventDefault();
        issuePlayCharacterAction(heldCommand, point);
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    // eslint-disable-next-line react-hooks/purity -- event timestamp for live input steering
    playPointerRef.current = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY, down: true, lastSteerAt: performance.now() };
    steerPlayCharacter(e.clientX, e.clientY, e.currentTarget);
  }

  function handlePlayContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
  }

  function handlePlayPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (updateForceChokeFromPointer(e)) return;
    const pointer = playPointerRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const cam = playCameraRef.current;
    const sf = cam.boardZoom * rect.width / BOARD_W;
    playCursorRef.current = {
      x: (e.clientX - rect.left - rect.width / 2) / sf + cam.cameraX,
      y: (e.clientY - rect.top - rect.height / 2) / sf + cam.cameraY,
    };
    if (playWeaponArmedRef.current && (e.buttons & 1) === 1) {
      firePlayWeaponBurst();
      return;
    }
    if (!pointer || pointer.id !== e.pointerId) return;
    pointer.clientX = e.clientX;
    pointer.clientY = e.clientY;
    if (pointer.down && performance.now() - pointer.lastSteerAt >= PLAY_STEER_INTERVAL_MS) {
      pointer.lastSteerAt = performance.now();
      steerPlayCharacter(e.clientX, e.clientY, e.currentTarget);
    }
  }

  function handlePlayPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const choke = playForceChokeRef.current;
    if (choke?.pointerId === e.pointerId) {
      sendForceChokeState(choke.targetGuestId, "drop", choke.position);
      window.setTimeout(() => sendForceChokeState(choke.targetGuestId, "end", choke.position), 900);
      playForceChokeRef.current = null;
      return;
    }
    const pointer = playPointerRef.current;
    if (pointer?.id === e.pointerId) playPointerRef.current = null;
  }

  function applyArmedKeyboardMovement(state: PlayCharacterState) {
    const keys = playHeldKeysRef.current;
    const left = keys.has("KeyA") || keys.has("ArrowLeft");
    const right = keys.has("KeyD") || keys.has("ArrowRight");
    const jump = keys.has("KeyW") || keys.has("ArrowUp");
    const dir = (right ? 1 : 0) - (left ? 1 : 0);
    if (dir !== 0) {
      state.vx = dir * PLAY_WALK_SPEED;
      playActionRuntimeRef.current = null;
    } else if (state.grounded) {
      state.vx *= Math.exp(-0.18);
      if (Math.abs(state.vx) < 6) state.vx = 0;
    }
    if (jump && state.grounded) {
      state.vy = -PLAY_JUMP_SPEED;
      state.grounded = false;
      state.surfaceId = null;
      state.spin = 0;
      state.airborneAt = playTimeRef.current;
      playActionRuntimeRef.current = null;
    }
  }

  function updatePlayPhysics(state: PlayCharacterState, dt: number, canvas: HTMLCanvasElement) {
    const surfaces = clipsRef.current.filter((clip): clip is Clip & RequiredSurfaceClip => isBoardSurface(clip));
    const terrain = surfaces.map(({id,type,boardX,boardY,boardW,boardH})=>({id,type,boardX,boardY,boardW,boardH})) as TerrainClip[];
    if (state.action !== "none" && playTimeRef.current >= state.actionUntil) state.action = "none";
    if(playBazookaArmedRef.current){const keys=playHeldKeysRef.current;if(keys.has("KeyA")){state.vx=-PLAY_WALK_SPEED;state.facing=-1;}else if(keys.has("KeyD")){state.vx=PLAY_WALK_SPEED;state.facing=1;}if(keys.has("KeyW")&&state.grounded){state.vy=-PLAY_JUMP_SPEED;state.grounded=false;state.surfaceId=null;}if(keys.has("KeyS"))state.vx*=.6;}
    const pointer = playPointerRef.current;
    if (playWeaponArmedRef.current && state.action === "none") {
      applyArmedKeyboardMovement(state);
    } else if (pointer?.down && state.action === "none") {
      steerPlayCharacter(pointer.clientX, pointer.clientY, canvas);
    } else if (state.grounded && state.action === "none") {
      state.vx *= Math.exp(-dt * 11);
      if (Math.abs(state.vx) < 5) state.vx = 0;
    }

    if (state.action === "pullups") {
      state.vx = 0;
      state.vy = 0;
      return;
    }

    if (state.grounded) {
      const ground = groundProfileY(terrain,streamCratersRef.current,state.x);
      if (!ground||(state.surfaceId!==null&&ground.imageId!==state.surfaceId&&ground.y>state.y+8)) {
        state.grounded = false;
        state.surfaceId = null;
        state.vy = 35;
        state.airborneAt = playTimeRef.current;
        streamDebugLog("terrain fall host",{x:state.x,fromY:state.y});
      } else {
        state.y=lerp(state.y,ground.y,1-Math.exp(-dt*14));
        state.surfaceId=ground.imageId;
      }
    }

    if(state.grounded&&Math.abs(state.vx)>1){const direction=state.vx>0?1:-1,nextX=state.x+state.vx*dt;if(!groundProfileY(terrain,streamCratersRef.current,nextX)){let landingX:number|undefined;for(let d=6;d<=120;d+=6){if(groundProfileY(terrain,streamCratersRef.current,nextX+direction*d)){landingX=nextX+direction*d;break;}}if(landingX!==undefined){state.grounded=false;state.surfaceId=null;state.vy=-PLAY_JUMP_SPEED*.62;state.airborneAt=playTimeRef.current;streamDebugLog("terrain auto-jump host",{gapWidth:Math.abs(landingX-nextX),popPoint:state.x});}else{state.vx=0;streamDebugLog("terrain stop at lip host",{x:state.x});}}}
    const previousY = state.y;
    state.x += state.vx * dt;
    if (!state.grounded) {
      state.vy = Math.min(PLAY_MAX_FALL_SPEED, state.vy + PLAY_GRAVITY * dt);
      if (state.grappleX !== null && state.grappleY !== null) {
        const dx = state.grappleX - state.x;
        const dy = state.grappleY - (state.y - 90);
        const distance = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / distance;
        const uy = dy / distance;
        const pull = clamp((distance - state.grappleLength) * 8, 0, 1800);
        state.vx += ux * pull * dt;
        state.vy += uy * pull * dt;
        if (distance > state.grappleLength) {
          const radialSpeed = state.vx * ux + state.vy * uy;
          if (radialSpeed < 0) {
            state.vx -= ux * radialSpeed * 0.72;
            state.vy -= uy * radialSpeed * 0.72;
          }
        }
        state.facing = dx >= 0 ? 1 : -1;
      }
      const nextY = state.y + state.vy * dt;
      if (state.vy >= 0) {
        const landing=groundProfileY(terrain,streamCratersRef.current,state.x);
        if (landing&&previousY<=landing.y&&nextY>=landing.y) {
          state.y = landing.y;
          state.vy = 0;
          state.grounded = true;
          state.surfaceId = landing.imageId;
          streamDebugLog("terrain landing host",{x:state.x,groundY:landing.y,slope:landing.slope});
          state.spin = 0;
          state.airborneAt = undefined;
          state.landedAt = playTimeRef.current;
        } else {
          state.y = nextY;
        }
      } else {
        state.y = nextY;
      }
      if (Math.abs(state.vx) > 520) state.spin += state.facing * dt * 6.2;
    }

    state.stride += (Math.abs(state.vx) * dt / PLAY_WALK_CYCLE_PX) * Math.PI * 2;
    const lowestSurfaceBottom = surfaces.length > 0
      ? Math.max(...surfaces.map((surface) => surface.boardY + surface.boardH))
      : state.spawnY;
    if (state.y > lowestSurfaceBottom + PLAY_RESPAWN_BELOW_LOWEST_SURFACE) {
      state.x = state.spawnX;
      state.y = state.spawnY;
      state.vx = 0;
      state.vy = 0;
      state.grounded = true;
      state.surfaceId = findSurfaceAtFeet(state.spawnX, state.spawnY, surfaces)?.id ?? null;
      state.spin = 0;
      state.airborneAt = undefined;
      state.action = "none";
      state.landedAt = playTimeRef.current;
      state.grappleX = null;
      state.grappleY = null;
      playCameraRef.current.cameraX = state.spawnX;
      playCameraRef.current.cameraY = state.spawnY - 120;
    }
  }

  useEffect(() => {
    if (!playMode) return;
    const resize = () => setPlayViewport({ width: Math.max(1, Math.round(window.innerWidth * Math.min(2, window.devicePixelRatio || 1))), height: Math.max(1, Math.round(window.innerHeight * Math.min(2, window.devicePixelRatio || 1))) });
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;
    let last = 0;
    const frame = (wall: number) => {
      const canvas = playCanvasRef.current;
      if (!canvas) return;
      if (playWallStartRef.current === 0) playWallStartRef.current = wall;
      const dt = last === 0 ? 0 : Math.min(0.05, (wall - last) / 1000);
      last = wall;
      const now = (wall - playWallStartRef.current) / 1000;
      playTimeRef.current = now;
      const nowMs = Date.now();
      const previousNowMs = nowMs - dt * 1000;
      const state = playPhysicsRef.current;
      if (!state) return;
      let playPose: CharPoseResult;
      let playDrawTime = now;
      let playDrawResolved: ResolvedCharAction[] = [];
      const runtime = playActionRuntimeRef.current;
      if (runtime?.enabled && runtime.actions.length > 0) {
        const hasFace = !!(characterFaceRef.current && characterFaceImageRef.current);
        const faceAspect = clamp(characterFaceRef.current?.faceAspect ?? 1, 0.75, 1.6);
        playPose = evalLiveCharacterAtWallTime(runtime, wall, clipsRef.current, authoredAnimationsRef.current, hasFace, faceAspect, streamCratersRef.current);
        runtime.currentPose = playPose;
        playDrawTime = liveRuntimeSeconds(runtime, wall);
        playDrawResolved = liveResolvedActions(runtime, clipsRef.current, streamCratersRef.current);
        state.x = playPose.boardX;
        state.y = playPose.boardY;
        state.facing = playPose.facing;
        state.vx = 0;
        state.vy = 0;
        state.grounded = isGrounded({actionType:playPose.actionType??"idle",explicitGrounded:playPose.terrainGrounded,airY:playPose.airY,skateAirborne:playPose.skateFootMode==="air",grappleAirborne:!!playPose.grappleRopeAlpha});
        state.surfaceId = findSurfaceAtFeet(state.x, resolveGroundY(state.x, state.y, clipsRef.current, streamCratersRef.current), clipsRef.current)?.id ?? null;
        const lastAction = playDrawResolved[playDrawResolved.length - 1];
        if (lastAction && playDrawTime > lastAction.startTime + lastAction.duration + LIVE_BLEND_SEC) {
          state.x = playPose.boardX;
          state.y = resolveGroundY(playPose.boardX, playPose.boardY, clipsRef.current, streamCratersRef.current);
          state.grounded = true;
          state.surfaceId = findSurfaceAtFeet(state.x, state.y, clipsRef.current)?.id ?? null;
          playActionRuntimeRef.current = null;
          playDrawResolved = [];
          playDrawTime = now;
        }
      } else {
        updatePlayPhysics(state, dt, canvas);
        playPose = sharedPlayPoseFromPhysics(state, now);
      }
      updatePlayWeaponShots(nowMs, previousNowMs);
      if (playWeaponArmedRef.current || playBazookaArmedRef.current) {
        const aim = playCursorRef.current ?? { x: state.x + state.facing * 400, y: state.y - 115 };
        state.facing = playAimFacing(state.facing, state.x, state.y - 110, aim);
        playPose = applyPlayWeaponPose(playPose, state);
      }
      playPose = applyPlayForceChokePose(playPose);
      const shot = interpolateCameraKeyframes(cameraKeyframesRef.current, editorPlayheadBeforePlayRef.current);
      const target = playSceneShot ? shot : { cameraX: playPose.boardX, cameraY: playPose.boardY - 120, boardZoom: playCameraRef.current.boardZoom };
      const follow = 1 - Math.exp(-dt * 5.5);
      playCameraRef.current = { cameraX: lerp(playCameraRef.current.cameraX, target.cameraX, follow), cameraY: lerp(playCameraRef.current.cameraY, target.cameraY, follow), boardZoom: lerp(playCameraRef.current.boardZoom, target.boardZoom, playSceneShot ? follow : follow * 0.08) };
      evaluateVideoPlaybackStates(editorPlayheadBeforePlayRef.current, clipsRef.current, cameraKeyframesRef.current, canvas.width, canvas.height, { audioMode: "preview" });
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const shake=bazookaShake(playBazookaEventsRef.current,nowMs);ctx.save();ctx.translate(shake.x,shake.y);
        renderToCtx(ctx, now, clipsRef.current, cameraKeyframesRef.current, canvas.width, canvas.height, annotationsRef.current, playCameraRef.current);
        const sf = playCameraRef.current.boardZoom * canvas.width / BOARD_W;
        drawPlaySpawnDoor(ctx, state, playCameraRef.current, sf, canvas.width, canvas.height);
        CharacterEntity.drawBoardCharacterToCanvas(
          ctx,
          playDrawTime,
          playDrawResolved,
          true,
          playCameraRef.current,
          sf,
          canvas.width,
          canvas.height,
          playPose.boardX,
          playPose.boardY,
          clipsRef.current,
          -Infinity,
          authoredAnimationsRef.current,
          characterFaceRef.current && characterFaceImageRef.current
            ? { image: characterFaceImageRef.current, aspect: characterFaceRef.current.faceAspect, mouthAnchor: characterFaceRef.current.mouthAnchor }
            : null,
          characterSkinRef.current,
          { ...playPose, viseme: resolvedCharacterViseme("c1", now, clipsRef.current, playDrawResolved) },
          boardCharacterDrawEvaluators()
        );
        for (const shot of playWeaponShotsRef.current) {
          drawWeaponProjectile(ctx, shot, playCameraRef.current, sf, canvas.width, canvas.height, nowMs);
        }
        if (playWeaponArmedRef.current) {
          const recoilAge = nowMs - playWeaponLastShotAtRef.current;
          const recoil = recoilAge < 140 ? Math.sin((1 - recoilAge / 140) * Math.PI) * 3 : 0;
          drawTommyGunHeld(
            ctx,
            { x: state.x, y: state.y, facing: state.facing },
            playCursorRef.current ?? { x: state.x + state.facing * 400, y: state.y - 115 },
            playCameraRef.current,
            sf,
            canvas.width,
            canvas.height,
            recoil,
          );
        }
        if(playBazookaArmedRef.current){const recoilAge=nowMs-playBazookaLastFireAtRef.current,recoil=recoilAge<260?Math.sin((1-recoilAge/260)*Math.PI)*9:0;drawBazookaHeld(ctx,{x:state.x,y:state.y,facing:state.facing},playCursorRef.current??{x:state.x+state.facing*400,y:state.y-115},playCameraRef.current,sf,canvas.width,canvas.height,recoil);}
        for(const event of playBazookaEventsRef.current)drawBazookaEffect(ctx,event,playCameraRef.current,sf,canvas.width,canvas.height,nowMs);
        drawStreamGuestsToCtx(ctx, playCameraRef.current, sf, canvas.width, canvas.height);
        ctx.restore();
      }
      broadcastWeaponState();
      publishStreamFrame(wall);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, [playMode, playSceneShot, drawStreamGuestsToCtx, publishStreamFrame, renderToCtx]);

  // ─ Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
	      const tag = (e.target as HTMLElement).tagName;
	      const inInput = tag === "INPUT" || tag === "TEXTAREA";
	      if (playModeRef.current && !inInput) {
	        if (playOverlayInputActiveRef.current) {
	          if (e.code === "Escape") {
	            e.preventDefault();
	            setPlayAddMenuOpen(false);
	            setYtModalOpen(false);
	          }
	          return;
	        }
	        if (e.code === "Escape") { e.preventDefault(); exitPlayMode(); return; }
	        playHeldKeysRef.current.add(e.code);
        if (e.repeat) return;
        if (e.code === "KeyQ") {
          e.preventDefault();
          if(playBazookaArmedRef.current){playBazookaArmedRef.current=false;setPlayBazookaArmed(false);return;}
          setPlayWeaponArmed((armed) => {
            const next = !armed;
            playWeaponArmedRef.current = next;
            if (!next) playWeaponShotsRef.current = [];
            setTimeout(() => broadcastWeaponState(true), 0);
            return next;
          });
          return;
        }
        if (e.code === "KeyV") { e.preventDefault(); setPlaySceneShot((v) => !v); return; }
        if (playWeaponArmedRef.current && ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(e.code)) {
          e.preventDefault();
          return;
        }
        if(playBazookaArmedRef.current&&["KeyW","KeyA","KeyS","KeyD"].includes(e.code)){e.preventDefault();return;}
        if (["KeyG", "KeyS", "KeyC", "KeyZ"].includes(e.code)) { e.preventDefault(); return; }
        if (e.code === "KeyD") { e.preventDefault(); issuePlayCharacterAction("dance"); return; }
        if (e.code === "KeyF") {
          e.preventDefault();
          const pose = currentPlayPose();
          if (pose) issuePlayCharacterAction("flip", { x: pose.boardX + pose.facing * 520, y: pose.boardY });
          return;
        }
        if (e.code === "KeyJ") {
          e.preventDefault();
          const pose = currentPlayPose();
          if (pose) issuePlayCharacterAction("jumpTo", { x: pose.boardX + pose.facing * 320, y: pose.boardY });
          return;
        }
        if (e.code === "KeyM") { e.preventDefault(); issuePlayCharacterAction("mirrorCheck"); return; }
        if (e.code === "KeyP") { e.preventDefault(); issuePlayCharacterAction("pullUps"); return; }
        if (e.code === "KeyE") { e.preventDefault(); issuePlayCharacterAction("emote"); return; }
        if (e.code === "KeyT") { e.preventDefault(); issuePlayCharacterAction("sitAndWatch"); return; }
        if (e.code === "KeyX") { e.preventDefault(); issuePlayCharacterAction("stop"); return; }
        return;
      }
      if (e.code === "Space") {
        isSpaceDownRef.current = true;
        setIsSpaceDown(true);
        if (boardContainerRef.current) boardContainerRef.current.style.cursor = "grab";
        if (!inInput) {
          e.preventDefault();
          if (!e.repeat) togglePlay();
        }
        return;
      }
      if (inInput) return;
      if (e.code === "Delete" || e.code === "Backspace") {
        const clipIds = selectedClipIdsRef.current.length > 0 ? selectedClipIdsRef.current : selectedClipId ? [selectedClipId] : [];
        const annotationIds = selectedAnnotationIdsRef.current.length > 0 ? selectedAnnotationIdsRef.current : selectedAnnotationId ? [selectedAnnotationId] : [];
        const charActionId = selectedCharActionIdRef.current;
        if (clipIds.length > 0) {
          e.preventDefault();
          clipIds.forEach((id) => deleteClip(id));
          selectedClipIdsRef.current = [];
          setSelectedClipIds([]);
          setSelectedClipId(null);
        } else if (annotationIds.length > 0) {
          e.preventDefault();
          setAnnotations((prev) => prev.filter((ann) => !annotationIds.includes(ann.id)));
          selectedAnnotationIdsRef.current = [];
          setSelectedAnnotationIds([]);
          setSelectedAnnotationId(null);
        } else if (charActionId) {
          e.preventDefault();
          deleteCharacterAction(charActionId);
        }
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.code === "KeyC" && selectedClipId) {
        e.preventDefault();
        copyClip(selectedClipId);
      }
      if (meta && e.code === "KeyV" && clipboardRef.current) {
        e.preventDefault();
        pasteClip();
      }
      if (meta && e.code === "KeyD" && selectedClipId) {
        e.preventDefault();
        duplicateClip(selectedClipId);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      playHeldKeysRef.current.delete(e.code);
      if (e.code === "Space") {
        isSpaceDownRef.current = false;
        setIsSpaceDown(false);
        if (boardContainerRef.current) boardContainerRef.current.style.cursor = "default";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  // ─ Clipboard image paste ──────────────────────────────────────────────────
  // Separate from the Step 16.4 clip clipboard above (clipboardRef + the keydown KeyV handler,
  // which pastes internally-copied clips). This listens for the native "paste" event and only
  // acts when the OS clipboard actually contains image data — anything else (text paste in an
  // input, the clip clipboard's own Cmd+V) falls through untouched since we never call
  // preventDefault unless an image item is found.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if (inInput) return;
      const anyModalOpen = ytModalOpen || neuralModalOpen || top5ModalOpen || saveModalOpen ||
        aiModalOpen || directCharacterOpen || !!imagePreviewTarget;
      if (anyModalOpen) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      (async () => {
        let pastedCount = 0;
        for (const item of imageItems) {
          const blob = item.getAsFile();
          if (!blob) continue;
          if (blob.size > MAX_PASTED_IMAGE_BYTES) {
            setToast("Image too large to paste (max 15MB)");
            continue;
          }
          const ext = item.type.split("/")[1] || "png";
          await ingestMediaFile(blob, `Pasted image ${Date.now()}.${ext}`);
          pastedCount++;
        }
        if (pastedCount > 0) setToast("Image pasted");
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ─ Context menu dismiss ───────────────────────────────────────────────────

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!charActionContextMenu) return;
    const dismiss = () => setCharActionContextMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    window.addEventListener("keydown", dismiss, { once: true });
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [charActionContextMenu]);

  // ─── Mobile gesture handlers ──────────────────────────────────────────────

  function handleMobileBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const g = mobileGestureRef.current;

    if (pointers.size === 2) {
      if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      g.type = "pinch";
      g.pinchStartDist = Math.max(dist, 1);
      g.pinchStartZoom = boardZoomRef.current;
      g.pinchStartPan = { ...boardPanRef.current };
      return;
    }

    const target = e.target as HTMLElement;
    const clipEl = target.closest("[data-mbclipid]");
    const hitClipId = clipEl ? (clipEl as HTMLElement).dataset.mbclipid ?? null : null;

    g.type = "deciding";
    g.hitClipId = hitClipId;
    g.hitClipIsSelected = hitClipId !== null && hitClipId === selectedClipId;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.origPan = { ...boardPanRef.current };

    if (hitClipId) {
      const clip = clipsRef.current.find((c) => c.id === hitClipId);
      if (clip?.boardX !== undefined) { g.clipOrigX = clip.boardX; g.clipOrigY = clip.boardY ?? 0; }
    }

    g.longPressTimer = setTimeout(() => {
      if (g.type === "deciding" && g.hitClipId) {
        g.type = "idle";
        setMobileLongPressClipId(g.hitClipId);
      }
    }, 500);
  }

  function handleMobileBoardPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = mobileGestureRef.current;

    if (g.type === "pinch" && pointers.size === 2) {
      const pts = [...pointers.values()];
      const container = boardContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const scale = dist / g.pinchStartDist;
      const nz = Math.max(0.05, Math.min(3, g.pinchStartZoom * scale));
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const pz = g.pinchStartZoom;
      const pp = g.pinchStartPan;
      const np = { x: cx - (cx - pp.x) * (nz / pz), y: cy - (cy - pp.y) * (nz / pz) };
      boardZoomRef.current = nz;
      boardPanRef.current = np;
      setBoardZoom(nz);
      setBoardPan(np);
      return;
    }

    if (g.type === "deciding") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.hypot(dx, dy) >= 8) {
        if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }
        g.type = g.hitClipIsSelected ? "move" : "pan";
      }
    }

    if (g.type === "pan") {
      const np = { x: g.origPan.x + e.clientX - g.startX, y: g.origPan.y + e.clientY - g.startY };
      boardPanRef.current = np;
      setBoardPan(np);
    } else if (g.type === "move" && g.hitClipId) {
      const zoom = boardZoomRef.current;
      const dx = (e.clientX - g.startX) / zoom;
      const dy = (e.clientY - g.startY) / zoom;
      setClips((prev) => prev.map((c) => c.id !== g.hitClipId ? c : {
        ...c, boardX: Math.round(g.clipOrigX + dx), boardY: Math.round(g.clipOrigY + dy),
      }));
    }
  }

  function handleMobileBoardPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const pointers = mobileBoardPointersRef.current;
    const g = mobileGestureRef.current;
    if (g.longPressTimer) { clearTimeout(g.longPressTimer); g.longPressTimer = null; }

    if (g.type === "deciding") {
      if (g.hitClipId) {
        setSelectedClipId(g.hitClipId);
        setMobileDrawer("props");
      } else {
        setSelectedClipId(null);
        setMobileDrawer(null);
      }
    }

    pointers.delete(e.pointerId);
    if (pointers.size < 2 && g.type === "pinch") g.type = "idle";
    else if (pointers.size === 0) g.type = "idle";
  }

  // ─── Download toast stack (bottom-right, stacked) ──────────────────────────

  function renderDownloadToasts() {
    if (downloadToasts.length === 0) return null;
    return (
      <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 10000, display: "flex", flexDirection: "column-reverse", gap: 8, pointerEvents: "none" }}>
        <style>{`@keyframes nbspin { to { transform: rotate(360deg); } }`}</style>
        {downloadToasts.map((t) => {
          const isError = t.status === "error";
          const accent = isError ? "#ff5e3a" : "#c8f135";
          return (
            <div key={t.id} style={{
              display: "flex", alignItems: "center", gap: 8, minWidth: 220, maxWidth: 300,
              background: "#2a2a2a", color: accent, fontFamily: "monospace", fontSize: 11,
              padding: "8px 14px", border: `1.5px solid ${accent}`, boxShadow: `2px 2px 0 ${accent}`,
              pointerEvents: "auto",
            }}>
              {t.status === "downloading" && (
                <span style={{ flexShrink: 0, width: 10, height: 10, borderRadius: "50%", border: "2px solid rgba(200,241,53,0.3)", borderTopColor: "#c8f135", animation: "nbspin 0.8s linear infinite" }} />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.status === "downloading" && `Downloading ${t.title}…`}
                {t.status === "done" && `Added ${t.title}`}
                {isError && (t.error ? `Failed: ${t.error}` : `Failed to download ${t.title}`)}
              </span>
              {isError && (
                <button onClick={() => setDownloadToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  style={{ marginLeft: "auto", background: "transparent", border: "none", color: accent, cursor: "pointer", fontFamily: "monospace", fontSize: 13, padding: 0, flexShrink: 0 }}>
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ─── Neural Search modal ────────────────────────────────────────────────────

  function renderNeuralSearchModal() {
    if (!AI_FEATURES_ENABLED) return null;
    if (!neuralModalOpen) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !neuralPhase) setNeuralModalOpen(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🔮 NEURAL SEARCH</span>
            <button
              onClick={() => { if (!neuralPhase) setNeuralModalOpen(false); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: neuralPhase ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
              Describe your video concept. We&apos;ll find YouTube videos and Google Images to match.
            </p>
            <textarea
              value={neuralConcept}
              onChange={(e) => setNeuralConcept(e.target.value)}
              disabled={!!neuralPhase}
              placeholder="e.g. The connection between microplastics in our body and mental health decline in modern society…"
              rows={6}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: 11,
                border: "1.5px solid #2a2a2a", padding: "8px",
                resize: "vertical", boxSizing: "border-box",
                background: neuralPhase ? "#f5f5f0" : "#fff",
              } as React.CSSProperties}
            />

            {neuralPhase && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ {neuralPhase}
              </div>
            )}
            {neuralError && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {neuralError}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => { if (!neuralPhase) setNeuralModalOpen(false); }}
              disabled={!!neuralPhase}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: neuralPhase ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={runNeuralSearch}
              disabled={!!neuralPhase || !neuralConcept.trim()}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#e4cfff", borderColor: "#2a2a2a",
                opacity: (!!neuralPhase || !neuralConcept.trim()) ? 0.5 : 1,
                cursor: (!!neuralPhase || !neuralConcept.trim()) ? "not-allowed" : "pointer",
              }}
            >
              {neuralPhase ? "Working…" : "Find Videos & Images →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Top 5 Neural Search modal ──────────────────────────────────────────────

  function renderTop5Modal() {
    if (!AI_FEATURES_ENABLED) return null;
    if (!top5ModalOpen) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !top5Phase) setTop5ModalOpen(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 500, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🏆 TOP 5 NEURAL SEARCH</span>
            <button
              onClick={() => { if (!top5Phase) setTop5ModalOpen(false); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: top5Phase ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
              Describe a Top 5 concept. GPT-4o will generate the ranked list, then find 2–3 YouTube candidates per rank and arrange them on the board in columns.
            </p>
            <textarea
              value={top5Concept}
              onChange={(e) => setTop5Concept(e.target.value)}
              disabled={!!top5Phase}
              placeholder="e.g. Top 5 conspiracies that turned out to be true…"
              rows={5}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: 11,
                border: "1.5px solid #2a2a2a", padding: "8px",
                resize: "vertical", boxSizing: "border-box",
                background: top5Phase ? "#f5f5f0" : "#fff",
              } as React.CSSProperties}
            />

            {top5Phase && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ {top5Phase}
              </div>
            )}
            {top5Error && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {top5Error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => { if (!top5Phase) setTop5ModalOpen(false); }}
              disabled={!!top5Phase}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: top5Phase ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={runTop5Search}
              disabled={!!top5Phase || !top5Concept.trim()}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#fef3c7", borderColor: "#2a2a2a",
                opacity: (!!top5Phase || !top5Concept.trim()) ? 0.5 : 1,
                cursor: (!!top5Phase || !top5Concept.trim()) ? "not-allowed" : "pointer",
              }}
            >
              {top5Phase ? "Working…" : "Generate Top 5 →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderPlayYoutubeModal() {
    if (!ytModalOpen) return null;
    const selectResult = (r: YtSearchResult) => {
      const maxSec = parseDurationSec(r.duration);
      const initEnd = Math.min(30, maxSec || 30);
      setYtSelected(r);
      setYtStart(0); setYtStartInput("0:00");
      setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
      ytRangeRef.current = { start: 0, end: initEnd };
      setYtView("trim");
    };
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.48)", zIndex: 9, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto" }}
      >
        <div style={{ width: 620, maxWidth: "calc(100vw - 28px)", maxHeight: "86dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", fontFamily: "monospace", color: "#2a2a2a" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 900 }}>{ytView === "trim" ? `▶ TRIM ${(ytSelected?.title ?? "YouTube clip").slice(0, 42)}` : "▶ ADD YOUTUBE WHILE LIVE"}</div>
            <button type="button" onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "2px 8px", fontSize: 14 }}>×</button>
          </div>
          <div style={{ padding: 14, overflowY: "auto" }}>
            {ytView === "search" ? (
              <>
                <div style={{ display: "flex", marginBottom: 12, borderBottom: "1.5px solid #2a2a2a" }}>
                  {(["search", "paste"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => { setYtTab(tab); setYtError(""); }}
                      style={{ fontFamily: "monospace", padding: "6px 13px", fontSize: 11, fontWeight: ytTab === tab ? 900 : 600, background: ytTab === tab ? "#2a2a2a" : "transparent", color: ytTab === tab ? "#fffdf5" : "#2a2a2a", border: "none", cursor: "pointer" }}
                    >
                      {tab === "search" ? "Search" : "Paste URL"}
                    </button>
                  ))}
                </div>
                {ytTab === "paste" ? (
                  <>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        autoFocus
                        type="text"
                        value={ytUrlInput}
                        onChange={(e) => setYtUrlInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleYtPasteUrl(); }}
                        placeholder="https://www.youtube.com/watch?v=..."
                        style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                      />
                      <button type="button" onClick={handleYtPasteUrl} style={{ ...miniButton, padding: "8px 14px", fontSize: 12, fontWeight: 900 }}>Next</button>
                    </div>
                    {ytError && <div style={{ color: "#cc2200", fontSize: 11, marginTop: 8 }}>{ytError}</div>}
                  </>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                      <input
                        autoFocus
                        type="text"
                        value={ytQuery}
                        onChange={(e) => setYtQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                        placeholder="search YouTube..."
                        style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                      />
                      <button type="button" onClick={() => handleYtSearch()} disabled={ytLoading} style={{ ...miniButton, padding: "8px 14px", fontSize: 12, fontWeight: 900, opacity: ytLoading ? 0.5 : 1 }}>{ytLoading ? "..." : "Search"}</button>
                    </div>
                    {ytError && <div style={{ color: "#cc2200", fontSize: 11, marginBottom: 8 }}>{ytError}</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                      {ytResults.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => selectResult(r)}
                          style={{ padding: 0, textAlign: "left", border: "1.5px solid #2a2a2a", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", cursor: "pointer", overflow: "hidden", fontFamily: "monospace", color: "#2a2a2a" }}
                        >
                          {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover", background: "#111" }} />}
                          <div style={{ padding: "6px 7px" }}>
                            <div style={{ fontSize: 10, fontWeight: 900, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{r.title ?? "(no title)"}</div>
                            <div style={{ fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>{r.duration != null ? (typeof r.duration === "number" ? formatTimestamp(r.duration) : r.duration) : ""}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : ytSelected ? (() => {
              const maxSec = parseDurationSec(ytSelected.duration) || 600;
              const clipLen = Math.max(0, ytEnd - ytStart);
              return (
                <>
                  <div style={{ marginBottom: 12, background: "#000", lineHeight: 0 }}>
                    <iframe
                      src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&autoplay=0`}
                      style={{ width: "100%", aspectRatio: "16/9", border: "none" }}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 10, alignItems: "end" }}>
                    <label style={{ fontSize: 10, fontWeight: 900 }}>
                      Start
                      <input
                        type="text"
                        value={ytStartInput}
                        onChange={(e) => {
                          setYtStartInput(e.target.value);
                          const parsed = parseTimestampSec(e.target.value);
                          if (parsed === null) return;
                          const nextStart = clamp(parsed, 0, Math.max(0, maxSec - 0.5));
                          const nextEnd = clamp(Math.max(ytRangeRef.current.end, nextStart + 0.5), nextStart + 0.5, Math.min(maxSec, nextStart + 30));
                          ytRangeRef.current = { start: nextStart, end: nextEnd };
                          setYtStart(nextStart);
                          setYtEnd(nextEnd);
                          setYtEndInput(formatTimestamp(nextEnd));
                        }}
                        onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                        style={{ display: "block", marginTop: 4, width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 12, padding: "7px 8px", border: "1.5px solid #2a2a2a", background: "#fffdf5" }}
                      />
                    </label>
                    <label style={{ fontSize: 10, fontWeight: 900 }}>
                      End
                      <input
                        type="text"
                        value={ytEndInput}
                        onChange={(e) => {
                          setYtEndInput(e.target.value);
                          const parsed = parseTimestampSec(e.target.value);
                          if (parsed === null) return;
                          const nextEnd = clamp(parsed, ytRangeRef.current.start + 0.5, Math.min(maxSec, ytRangeRef.current.start + 30));
                          ytRangeRef.current.end = nextEnd;
                          setYtEnd(nextEnd);
                        }}
                        onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                        style={{ display: "block", marginTop: 4, width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 12, padding: "7px 8px", border: "1.5px solid #2a2a2a", background: "#fffdf5" }}
                      />
                    </label>
                    <div style={{ fontSize: 10, color: "#6a6a6a", lineHeight: 1.5 }}>
                      Clip: {formatTimestamp(clipLen)}<br />
                      Max: {formatTimestamp(maxSec)}
                    </div>
                  </div>
                </>
              );
            })() : null}
          </div>
          {ytView === "trim" && (
            <div style={{ padding: "10px 14px", borderTop: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>Back</button>
              <button type="button" onClick={handleYtConfirm} style={{ ...miniButton, marginLeft: "auto", padding: "6px 16px", fontSize: 12, fontWeight: 900, background: "#c8f135" }}>Add to live board</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Image placeholder preview modal ────────────────────────────────────────

  function renderImagePreviewModal() {
    const ph = imagePreviewTarget;
    if (!ph) return null;
    return (
      <div
        onClick={(e) => { if (e.target === e.currentTarget && !imagePreviewWorking) setImagePreviewTarget(null); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>🖼 IMAGE PREVIEW</span>
            <button
              onClick={() => { if (!imagePreviewWorking) setImagePreviewTarget(null); }}
              style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: imagePreviewWorking ? 0.4 : 1 }}
            >×</button>
          </div>

          <div style={{ padding: 16 }}>
            <img
              src={ph.imageUrl}
              alt={ph.title}
              style={{ width: "100%", maxHeight: 280, objectFit: "contain", display: "block", background: "#1a1a1a", border: "1.5px solid #2a2a2a" }}
            />
            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ph.title}
            </div>
            {ph.sourceUrl && (
              <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ph.sourceUrl}
              </div>
            )}

            {imagePreviewWorking && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                ⟳ Downloading image…
              </div>
            )}
            {imagePreviewError && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                ✗ {imagePreviewError}
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => removeImagePlaceholder(ph.id)}
              disabled={imagePreviewWorking}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, color: "#cc2200", opacity: imagePreviewWorking ? 0.4 : 1 }}
            >
              Remove Suggestion
            </button>
            <button
              onClick={() => { if (!imagePreviewWorking) setImagePreviewTarget(null); }}
              disabled={imagePreviewWorking}
              style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: imagePreviewWorking ? 0.4 : 1 }}
            >
              Cancel
            </button>
            <button
              onClick={() => commitImagePlaceholder(ph)}
              disabled={imagePreviewWorking}
              style={{
                ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                background: "#a8d8ff", borderColor: "#2a2a2a",
                opacity: imagePreviewWorking ? 0.5 : 1,
                cursor: imagePreviewWorking ? "not-allowed" : "pointer",
              }}
            >
              {imagePreviewWorking ? "Working…" : "Add to Board →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Mobile early returns ─────────────────────────────────────────────────

  if (playMode) {
    const choosePlayWheel=(fn:()=>void)=>{fn();dismissPlayWheel();};
    const playWheelItems=[
      {label:"Weapon",icon:"⌁",onSelect:()=>choosePlayWheel(()=>{const next=!playWeaponArmedRef.current;playBazookaArmedRef.current=false;setPlayBazookaArmed(false);playWeaponArmedRef.current=next;setPlayWeaponArmed(next);broadcastWeaponState(true);})},
      {label:"Tomato",icon:"●",disabled:true,onSelect:()=>{}},
      {label:"Bazooka",icon:"◁",onSelect:()=>choosePlayWheel(()=>{const next=!playBazookaArmedRef.current;playWeaponArmedRef.current=false;setPlayWeaponArmed(false);playBazookaArmedRef.current=next;setPlayBazookaArmed(next);broadcastWeaponState(true);})},
      {label:"Camera",icon:"◉",onSelect:()=>choosePlayWheel(()=>setPlaySceneShot(v=>!v))},
      {label:"Menu",icon:"☰",onSelect:()=>setPlayWheelMenuOpen(true)},
    ];
    const playWheelMenuItems=[
      {label:playNativeFullscreen||playMaximize?"Exit fullscreen":"Fullscreen",icon:"⛶",onSelect:()=>choosePlayWheel(()=>void togglePlayFullscreen())},
      ...(DEBUG_STREAM?[{label:"Debug",icon:"⌁",onSelect:()=>choosePlayWheel(()=>setPlayDebugOpen(v=>!v))}]:[]),
      {label:"Clear splats (soon)",icon:"⌫",disabled:true,onSelect:()=>{}},
      {label:"Repair board",icon:"✧",onSelect:()=>choosePlayWheel(repairBoard)},
      {label:"Participants",icon:"♟",onSelect:()=>choosePlayWheel(()=>setPlayParticipantsOpen(v=>!v))},
      {label:"Exit Play Mode",icon:"←",onSelect:()=>choosePlayWheel(exitPlayMode)},
    ];
    return (
	      <div ref={playContainerRef} data-play-maximize={playMaximize||undefined} style={{ position: "fixed", inset: 0, zIndex: playMaximize?2147483000:10000, overflow: "hidden", background: "#111" }}>
	        <style>{`[data-play-maximize] > :not(canvas):not(style):not([data-max-exit]){display:none!important}`}</style>
	        <div ref={videoHiddenContainerRef} style={{ display: "none" }} aria-hidden="true" />
	        <input ref={mediaUploadRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={handleMediaUpload} />
	        <canvas
	          ref={playCanvasRef}
          width={playViewport.width}
          height={playViewport.height}
          onPointerDown={handlePlayPointerDown}
          onPointerMove={handlePlayPointerMove}
          onPointerUp={handlePlayPointerUp}
          onPointerCancel={handlePlayPointerUp}
          onContextMenu={handlePlayContextMenu}
          onWheel={(e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            playCameraRef.current.boardZoom = clamp(playCameraRef.current.boardZoom * factor, 0.35, 3);
          }}
          style={{ display: "block", width: "100vw", height: "100dvh", cursor: "crosshair", touchAction: "none" }}
        />
        {!playMaximize&&<button
          type="button"
          onClick={() => setPlayCleanMenuOpen((v) => !v)}
          style={{ position: "fixed", top: 14, right: 14, zIndex: 6, padding: "7px 10px", border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.78)", opacity: 0.72, boxShadow: "2px 2px 0 rgba(42,42,42,0.55)", fontFamily: "monospace", fontWeight: 900, cursor: "pointer" }}
        >
	          ☰
	        </button>}
	        {!playCleanUi&&!playMaximize&&<button
	          type="button"
	          onClick={openPlayAddMenu}
	          style={{ position: "fixed", top: 14, left: playCleanUi ? 78 : 154, zIndex: 6, width: 34, height: 32, border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.78)", opacity: 0.72, boxShadow: "2px 2px 0 rgba(42,42,42,0.55)", fontFamily: "monospace", fontSize: 18, fontWeight: 900, lineHeight: "28px", cursor: "pointer" }}
	          title="Add media while live"
	        >
	          +
	        </button>}
	        {playAddMenuOpen && (
	          <div style={{ position: "fixed", top: 52, left: playCleanUi ? 78 : 154, zIndex: 7, minWidth: 190, border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.96)", boxShadow: "3px 3px 0 #2a2a2a", fontFamily: "monospace", fontSize: 10, color: "#2a2a2a", overflow: "hidden" }}>
	            <button type="button" onClick={triggerPlayMediaUpload} style={{ width: "100%", padding: "9px 10px", border: "none", background: "transparent", textAlign: "left", fontFamily: "inherit", fontWeight: 900, cursor: "pointer" }}>📷 Add image</button>
	            <button type="button" onClick={openPlayYoutubeModal} style={{ width: "100%", padding: "9px 10px", border: "none", borderTop: "1px solid rgba(42,42,42,0.2)", background: "transparent", textAlign: "left", fontFamily: "inherit", fontWeight: 900, cursor: "pointer" }}>▶️ Add YouTube</button>
	            <div style={{ padding: "8px 10px", borderTop: "1px solid rgba(42,42,42,0.2)", color: "#6a6a6a", lineHeight: 1.45 }}>📋 Paste with Cmd/Ctrl+V</div>
	          </div>
	        )}
	        {playCleanMenuOpen && (
	          <div style={{ position: "fixed", top: 50, right: 14, zIndex: 6, minWidth: 170, border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.94)", boxShadow: "3px 3px 0 #2a2a2a", fontFamily: "monospace", fontSize: 10 }}>
            <button type="button" onClick={() => setPlayCleanUi((v) => !v)} style={{ width: "100%", padding: "8px 9px", border: "none", background: "transparent", textAlign: "left", fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>{playCleanUi ? "Show chrome" : "Hide chrome"}</button>
            <button type="button" onClick={() => void togglePlayFullscreen()} style={{ width: "100%", padding: "8px 9px", border: "none", borderTop: "1px solid rgba(42,42,42,0.2)", background: "transparent", textAlign: "left", fontFamily: "inherit", fontWeight: 800, cursor: "pointer" }}>Fullscreen</button>
            {DEBUG_STREAM&&<button type="button" onClick={()=>setPlayDebugOpen(v=>!v)} style={{width:"100%",padding:"8px 9px",border:"none",borderTop:"1px solid rgba(42,42,42,.2)",background:"transparent",textAlign:"left",fontFamily:"inherit",fontWeight:800,cursor:"pointer"}}>Debug</button>}
            <button type="button" onClick={exitPlayMode} style={{ width: "100%", padding: "8px 9px", border: "none", borderTop: "1px solid rgba(42,42,42,0.2)", background: "transparent", textAlign: "left", fontFamily: "inherit", fontWeight: 800, color: "#8b2b20", cursor: "pointer" }}>Exit Play Mode</button>
          </div>
        )}
        {!playCleanUi && (
          <button
            type="button"
            onClick={exitPlayMode}
            style={{ position: "fixed", top: 14, left: 14, zIndex: 2, padding: "8px 12px", border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.92)", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", fontWeight: 700, cursor: "pointer" }}
          >
            ✕ Exit
          </button>
        )}
        <div style={{ position: "fixed", top: 14, left: playCleanUi ? 14 : 90, zIndex: 2, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.92)", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", fontSize: 10, fontWeight: 800, color: streamPublishing ? "#228b22" : "#8a6a00" }}>
          {streamPublishing ? "LIVE" : "LOCAL"}
        </div>
        {DEBUG_STREAM && playDebugOpen && !playMaximize && (
          <div data-stream-debug-overlay style={{ position: "fixed", bottom: 12, left: 12, zIndex: 10040, width:"min(560px, calc(100vw - 24px))", maxHeight:"40vh", overflowY:"auto", padding: "6px 8px", border: "1px solid rgba(42,42,42,0.35)", background: "rgba(255,253,245,0.96)", fontFamily: "monospace", fontSize: 9, color: "#2a2a2a" }}>
            <button onClick={()=>setPlayDebugOpen(false)} style={{float:"right",border:0,background:"transparent"}}>✕</button>
            renderer: {RENDERER_VERSION} · flip: {playFlipDebugRef.current ? `f ${playFlipDebugRef.current.facing} r ${playFlipDebugRef.current.rotationDirection} dx ${Math.round(playFlipDebugRef.current.travelDx)}` : "idle"}
            {streamCharacterDebugRows.map((row) => (
              <div key={`${row.isHost ? "h" : "g"}-${row.id}`}>
                {row.id} {row.isHost ? "host" : "guest"} pub:{row.skinPublished ?? "∅"} res:{row.skinResolved} src:{row.skinSource} act:{row.actionType}@{row.actionProgress.toFixed(2)} phys:{row.physique}{row.travelDx !== undefined ? ` dx:${Math.round(row.travelDx)}` : ""}{row.rotationDirection ? ` rot:${row.rotationDirection}` : ""}{row.construction ? ` h:${row.construction.characterHeight} head:${row.construction.headRadiusX}/${row.construction.headRadiusY} torso:${row.construction.torsoLength} arm:${row.construction.armLength} stroke:${row.construction.strokeWidth}` : ""}
              </div>
            ))}
          </div>
        )}
        {!playCleanUi && <div style={{ position: "fixed", top: 58, left: 14, zIndex: 2, width: 190, padding: "10px 11px", border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.94)", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", color: "#2a2a2a" }}>
          <div style={{ fontSize: 10, fontWeight: 800, marginBottom: 6 }}>PLAY LOOK</div>
          <div style={{ fontSize: 9, marginBottom: 4 }}>Hair</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {(["crop", "spikes", "curls", "none"] as PlayHairStyle[]).map((style) => (
              <button key={style} type="button" onClick={() => setPlayHairStyle(style)} style={{ padding: "4px 6px", border: "1px solid #2a2a2a", background: playHairStyle === style ? "#f4b942" : "#fffdf5", font: "inherit", fontSize: 9, cursor: "pointer", textTransform: "capitalize" }}>{style}</button>
            ))}
          </div>
          <div style={{ fontSize: 9, marginBottom: 4 }}>Outfit</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {(["tee", "varsity", "adventure"] as PlayOutfitStyle[]).map((style) => (
              <button key={style} type="button" onClick={() => setPlayOutfitStyle(style)} style={{ padding: "4px 6px", border: "1px solid #2a2a2a", background: playOutfitStyle === style ? "#8cb8cf" : "#fffdf5", font: "inherit", fontSize: 9, cursor: "pointer", textTransform: "capitalize" }}>{style}</button>
            ))}
          </div>
        </div>}
	        {!playCleanUi && <div style={{ position: "fixed", right: 58, top: 14, zIndex: 2, fontFamily: "monospace", fontSize: 10, color: "#2a2a2a" }}>
          <button
            type="button"
            onClick={() => setPlayLegendOpen((v) => !v)}
            style={{ float: "right", padding: "7px 10px", border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.92)", fontFamily: "inherit", cursor: "pointer" }}
          >
            {playLegendOpen ? "Hotkeys ▴" : "Hotkeys ▾"}
          </button>
          {playLegendOpen && (
            <div style={{ clear: "both", marginTop: 5, padding: "10px 12px", lineHeight: 1.75, border: "1.5px solid #2a2a2a", background: "rgba(255,253,245,0.92)", boxShadow: "2px 2px 0 #2a2a2a" }}>
              Click near/far to walk/run · aim above to jump<br />Q {playWeaponArmed ? "holster weapon" : "weapon mode"} · click/hold fires while armed<br />Hold G/S/C/Z + click for grapple/skate/climb/zipline<br />D dance · E emote · F flip · J jump · P pull-ups · M mirror<br />V {playSceneShot ? "follow camera" : "scene shot"} · wheel zoom · Esc exit
	            </div>
	          )}
	        </div>}
	        {!playMaximize&&<><button type="button" aria-label="Open action wheel" onClick={()=>setPlayWheelOpen(true)} style={{...wheelTriggerStyle,bottom:playAddMenuOpen?86:wheelTriggerStyle.bottom}}>✦</button><ActionWheel open={playWheelOpen} items={playWheelItems} onDismiss={dismissPlayWheel} menuOpen={playWheelMenuOpen} menuItems={playWheelMenuItems}/></>}
	        {playMaximize&&<button data-max-exit type="button" aria-label="Exit maximize" onClick={()=>void exitPlayFullscreen()} style={{position:"fixed",top:"max(10px, env(safe-area-inset-top))",right:"max(10px, env(safe-area-inset-right))",zIndex:10050,width:38,height:38,border:"2px solid #2a2a2a",background:"#fffdf5"}}>✕</button>}
	        {playParticipantsOpen&&!playMaximize&&<aside style={{position:"fixed",top:64,right:14,zIndex:10025,minWidth:190,padding:10,border:"2px solid #2a2a2a",background:"#fffdf5",fontFamily:"'Patrick Hand', cursive"}}><button onClick={()=>setPlayParticipantsOpen(false)} style={{float:"right",border:0,background:"transparent"}}>✕</button><strong>Participants ({streamGuests.length})</strong>{streamGuests.map(g=><div key={g.guestId}>{g.name}</div>)}</aside>}
	        {renderPlayYoutubeModal()}
	        {renderDownloadToasts()}
	        {toast && (
	          <div style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 10001, background: "#2a2a2a", color: "#fffdf5", fontFamily: "monospace", fontSize: 11, padding: "8px 14px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135" }}>
	            {toast}
	          </div>
	        )}
	      </div>
	    );
	  }

  // Mobile Top 5 Tinder flow — takes over the entire mobile experience.
  // mobileDesktopOverride lets the user escape to the desktop UI.
  if (isMobile && !mobileDesktopOverride && !AI_FEATURES_ENABLED) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#f5ecd8", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "monospace", padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#2a2a2a" }}>Open Neural Board on desktop</div>
        <div style={{ fontSize: 11, color: "#6a6a6a", marginTop: 10, lineHeight: 1.6 }}>The mobile AI flow is currently hidden while AI features are disabled.</div>
      </div>
    );
  }

  if (isMobile && !mobileDesktopOverride) {
    return renderMobileTop5Flow();
  }

  // Below: existing mobile board (landscape) — only shown when mobileDesktopOverride is true
  if (isMobile && isPortrait) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#f5ecd8", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "monospace" }}>
        <div style={{ fontSize: 52, lineHeight: 1 }}>↻</div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 18, color: "#2a2a2a" }}>Rotate to landscape</div>
        <div style={{ fontSize: 11, color: "#6a6a6a", marginTop: 8, textAlign: "center", padding: "0 32px", lineHeight: 1.6 }}>Neural Board requires landscape mode</div>
      </div>
    );
  }

  if (isMobile) {
    const MOBILE_LAYER_H = 30;
    const MOBILE_TRACK_H = N_LAYERS * MOBILE_LAYER_H;
    const MOBILE_NARRATION_H = 28;
    const MOBILE_RULER_H = 28;

    return (
      <div style={{ ...pageStyle, overflow: "hidden", display: "flex", flexDirection: "column", height: "100dvh" }}>
        <div ref={videoHiddenContainerRef} style={{ display: "none" }} aria-hidden="true" />
        <input ref={mediaUploadRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={handleMediaUpload} />
        <input ref={narrationUploadRef} type="file" accept="audio/*,video/mp4,video/quicktime,video/webm" style={{ display: "none" }} onChange={handleNarrationUpload} />
        <input ref={projectFileInputRef} type="file" accept=".nbp,.zip" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadBoard(f); }} />
        <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

        {/* ── Compact header ── */}
        <header style={{ height: 44, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", borderBottom: "1.5px dashed rgba(42,42,42,0.3)", background: "rgba(255,253,245,0.95)", zIndex: 10 }}>
          <button
            onClick={() => setMobileDrawer((d) => d === "media" ? null : "media")}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontFamily: "monospace", background: mobileDrawer === "media" ? "#2a2a2a" : "transparent", color: mobileDrawer === "media" ? "#c8f135" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >≡</button>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 19, fontWeight: 700, color: "#2a2a2a", flex: 1, minWidth: 0, lineHeight: 1, overflow: "hidden", whiteSpace: "nowrap" }}>Neural Board</span>
          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#2a2a2a", letterSpacing: 0.5, border: "1px solid rgba(42,42,42,0.3)", padding: "2px 4px", background: "#fffdf5", flexShrink: 0 }}>
            {formatTime(playhead)}/{formatTime(timelineDuration)}
          </span>
          <button
            onClick={togglePlay}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, background: isPlaying ? "#ff5e3a" : "#c8f135", color: isPlaying ? "#fff" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >{isPlaying ? "⏸" : "▶"}</button>
          <button
            onClick={() => {
              const next: CameraMode = cameraMode === "clips" ? "character" : "clips";
              if (next === "character" && !showCharacter) return;
              setCameraMode(next);
              cameraModeRef.current = next;
              if (cameraKeyframesRef.current.length > 0 && next !== cameraKeyframeModeRef.current) setKeyframesOutOfDate(true);
            }}
            disabled={cameraMode === "clips" && !showCharacter}
            title={!showCharacter && cameraMode === "clips" ? "Enable Character 1 to use character camera" : `Camera source: ${cameraMode}`}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontFamily: "monospace", background: cameraMode === "character" ? "#2a2a2a" : "transparent", color: cameraMode === "character" ? "#c8f135" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: !showCharacter && cameraMode === "clips" ? "not-allowed" : "pointer", opacity: !showCharacter && cameraMode === "clips" ? 0.35 : 1, flexShrink: 0 }}
          >{cameraMode === "character" ? "CHAR" : "CLIP"}</button>
          <button
            onClick={generateCameraKeyframes}
            disabled={!canGenerateCamera}
            title={canGenerateCamera ? `Generate ${cameraMode}-driven camera keyframes` : cameraMode === "character" ? "Enable Character 1 first" : "Upload media first"}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: "transparent", color: "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: canGenerateCamera ? "pointer" : "not-allowed", opacity: canGenerateCamera ? 1 : 0.35, flexShrink: 0 }}
          >⬡</button>
          <button
            onClick={isExporting ? cancelExport : startExport}
            title={isExporting ? "Cancel export" : "Export video"}
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: isExporting ? "#ff5e3a" : "transparent", color: isExporting ? "#fff" : "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >{isExporting ? "✕" : "⬇"}</button>
          <button
            onClick={() => setSaveModalOpen(true)}
            title="Save / load project"
            style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: "transparent", color: "#2a2a2a", border: "1.5px solid #2a2a2a", cursor: "pointer", flexShrink: 0 }}
          >💾</button>
        </header>

        {/* ── Board ── */}
        <div
          ref={boardContainerRef}
          style={{ flex: 1, position: "relative", overflow: "hidden", touchAction: "none", minHeight: 0 }}
          onPointerDown={handleMobileBoardPointerDown}
          onPointerMove={handleMobileBoardPointerMove}
          onPointerUp={handleMobileBoardPointerUp}
          onPointerCancel={handleMobileBoardPointerUp}
        >
          {/* Board surface */}
          <div style={{ position: "absolute", left: boardPan.x, top: boardPan.y, width: BOARD_W * boardZoom, height: BOARD_H * boardZoom, background: "#f7e5c1", border: "1.5px dashed rgba(42,42,42,0.2)" }}>
            {clips.filter((c) => c.boardX !== undefined).map((clip) => {
              const isSel = clip.id === selectedClipId;
              return (
                <div
                  key={clip.id}
                  data-mbclipid={clip.id}
                  style={{
                    position: "absolute",
                    left: clip.boardX! * boardZoom,
                    top: clip.boardY! * boardZoom,
                    width: clip.boardW! * boardZoom,
                    height: clip.boardH! * boardZoom,
                    border: isSel ? "2px solid #ff5e3a" : clip.type === "customZoom" ? "1.5px dashed #2e8fff" : "1.5px solid rgba(42,42,42,0.4)",
                    boxShadow: isSel ? "0 0 0 2px #ff5e3a, 1px 1px 6px rgba(42,42,42,0.25)" : "1px 1px 4px rgba(42,42,42,0.2)",
                    touchAction: "none",
                  }}
                >
                  <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: clip.needsRedownload ? "auto" : "none" }}>
                    {clip.needsRedownload ? (
                      <div
                        style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3 }}
                        onClick={(e) => { e.stopPropagation(); redownloadYtClip(clip.id); }}
                      >
                        <span style={{ color: "#ff9f5e", fontSize: 16, pointerEvents: "none" }}>▶</span>
                        <span style={{ color: "#ff9f5e", fontSize: Math.max(6, 7 * boardZoom), fontFamily: "monospace", textAlign: "center", pointerEvents: "none" }}>tap to re-download</span>
                      </div>
                    ) : clip.type === "image" ? (
                      <canvas
                        ref={(canvas) => {
                          if (canvas) mobileBoardImageCanvasRefs.current.set(clip.id, canvas);
                          else mobileBoardImageCanvasRefs.current.delete(clip.id);
                        }}
                        width={Math.max(1, Math.round(clip.boardW!))}
                        height={Math.max(1, Math.round(clip.boardH!))}
                        aria-label={clip.name}
                        style={{ width: "100%", height: "100%", display: "block", transformOrigin: "center" }}
                      />
                    ) : clip.type === "customZoom" ? (
                      <div style={{ width: "100%", height: "100%", background: "rgba(184,226,255,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: "#1c6fc9", fontSize: Math.max(10, 16 * boardZoom), pointerEvents: "none" }}>🔍</span>
                      </div>
                    ) : (
                      <div style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: "#7df5b0", fontSize: Math.max(7, 10 * boardZoom), fontFamily: "monospace" }}>▶ {clip.name}</span>
                      </div>
                    )}
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", pointerEvents: "none" }}>
                      {clip.name}
                    </div>
                  </div>
                  {isSel && (
                    <div
                      style={{ position: "absolute", right: -7, bottom: -7, width: 28, height: 28, background: "#ff5e3a", border: "2px solid #fff", borderRadius: 3, zIndex: 20, touchAction: "none", display: "flex", alignItems: "center", justifyContent: "center" }}
                      onPointerDown={(e) => handleBoardResizePointerDown(e, clip, "se")}
                    >
                      <span style={{ color: "#fff", fontSize: 10, lineHeight: 1, pointerEvents: "none" }}>⤡</span>
                    </div>
                  )}
                </div>
              );
            })}

            <canvas
              ref={mobileBoardCharacterCanvasRef}
              width={BOARD_W}
              height={BOARD_H}
              aria-label="Characters on board"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 6 }}
            />

            {/* Neural Search placeholders — not yet downloaded, tap to trim & add */}
            {AI_FEATURES_ENABLED && neuralPlaceholders.map((ph) => (
              <div
                key={ph.id}
                style={{
                  position: "absolute",
                  left: ph.boardX * boardZoom,
                  top: ph.boardY * boardZoom,
                  width: ph.boardW * boardZoom,
                  height: ph.boardH * boardZoom,
                  border: "2px dashed #a855f7",
                  boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                  touchAction: "none",
                  cursor: "pointer",
                }}
                onClick={() => openTrimModalForPlaceholder(ph)}
              >
                <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", background: "#1a1a2e" }}>
                  {ph.thumbnailUrl && (
                    <img src={ph.thumbnailUrl} alt={ph.title} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.85 }} draggable={false} />
                  )}
                  <div style={{ position: "absolute", top: 2, left: 2, padding: "1px 4px", background: "#a855f7", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", fontWeight: 700 }}>
                    🔮 NOT ADDED
                  </div>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {ph.title} {ph.viewCount > 0 && `· ${formatViewCount(ph.viewCount)}`}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeNeuralPlaceholder(ph.id); }}
                  style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: "50%", background: "#ff5e3a", border: "2px solid #fff", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, touchAction: "none" }}
                >
                  ✕
                </button>
              </div>
            ))}

            {/* Neural Search image placeholders — not yet downloaded, tap to preview & add */}
            {AI_FEATURES_ENABLED && imagePlaceholders.map((ph) => (
              <div
                key={ph.id}
                style={{
                  position: "absolute",
                  left: ph.boardX * boardZoom,
                  top: ph.boardY * boardZoom,
                  width: ph.boardW * boardZoom,
                  height: ph.boardH * boardZoom,
                  border: "2px dashed #3b82f6",
                  boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                  touchAction: "none",
                  cursor: "pointer",
                }}
                onClick={() => setImagePreviewTarget(ph)}
              >
                <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", background: "#3a3a3a" }}>
                  <img
                    src={ph.imageUrl}
                    alt={ph.title}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.9 }}
                    draggable={false}
                    onError={() => removeImagePlaceholder(ph.id)}
                  />
                  <div style={{ position: "absolute", top: 2, left: 2, padding: "1px 4px", background: "#3b82f6", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", fontWeight: 700 }}>
                    🖼 NOT ADDED
                  </div>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 3px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: Math.max(6, 8 * boardZoom), fontFamily: "monospace", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {ph.title}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeImagePlaceholder(ph.id); }}
                  style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: "50%", background: "#ff5e3a", border: "2px solid #fff", color: "#fff", fontSize: 11, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 20, touchAction: "none" }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {clips.filter((c) => c.boardX !== undefined).length === 0 && (!AI_FEATURES_ENABLED || (neuralPlaceholders.length === 0 && imagePlaceholders.length === 0)) && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "rgba(42,42,42,0.35)", textAlign: "center" }}>Tap ≡ to add media</span>
            </div>
          )}

          <div style={{ position: "absolute", bottom: 6, left: 8, fontFamily: "monospace", fontSize: 8, color: "rgba(42,42,42,0.4)", pointerEvents: "none" }}>
            {Math.round(boardZoom * 100)}% · pinch to zoom
          </div>

          {/* Preview PiP */}
          <div style={{ position: "absolute", top: 6, right: 6, zIndex: 10, pointerEvents: "none" }}>
            <canvas
              ref={canvasRef}
              width={canvasW}
              height={canvasH}
              style={{ display: "block", width: mobilePreviewW, height: mobilePreviewH, border: "1.5px solid #2a2a2a", background: "#111", boxShadow: "2px 2px 0 rgba(42,42,42,0.4)" }}
            />
          </div>

          {/* Export progress */}
          {isExporting && (
            <div style={{ position: "absolute", inset: 0, background: "rgba(255,253,245,0.9)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 20 }}>
              <div style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: "#2a2a2a", marginBottom: 12 }}>Exporting… {Math.round(exportProgress * 100)}%</div>
              <div style={{ width: 160, height: 8, background: "rgba(42,42,42,0.15)", border: "1px solid #2a2a2a" }}>
                <div style={{ height: "100%", width: `${exportProgress * 100}%`, background: "#c8f135", transition: "width 0.1s" }} />
              </div>
              <button onClick={cancelExport} style={{ marginTop: 16, fontFamily: "monospace", fontSize: 11, background: "transparent", border: "1.5px solid #ff5e3a", color: "#ff5e3a", padding: "5px 14px", cursor: "pointer" }}>Cancel</button>
            </div>
          )}
        </div>

        {/* ── Timeline ── */}
        <div style={{ flexShrink: 0, background: "rgba(255,253,245,0.9)", borderTop: "1.5px solid rgba(42,42,42,0.15)" }}>
          {/* Ruler */}
          <div
            style={{ height: MOBILE_RULER_H, position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(42,42,42,0.03)", touchAction: "none" }}
            onPointerDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const t = Math.max(0, (e.clientX - rect.left + (scrollerRef.current?.scrollLeft ?? 0)) / pxPerSecRef.current);
              playheadRef.current = t; setPlayhead(t); setIsPlaying(false);
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const onMove = (ev: PointerEvent) => {
                const t2 = Math.max(0, (ev.clientX - rect.left + (scrollerRef.current?.scrollLeft ?? 0)) / pxPerSecRef.current);
                playheadRef.current = t2; setPlayhead(t2);
              };
              const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
              window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
            }}
          >
            <div style={{ position: "absolute", left: -timelineScroll, top: 0, width: timelineWidth + 200, height: "100%", pointerEvents: "none" }}>
              {rulerTicks()}
            </div>
            <div style={{ position: "absolute", left: playhead * pxPerSec - timelineScroll, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none" }} />
          </div>
          {/* Tracks */}
          <div
            ref={scrollerRef}
            style={{ height: MOBILE_TRACK_H + MOBILE_NARRATION_H + 12, overflowX: "auto", overflowY: "hidden", touchAction: "pan-x", position: "relative" }}
            onScroll={(e) => { const sl = (e.target as HTMLDivElement).scrollLeft; timelineScrollRef.current = sl; setTimelineScroll(sl); }}
          >
            <div style={{ position: "relative", width: Math.max(timelineWidth, 400), height: MOBILE_TRACK_H + MOBILE_NARRATION_H + 8, minWidth: "100%" }}>
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * MOBILE_LAYER_H, height: MOBILE_LAYER_H, background: i % 2 === 0 ? "rgba(100,130,180,0.04)" : "rgba(100,130,180,0.09)", borderTop: i > 0 ? "1px solid rgba(42,42,42,0.05)" : "none" }} />
              ))}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <button
                  key={`mute-${i}`}
                  title={mutedLayers[i] ? `Unmute layer L${i}` : `Mute layer L${i}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); toggleLayerMute(i); }}
                  style={{
                    position: "absolute",
                    left: timelineScroll + 2,
                    top: i * MOBILE_LAYER_H + 1,
                    zIndex: 20,
                    width: 20,
                    height: 16,
                    padding: 0,
                    border: "1px solid rgba(42,42,42,0.35)",
                    background: mutedLayers[i] ? "#ff5e3a" : "rgba(255,253,245,0.88)",
                    color: mutedLayers[i] ? "#fff" : "#2a2a2a",
                    fontSize: 8,
                    lineHeight: "14px",
                    fontFamily: "monospace",
                    touchAction: "manipulation",
                  }}
                >
                  {mutedLayers[i] ? "×" : `L${i}`}
                </button>
              ))}
              <div style={{ position: "absolute", left: 0, right: 0, top: MOBILE_TRACK_H + 4, height: MOBILE_NARRATION_H, background: "rgba(255,150,200,0.07)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />

              {clips.filter((c) => c.type !== "narration").map((clip, ci) => {
                const color = clip.type === "pan" ? PAN_CLIP_COLOR : clip.type === "characterZoom" ? CHARACTER_ZOOM_CLIP_COLOR : clip.type === "customZoom" ? CUSTOM_ZOOM_CLIP_COLOR : CLIP_COLORS[ci % CLIP_COLORS.length];
                const isSel = clip.id === selectedClipId;
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                const layer = clip.layer ?? 1;
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: layer * MOBILE_LAYER_H + 2,
                      width: clipPx,
                      height: MOBILE_LAYER_H - 4,
                      background: color,
                      border: isSel ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.35)",
                      boxShadow: isSel ? "2px 2px 0 #2a2a2a" : "none",
                      touchAction: "none",
                      overflow: "hidden",
                    }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); setMobileDrawer("props"); }}
                  >
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.22)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")} />
                    <span style={{ position: "absolute", left: HANDLE_W + 3, right: HANDLE_W + 3, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#2a2a2a", pointerEvents: "none" }}>
                      {clip.type === "pan" ? "⟷ Pan" : clip.type === "characterZoom" ? "◎ Char Zoom" : clip.type === "customZoom" ? "🔍 Custom Zoom" : clip.name}
                    </span>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.22)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")} />
                  </div>
                );
              })}

              {clips.filter((c) => c.type === "narration").map((clip) => {
                const isSel = clip.id === selectedClipId;
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: MOBILE_TRACK_H + 6,
                      width: clipPx,
                      height: MOBILE_NARRATION_H,
                      background: NARRATION_COLOR,
                      border: isSel ? "1.5px solid #2a2a2a" : "1px solid rgba(180,80,130,0.4)",
                      overflow: "hidden",
                      touchAction: "none",
                    }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                    onClick={(e) => { e.stopPropagation(); setSelectedClipId(clip.id); setMobileDrawer("props"); }}
                  >
                    <span style={{ position: "absolute", left: 4, right: HANDLE_W + 2, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#5a1530", pointerEvents: "none" }}>
                      {clip.speechBubbles ? "💬" : "🎙"} {clip.name}
                    </span>
                    {clip.speechBubbles && <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 3, background: "#c8f135", pointerEvents: "none" }} />}
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, background: "rgba(42,42,42,0.15)", touchAction: "none" }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")} />
                  </div>
                );
              })}

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>

        {/* ── Bottom drawer ── */}
        {mobileDrawer && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 100 }} onClick={() => setMobileDrawer(null)} />
            <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 101, background: "#fffdf5", borderTop: "2px solid #2a2a2a", padding: "12px 16px 28px", boxShadow: "0 -4px 24px rgba(0,0,0,0.18)", maxHeight: "55vh", overflowY: "auto" }}>
              <div style={{ width: 32, height: 3, background: "rgba(42,42,42,0.28)", borderRadius: 2, margin: "0 auto 14px" }} />

              {mobileDrawer === "media" && (
                <>
                  <div style={{ fontFamily: "monospace", fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 12 }}>Add Media</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <button onClick={() => { mediaUploadRef.current?.click(); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}>
                      ↑  Upload photo / video
                    </button>
                    <button onClick={() => { setYtModalOpen(true); setYtView("search"); setYtTab("search"); setYtError(""); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}>
                      ▶  Add YouTube clip
                    </button>
                    <button onClick={() => { addPanClip(); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: PAN_CLIP_COLOR }}>
                      ⟷  Add pan clip
                    </button>
                    <button onClick={() => { addCharacterZoomClip(); setMobileDrawer(null); }} style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: CHARACTER_ZOOM_CLIP_COLOR }}>
                      ◎  Zoom on character
                    </button>
                    {AI_FEATURES_ENABLED && <ProGated featureName="Neural Search">
                      <button
                        onClick={() => { setNeuralModalOpen(true); setNeuralConcept(""); setNeuralError(""); setNeuralPhase(null); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: "#e4cfff" }}
                      >
                        🔮  Neural Search
                      </button>
                    </ProGated>}
                    {AI_FEATURES_ENABLED && <ProGated featureName="Top 5 Neural Search">
                      <button
                        onClick={() => { setTop5ModalOpen(true); setTop5Concept(""); setTop5Error(""); setTop5Phase(null); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: "#fef3c7" }}
                      >
                        🏆  Top 5
                      </button>
                    </ProGated>}
                    <ProGated featureName="Narration Recording">
                      <button
                        onClick={() => { if (isRecording) stopNarrationRecording(); else startNarrationRecording(); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13, background: isRecording ? "#ff5e3a" : "#2a2a2a", color: "#fff" }}
                      >
                        {isRecording ? "⏹  Stop narration" : "🎙  Record narration"}
                      </button>
                      <button
                        onClick={() => { narrationUploadRef.current?.click(); setMobileDrawer(null); }}
                        style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                      >
                        ↑  Upload audio / mp4
                      </button>
                    </ProGated>
                    <div style={{ width: "100%", height: 1, background: "rgba(42,42,42,0.15)", margin: "4px 0" }} />
                    <button
                      onClick={() => { setSaveModalOpen(true); setMobileDrawer(null); }}
                      style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                    >
                      💾  Save project
                    </button>
                    <button
                      onClick={() => { projectFileInputRef.current?.click(); setMobileDrawer(null); }}
                      style={{ ...sketchButton, width: "100%", textAlign: "left", padding: "10px 14px", fontSize: 13 }}
                    >
                      📂  Open project
                    </button>
                  </div>
                </>
              )}

              {mobileDrawer === "props" && selectedClip && (
                <>
                  <div style={{ fontFamily: "monospace", fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 12 }}>
                    {selectedClip.type === "pan" ? "⟷ Pan clip" : selectedClip.type === "characterZoom" ? "◎ Character zoom" : selectedClip.type === "customZoom" ? "🔍 Custom zoom" : selectedClip.type === "narration" ? "🎙 Narration" : selectedClip.name.slice(0, 28)}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <div style={{ ...panelLabelStyle, marginBottom: 6 }}>Duration (s)</div>
                      <input
                        type="number" inputMode="decimal" step={0.1} min={0.1}
                        value={selectedClip.duration.toFixed(2)}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0.1) setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, duration: v } : c)); }}
                        style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: "10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" } as React.CSSProperties}
                      />
                    </div>
                    {selectedClip.type !== "narration" && (
                      <div>
                        <div style={{ ...panelLabelStyle, marginBottom: 6 }}>
                          Hold {Math.round((selectedClip.holdFraction ?? HOLD_FRACTION) * 100)}% · Trans {Math.round((1 - (selectedClip.holdFraction ?? HOLD_FRACTION)) * 100)}%
                        </div>
                        <input
                          type="range" min={0.1} max={0.95} step={0.01}
                          value={selectedClip.holdFraction ?? HOLD_FRACTION}
                          onChange={(e) => { const v = parseFloat(e.target.value); if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true); setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, holdFraction: v } : c)); }}
                          style={{ width: "100%", accentColor: "#c8f135" }}
                        />
                      </div>
                    )}
                    {selectedClip.type === "narration" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <button
                          onClick={() => void setNarrationSpeechBubbles(selectedClip, !selectedClip.speechBubbles)}
                          disabled={transcribingNarrationId === selectedClip.id}
                          style={{ ...sketchButton, width: "100%", padding: "10px", background: selectedClip.speechBubbles ? "#c8f135" : "#fffdf5", opacity: transcribingNarrationId === selectedClip.id ? 0.55 : 1 }}
                        >
                          {transcribingNarrationId === selectedClip.id ? "⟳ Transcribing…" : selectedClip.speechBubbles ? "💬 Speech bubbles on" : "💬 Add speech bubbles"}
                        </button>
                        {selectedClip.speechBubbles && (
                          <button
                            type="button"
                            onClick={() => setNarrationSpeechGestures(selectedClip, selectedClip.speechBubbleGestures === false)}
                            style={{ ...miniButton, background: selectedClip.speechBubbleGestures === false ? "transparent" : "#f4b942" }}
                          >
                            {selectedClip.speechBubbleGestures === false ? "Talking hands off" : "Talking hands on"}
                          </button>
                        )}
                      </div>
                    )}
                    {(selectedClip.type === "video" || selectedClip.type === "narration") && (
                      <div>
                        <div style={{ ...panelLabelStyle, marginBottom: 6 }}>Volume {Math.round((selectedClip.muted ? 0 : (selectedClip.volume ?? 1)) * 100)}%</div>
                        <input
                          type="range" min={0} max={1} step={0.01}
                          value={selectedClip.muted ? 0 : (selectedClip.volume ?? 1)}
                          onChange={(e) => { const v = parseFloat(e.target.value); setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, volume: v, muted: false } : c)); }}
                          style={{ width: "100%", accentColor: "#c8f135" }}
                        />
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => copyClip(selectedClipId!)} style={{ ...miniButton, flex: 1, padding: "8px", fontSize: 12 }}>⌘ Copy</button>
                      <button onClick={() => { duplicateClip(selectedClipId!); setMobileDrawer(null); }} style={{ ...miniButton, flex: 1, padding: "8px", fontSize: 12 }}>⎘ Dup</button>
                    </div>
                    <button
                      onClick={() => { deleteClip(selectedClipId!); setMobileDrawer(null); }}
                      style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a", width: "100%", padding: "10px", fontSize: 13, textAlign: "center" }}
                    >✕ Delete clip</button>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* ── Long-press action sheet ── */}
        {mobileLongPressClipId && (
          <>
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 300 }} onClick={() => setMobileLongPressClipId(null)} />
            <div style={{ position: "fixed", left: 16, right: 16, bottom: 36, zIndex: 301, background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a" }}>
              <div onClick={() => { copyClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, borderBottom: "1px solid rgba(42,42,42,0.08)", cursor: "pointer", touchAction: "manipulation" }}>⌘ Copy</div>
              <div onClick={() => { duplicateClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, borderBottom: "1px solid rgba(42,42,42,0.08)", cursor: "pointer", touchAction: "manipulation" }}>⎘ Duplicate</div>
              <div onClick={() => { deleteClip(mobileLongPressClipId); setMobileLongPressClipId(null); }} style={{ padding: "14px 16px", fontFamily: "monospace", fontSize: 13, color: "#ff5e3a", cursor: "pointer", touchAction: "manipulation" }}>✕ Delete</div>
            </div>
          </>
        )}

        {/* ── YouTube modal (shared with desktop) ── */}
        {ytModalOpen && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>
              <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>
                  {ytView === "search" ? "▶ ADD YOUTUBE CLIP" : `▶ TRIM  —  ${(ytSelected?.title ?? "").slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? "…" : ""}`}
                </span>
                <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                {ytView === "search" ? (
                  <>
                    <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                      {(["paste", "search"] as const).map((tab) => (
                        <button key={tab} onClick={() => { setYtTab(tab); setYtError(""); }}
                          style={{ fontFamily: "monospace", padding: "6px 14px", fontSize: 11, fontWeight: ytTab === tab ? 700 : 400, background: ytTab === tab ? "#2a2a2a" : "transparent", color: ytTab === tab ? "#fffdf5" : "#2a2a2a", border: "none", borderBottom: ytTab === tab ? "2px solid #c8f135" : "none", cursor: "pointer" }}>
                          {tab === "paste" ? "Paste URL" : "Search"}
                        </button>
                      ))}
                    </div>
                    {ytTab === "paste" ? (
                      <div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <input autoFocus type="text" value={ytUrlInput}
                            onChange={(e) => setYtUrlInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleYtPasteUrl(); }}
                            placeholder="https://www.youtube.com/watch?v=..."
                            style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                          />
                          <button onClick={handleYtPasteUrl} style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700 }}>Next →</button>
                        </div>
                        {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, margin: 0 }}>{ytError}</p>}
                        <p style={{ fontSize: 10, color: "#9a9a9a", lineHeight: 1.6, marginTop: 10 }}>Paste a YouTube URL — you&apos;ll trim it in the next step.</p>
                      </div>
                    ) : (
                      /* Search tab — identical to desktop render, references same state */
                      (() => {
                        return (
                          <div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                              <input autoFocus type="text" value={ytQuery}
                                onChange={(e) => setYtQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                                placeholder="Search YouTube…"
                                style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                              />
                              <button onClick={() => handleYtSearch()} disabled={ytLoading || !ytQuery.trim()}
                                style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700, opacity: (ytLoading || !ytQuery.trim()) ? 0.5 : 1 }}>
                                {ytLoading ? "…" : "Search"}
                              </button>
                            </div>
                            <div style={{ display: "flex", gap: 0, marginBottom: 12, border: "1.5px solid #2a2a2a", width: "fit-content" }}>
                              {([["All", false], ["Shorts", true]] as const).map(([label, val]) => {
                                const active = ytShortsOnly === val;
                                return (
                                  <button key={label} onClick={() => setYtShortsOnly(val)}
                                    style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a", marginRight: label === "Shorts" ? -1 : 0, position: "relative", zIndex: active ? 1 : 0 }}>
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                            {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, marginBottom: 8, marginTop: 0 }}>{ytError}</p>}
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {ytResults.map((r) => (
                                <div key={r.id} onClick={() => {
                                  const maxSec = parseDurationSec(r.duration);
                                  const initEnd = Math.min(30, maxSec || 30);
                                  setYtSelected(r);
                                  setYtStart(0); setYtStartInput("0:00");
                                  setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
                                  ytRangeRef.current = { start: 0, end: initEnd };
                                  setYtView("trim");
                                }}
                                  style={{ display: "flex", gap: 10, padding: "8px", border: "1.5px solid rgba(42,42,42,0.2)", cursor: "pointer", background: ytSelected?.id === r.id ? "#c8f135" : "transparent" }}>
                                  {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: 80, height: 45, objectFit: "cover", flexShrink: 0 }} />}
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 700, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                                    <div style={{ fontSize: 10, color: "#6a6a6a", marginTop: 2 }}>{r.channel} {r.duration ? `· ${r.duration}` : ""}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()
                    )}
                  </>
                ) : (
                  <>
                    {(() => {
                      const maxSec = parseDurationSec(ytSelected?.duration) || 600;
                      const clipLen = Math.max(0, ytEnd - ytStart);
                      return (
                        <div>
                          <div style={{ marginBottom: 12, fontWeight: 700, fontSize: 12, color: "#2a2a2a" }}>Set trim range (max 30 s)</div>
                          <div ref={ytSliderTrackRef}
                            style={{ position: "relative", height: 36, background: "rgba(42,42,42,0.06)", border: "1.5px solid #2a2a2a", marginBottom: 10, cursor: "pointer" }}
                            onPointerDown={(e) => {
                              const rect = ytSliderTrackRef.current!.getBoundingClientRect();
                              const frac = (e.clientX - rect.left) / rect.width;
                              const t = frac * maxSec;
                              const distStart = Math.abs(t - ytRangeRef.current.start);
                              const distEnd = Math.abs(t - ytRangeRef.current.end);
                              const which = distStart < distEnd ? "start" : "end";
                              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                              const onMove = (ev: PointerEvent) => {
                                const f2 = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                                const newT = f2 * maxSec;
                                if (which === "start") {
                                  const newStart = Math.min(newT, ytRangeRef.current.end - 0.5);
                                  if (ytRangeRef.current.end - newStart > 30) { ytRangeRef.current.start = ytRangeRef.current.end - 30; }
                                  else { ytRangeRef.current.start = newStart; }
                                  setYtStart(ytRangeRef.current.start); setYtStartInput(formatTimestamp(ytRangeRef.current.start));
                                } else {
                                  const newEnd = Math.max(newT, ytRangeRef.current.start + 0.5);
                                  const clampedEnd = Math.min(maxSec, newEnd);
                                  if (clampedEnd - ytRangeRef.current.start > 30) { ytRangeRef.current.end = ytRangeRef.current.start + 30; }
                                  else { ytRangeRef.current.end = clampedEnd; }
                                  setYtEnd(ytRangeRef.current.end); setYtEndInput(formatTimestamp(ytRangeRef.current.end));
                                }
                              };
                              const onUp2 = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp2); };
                              window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp2);
                            }}
                          >
                            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${(ytStart / maxSec) * 100}%`, width: `${((ytEnd - ytStart) / maxSec) * 100}%`, background: "rgba(200,241,53,0.45)", border: "2px solid #2a2a2a" }} />
                            <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${(ytStart / maxSec) * 100}%`, width: 10, height: 24, background: "#2a2a2a", cursor: "ew-resize", marginLeft: -5 }} />
                            <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${(ytEnd / maxSec) * 100}%`, width: 10, height: 24, background: "#2a2a2a", cursor: "ew-resize", marginLeft: -5 }} />
                          </div>
                          <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>Start</div>
                              <input type="text" value={ytStartInput} placeholder="0:00"
                                onChange={(e) => {
                                  setYtStartInput(e.target.value);
                                  const p = parseTimestampSec(e.target.value);
                                  if (p !== null) {
                                    const curEnd = ytRangeRef.current.end;
                                    const newStart = Math.max(0, Math.min(curEnd - 0.5, p));
                                    ytRangeRef.current.start = newStart; setYtStart(newStart);
                                    if (curEnd - newStart > 30) { const newEnd = newStart + 30; ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd)); }
                                  }
                                }}
                                onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                                style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                              <input type="text" value={ytEndInput} placeholder="0:30"
                                onChange={(e) => {
                                  setYtEndInput(e.target.value);
                                  const p = parseTimestampSec(e.target.value);
                                  if (p !== null) {
                                    const newEnd = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30)));
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd);
                                  }
                                }}
                                onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                                style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                              />
                            </div>
                          </div>
                          <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>
                            Clip length: {formatTimestamp(clipLen)}<span style={{ marginLeft: 8 }}>· {formatTimestamp(maxSec)} total</span>
                          </div>
                          {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 6, marginBottom: 0 }}>{ytError}</p>}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
              {ytView === "trim" && (
                <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>← back</button>
                  <button onClick={handleYtConfirm}
                    style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a" }}>
                    Add to board
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Toast ── */}
        {toast && (
          <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135", zIndex: 9999, pointerEvents: "none", whiteSpace: "nowrap" }}>
            {toast}
          </div>
        )}
        {renderDownloadToasts()}
        {renderNeuralSearchModal()}
        {renderTop5Modal()}
        {renderImagePreviewModal()}

        {/* ── Save modal ── */}
        {saveModalOpen && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => setSaveModalOpen(false)}>
            <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", padding: "24px 28px", minWidth: 280, width: "calc(100vw - 48px)", maxWidth: 360, boxShadow: "4px 4px 0 #2a2a2a" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 14 }}>Save project</div>
              <input
                type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)}
                placeholder="Board name" autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveBoard(); if (e.key === "Escape") setSaveModalOpen(false); }}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 16, padding: "12px 10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" as const, marginBottom: 14, outline: "none" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={saveBoard} disabled={isSaving} style={{ ...sketchButton, flex: 1, background: "#c8f135", fontWeight: 700, padding: "10px 0" }}>
                  {isSaving ? "Saving…" : "💾 Download .nbp"}
                </button>
                <button onClick={() => setSaveModalOpen(false)} style={{ ...sketchButton, flex: 1, padding: "10px 0" }}>Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Save / Load ──────────────────────────────────────────────────────────

  async function saveBoard() {
    if (isSaving) return;
    setIsSaving(true);
    setToast("Saving…");
    try {
      type ManifestClip = Omit<Clip, "sourceUrl" | "audioBlob"> & {
        assetFile?: string;
        assetMime?: string;
      };
      type ManifestFace = {
        faceAspect: number;
        mouthAnchor?: HeadLocalPoint;
        assetFile: string;
        assetMime: string;
      };
      type ManifestCharacter = Omit<CharacterInstance, "faceBlobUrl" | "faceAspect"> & {
        face?: ManifestFace | null;
      };
      const manifestClips: ManifestClip[] = [];
      const zipFiles: Record<string, [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};

      for (const clip of clipsRef.current) {
        const { sourceUrl: _s, audioBlob: _a, sourceBlob: _b, ...rest } = clip;
        if (clip.type === "pan" || clip.type === "characterZoom" || clip.type === "customZoom") {
          manifestClips.push(rest);
        } else if (clip.youtubeId) {
          manifestClips.push({ ...rest, needsRedownload: true });
        } else if (clip.type === "narration" && clip.audioBlob) {
          const buf = await clip.audioBlob.arrayBuffer();
          const assetFile = `assets/${clip.id}.${mimeToExt(clip.audioBlob.type, clip.name)}`;
          zipFiles[assetFile] = [new Uint8Array(buf), { level: 0 }];
          manifestClips.push({ ...rest, assetFile, assetMime: clip.audioBlob.type || "audio/wav" });
        } else if (clip.sourceUrl) {
          const blob = await fetch(clip.sourceUrl).then((r) => r.blob());
          const ext = mimeToExt(blob.type, clip.name);
          const assetFile = `assets/${clip.id}.${ext}`;
          const buf = await blob.arrayBuffer();
          zipFiles[assetFile] = [new Uint8Array(buf), { level: 0 }];
          manifestClips.push({ ...rest, assetFile, assetMime: blob.type });
        } else {
          manifestClips.push(rest);
        }
      }

      const saveFaceAsset = async (face: CharacterFaceSettings | null, assetFile: string): Promise<ManifestFace | null> => {
        if (!face?.faceBlobUrl) return null;
        const blob = await fetch(face.faceBlobUrl).then((r) => r.blob());
        const buf = await blob.arrayBuffer();
        zipFiles[assetFile] = [new Uint8Array(buf), { level: 0 }];
        return {
          faceAspect: face.faceAspect,
          mouthAnchor: face.mouthAnchor,
          assetFile,
          assetMime: blob.type || "image/png",
        };
      };
      const manifestFace = await saveFaceAsset(characterFaceRef.current, "assets/character-face-c1.png");
      const manifestFace2 = await saveFaceAsset(characterFace2Ref.current, "assets/character-face-c2.png");
      const manifestCharacters: ManifestCharacter[] = [
        { id: "c1", enabled: showCharacterRef.current, accentColor: "#2a2a2a", mode: characterModeRef.current, skin: characterSkinRef.current, actions: characterActionsRef.current, start: characterStart ?? undefined, face: manifestFace },
        { id: "c2", enabled: showCharacter2Ref.current, accentColor: "#3a3a5a", mode: characterMode2Ref.current, skin: characterSkin2Ref.current, actions: characterActions2Ref.current, start: characterStart2 ?? undefined, face: manifestFace2 },
      ];

      const manifest = {
        version: 1,
        name: saveName,
        savedAt: new Date().toISOString(),
        clips: manifestClips,
        cameraKeyframes: cameraKeyframesRef.current,
        cameraMode: cameraModeRef.current,
        cameraKeyframeMode: cameraKeyframeModeRef.current,
        annotations: annotationsRef.current,
        canvasAspect,
        pxPerSec: pxPerSecRef.current,
        boardZoom: boardZoomRef.current,
        boardPan: boardPanRef.current,
        characterActions: characterActionsRef.current,
        showCharacter: showCharacterRef.current,
        characterMode: characterModeRef.current,
        characterSkin: characterSkinRef.current,
        characterFace: manifestFace,
        characterStart: characterStart ?? undefined,
        characters: manifestCharacters,
        spawnDoor: spawnDoorRef.current,
      };
      zipFiles["manifest.json"] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];

      const zipped = zipSync(zipFiles);
      const zippedBytes = new Uint8Array(zipped.byteLength);
      zippedBytes.set(zipped);
      const dlBlob = new Blob([zippedBytes.buffer], { type: "application/zip" });
      const url = URL.createObjectURL(dlBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(saveName || "board").replace(/[^a-z0-9_-]/gi, "_")}.nbp`;
      a.click();
      URL.revokeObjectURL(url);
      setSaveModalOpen(false);
      setToast("Board saved!");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadBoard(file: File) {
    if (isLoadingProject) return;
    setIsLoadingProject(true);
    setToast("Loading project…");
    try {
      type ManifestFace = {
        faceAspect: number;
        mouthAnchor?: HeadLocalPoint;
        assetFile: string;
        assetMime: string;
      };
      const buffer = await file.arrayBuffer();
      const files = unzipSync(new Uint8Array(buffer));
      if (!files["manifest.json"]) throw new Error("Not a valid .nbp file");
      const manifest = JSON.parse(strFromU8(files["manifest.json"]));

      // Revoke existing blob URLs
      for (const clip of clipsRef.current) {
        if (clip.sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(clip.sourceUrl);
      }
      if (characterFaceRef.current?.faceBlobUrl?.startsWith("blob:")) URL.revokeObjectURL(characterFaceRef.current.faceBlobUrl);
      if (characterFace2Ref.current?.faceBlobUrl?.startsWith("blob:")) URL.revokeObjectURL(characterFace2Ref.current.faceBlobUrl);
      // Clean up all video elements
      for (const vid of videoElsRef.current.values()) { vid.pause(); vid.src = ""; }
      videoElsRef.current.clear();
      imgCacheRef.current.clear();

      const loadedClips: Clip[] = [];
      for (const mc of (manifest.clips ?? [])) {
        if (mc.type === "pan" || mc.type === "characterZoom" || mc.type === "customZoom") {
          loadedClips.push({ ...mc, sourceUrl: "" });
        } else if (mc.needsRedownload) {
          loadedClips.push({ ...mc, sourceUrl: "" });
        } else if (mc.assetFile && files[mc.assetFile]) {
          const data = files[mc.assetFile];
          const assetBytes = new Uint8Array(data.byteLength);
          assetBytes.set(data);
          const blob = new Blob([assetBytes.buffer], { type: mc.assetMime || "application/octet-stream" });
          const blobUrl = URL.createObjectURL(blob);
          if (mc.type === "narration") {
            loadedClips.push({ ...mc, sourceUrl: blobUrl, audioBlob: blob });
          } else if (mc.type === "image") {
            loadMedia(blobUrl, "image");
            loadedClips.push({ ...mc, sourceUrl: blobUrl });
          } else if (mc.type === "video") {
            createVideoElement(mc.id, blobUrl);
            loadedClips.push({ ...mc, sourceUrl: blobUrl });
          }
        } else {
          loadedClips.push({ ...mc, sourceUrl: mc.sourceUrl ?? "" });
        }
      }

      setClips(loadedClips);
      const loadedCameraKeyframes = manifest.cameraKeyframes ?? [];
      const loadedCameraMode: CameraMode = manifest.cameraMode === "character" ? "character" : "clips";
      const loadedKeyframeMode: CameraMode = manifest.cameraKeyframeMode === "character" ? "character" : "clips";
      setCameraKeyframes(loadedCameraKeyframes);
      cameraKeyframesRef.current = loadedCameraKeyframes;
      setCameraMode(loadedCameraMode);
      cameraModeRef.current = loadedCameraMode;
      setCameraKeyframeMode(loadedKeyframeMode);
      cameraKeyframeModeRef.current = loadedKeyframeMode;
      setAnnotations(manifest.annotations ?? []);
      setSpawnDoor(manifest.spawnDoor ?? null);
      if (manifest.canvasAspect) setCanvasAspect(manifest.canvasAspect);
      if (manifest.pxPerSec) { pxPerSecRef.current = manifest.pxPerSec; setPxPerSec(manifest.pxPerSec); }
      if (manifest.boardZoom) { boardZoomRef.current = manifest.boardZoom; setBoardZoom(manifest.boardZoom); }
      if (manifest.boardPan) { boardPanRef.current = manifest.boardPan; setBoardPan(manifest.boardPan); }
      if (manifest.name) setSaveName(manifest.name);
      const loadFace = (face: ManifestFace | null | undefined): CharacterFaceSettings | null => {
        if (!face?.assetFile || !files[face.assetFile]) return null;
        const faceData = files[face.assetFile];
        const faceBytes = new Uint8Array(faceData.byteLength);
        faceBytes.set(faceData);
        const faceBlob = new Blob([faceBytes.buffer], { type: face.assetMime || "image/png" });
        return {
          faceBlobUrl: URL.createObjectURL(faceBlob),
          faceAspect: face.faceAspect ?? 1,
          mouthAnchor: face.mouthAnchor,
        };
      };
      const loadStart = (value: unknown): { x: number; y: number } | null => {
        if (!value || typeof value !== "object") return null;
        const point = value as { x?: unknown; y?: unknown };
        return typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
          ? { x: point.x, y: point.y }
          : null;
      };
      if (Array.isArray(manifest.characters)) {
        type LoadedCharacter = Partial<CharacterInstance> & { id?: CharacterId; face?: ManifestFace | null };
        const c1 = (manifest.characters as LoadedCharacter[]).find((c) => c.id === "c1");
        const c2 = (manifest.characters as LoadedCharacter[]).find((c) => c.id === "c2");
        setCharacterActions(c1?.actions ?? []);
        setShowCharacter(c1?.enabled ?? false);
        setCharacterMode(c1?.mode ?? "auto");
        setCharacterSkin(c1?.skin === "styled" ? "styled" : "stick");
        setCharacterFace(loadFace(c1?.face));
        setCharacterStart(loadStart(c1?.start));
        setCharacterActions2(c2?.actions ?? []);
        setShowCharacter2(c2?.enabled ?? false);
        setCharacterMode2(c2?.mode ?? "auto");
        setCharacterSkin2(c2?.skin === "styled" ? "styled" : "stick");
        setCharacterFace2(loadFace(c2?.face));
        setCharacterStart2(loadStart(c2?.start));
      } else {
        if (manifest.characterActions) setCharacterActions(manifest.characterActions);
        else setCharacterActions([]);
        if (manifest.showCharacter !== undefined) setShowCharacter(manifest.showCharacter);
        else setShowCharacter(false);
        if (manifest.characterMode) setCharacterMode(manifest.characterMode);
        else setCharacterMode("auto");
        setCharacterSkin(manifest.characterSkin === "styled" ? "styled" : "stick");
        setCharacterFace(loadFace(manifest.characterFace));
        setCharacterStart(loadStart(manifest.characterStart));
        setCharacterActions2([]);
        setShowCharacter2(false);
        setCharacterMode2("auto");
        setCharacterSkin2("stick");
        setCharacterFace2(null);
        setCharacterStart2(null);
      }
      setToast(`Loaded "${manifest.name ?? "board"}"`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setIsLoadingProject(false);
    }
  }

  async function redownloadYtClip(clipId: string) {
    const clip = clipsRef.current.find((c) => c.id === clipId);
    if (!clip?.youtubeId) return;
    setToast("Re-downloading video…");
    try {
      const dlRes = await fetch("/api/ytdl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${clip.youtubeId}`, start: clip.ytStart ?? 0, end: clip.ytEnd ?? 30 }),
      });
      if (!dlRes.ok) {
        const err = await dlRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Download failed (${dlRes.status})`);
      }
      const blob = await dlRes.blob();
      const blobUrl = URL.createObjectURL(blob);
      createVideoElement(clipId, blobUrl);
      setClips((prev) => prev.map((c) => c.id !== clipId ? c : { ...c, sourceUrl: blobUrl, sourceBlob: blob, needsRedownload: false }));
      setToast("Video ready");
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Re-download failed");
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={pageStyle}>
      <div ref={videoHiddenContainerRef} style={{ display: "none" }} aria-hidden="true" />
      <style>{`@keyframes nbpulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {/* ── Header ── */}
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Caveat', cursive", fontSize: 28, fontWeight: 700, color: "#2a2a2a" }}>Neural Board</span>
          <span style={{ fontSize: 11, color: "#6a6a6a", letterSpacing: 1, fontFamily: "monospace" }}>/ BOARD 2.0</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{ display: "flex", border: "1px solid rgba(42,42,42,0.35)", overflow: "hidden" }}
              title={!showCharacter ? "Enable Character 1 to use character-centric camera mode" : "Choose what drives camera generation"}
            >
              {(["clips", "character"] as const).map((mode) => {
                const disabled = mode === "character" && !showCharacter;
                return (
                  <button
                    key={mode}
                    disabled={disabled}
                    onClick={() => {
                      setCameraMode(mode);
                      cameraModeRef.current = mode;
                      if (cameraKeyframesRef.current.length > 0 && mode !== cameraKeyframeModeRef.current) setKeyframesOutOfDate(true);
                    }}
                    title={disabled ? "Enable Character 1 first" : `${mode === "clips" ? "Clip schedule" : "Character 1 choreography"} drives camera keyframes`}
                    style={{
                      padding: "4px 7px", fontFamily: "monospace", fontSize: 9,
                      border: "none", borderRight: mode === "clips" ? "1px solid rgba(42,42,42,0.35)" : "none",
                      background: cameraMode === mode ? "#2a2a2a" : "#fffdf5",
                      color: cameraMode === mode ? "#c8f135" : "#2a2a2a",
                      opacity: disabled ? 0.4 : 1,
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {mode === "clips" ? "Clips" : "Character"}
                  </button>
                );
              })}
            </div>
            <button
              onClick={generateCameraKeyframes}
              disabled={!canGenerateCamera}
              title={canGenerateCamera
                ? cameraMode === "character"
                  ? "Generate camera keyframes from Character 1 choreography"
                  : "Generate camera keyframe sequence from board positions and timeline"
                : cameraMode === "character" ? "Enable Character 1 first" : "Upload media first"}
              style={{
                ...sketchButton,
                padding: "4px 10px",
                fontSize: 11,
                opacity: canGenerateCamera ? 1 : 0.45,
                cursor: canGenerateCamera ? "pointer" : "not-allowed",
              }}
            >
              ⬡ Generate camera keyframes
            </button>
            {keyframesOutOfDate && cameraKeyframes.length > 0 && (
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#ff5e3a", border: "1px solid #ff5e3a", padding: "2px 5px", whiteSpace: "nowrap" }}>
                ↻ keyframes out of date
              </span>
            )}
          </div>
          <ProGated featureName="Play Mode">
            <button onClick={enterPlayMode} style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, background: "#c8f135", fontWeight: 700 }} title="Full-window direct character control">▶ Play</button>
          </ProGated>
          <button onClick={() => setSaveModalOpen(true)} style={{ ...sketchButton, padding: "4px 10px", fontSize: 11 }} title="Save board to file">💾 Save</button>
          <button onClick={() => projectFileInputRef.current?.click()} disabled={isLoadingProject} style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, opacity: isLoadingProject ? 0.5 : 1 }} title="Load board from .nbp file">📂 Load</button>
          <span style={{ ...navLinkStyle, color: "#2a2a2a", fontWeight: 700 }}>Board</span>
          {session?.user ? (
            <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>{session.user.email}</span>
          ) : (
            <button
              onClick={() => signIn("google", { callbackUrl: "/board2" })}
              style={{ fontFamily: "monospace", background: "transparent", border: "1px solid #2a2a2a", padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
            >
              sign in →
            </button>
          )}
        </div>
      </header>

      {/* ── Main workspace ── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column", overflow: "hidden" }}>

        {/* Top row: media | board+preview | properties */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, borderBottom: "1.5px solid rgba(42,42,42,0.15)" }}>

          {/* ── Left: media library ── */}
          <div style={{ width: 210, flexShrink: 0, borderRight: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={panelLabelStyle}>Media Library</div>
            <button onClick={() => mediaUploadRef.current?.click()} style={sketchButton}>↑ Upload media</button>
            <button
              onClick={() => addPanClip()}
              style={{ ...sketchButton, background: PAN_CLIP_COLOR, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
              title="Add a pan clip that sweeps across all board images"
            >
              ⟷ Add pan clip
            </button>
            <button
              onClick={() => addCharacterZoomClip()}
              style={{ ...sketchButton, background: CHARACTER_ZOOM_CLIP_COLOR, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
              title="Add a camera clip that follows and zooms on the character"
            >
              ◎ Zoom on character
            </button>
            <button
              onClick={() => setCustomZoomDrawMode((v) => !v)}
              style={{
                ...sketchButton, background: CUSTOM_ZOOM_CLIP_COLOR, fontSize: 11, padding: "6px 10px", fontWeight: 700,
                outline: customZoomDrawMode ? "2px solid #2e8fff" : "none", outlineOffset: -2,
              }}
              title="Click, then drag a box on the board to zoom into that exact region"
            >
              {customZoomDrawMode ? "🔍 Drag a box on the board…" : "🔍 Draw custom zoom"}
            </button>
            <button
              onClick={() => { setYtModalOpen(true); setYtView("search"); setYtTab("search"); setYtError(""); }}
              style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700 }}
            >
              ▶ Add YouTube
            </button>

            {AI_FEATURES_ENABLED && <ProGated featureName="Neural Search">
              <button
                onClick={() => { setNeuralModalOpen(true); setNeuralConcept(""); setNeuralError(""); setNeuralPhase(null); }}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%", background: "#e4cfff" }}
              >
                🔮 Neural Search
              </button>
            </ProGated>}

            {AI_FEATURES_ENABLED && <ProGated featureName="Top 5 Neural Search">
              <button
                onClick={() => { setTop5ModalOpen(true); setTop5Concept(""); setTop5Error(""); setTop5Phase(null); }}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%", background: "#fef3c7" }}
              >
                🏆 Top 5
              </button>
            </ProGated>}

            <ProGated featureName="Narration Recording">
              <button
                onClick={isRecording ? stopNarrationRecording : startNarrationRecording}
                style={{
                  ...sketchButton,
                  fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%",
                  background: isRecording ? "#ff5e3a" : "#2a2a2a",
                  color: "#fff",
                }}
              >
                {isRecording ? (
                  <>⏹ Stop ({Math.floor(recElapsed / 60)}:{String(Math.floor(recElapsed % 60)).padStart(2, "0")})</>
                ) : "🎙 Record Narration"}
              </button>
              <button
                onClick={() => narrationUploadRef.current?.click()}
                style={{ ...sketchButton, fontSize: 11, padding: "6px 10px", fontWeight: 700, width: "100%" }}
              >
                ↑ Upload audio / mp4
              </button>
              <input
                ref={narrationUploadRef}
                type="file"
                accept="audio/*,video/mp4,video/quicktime,video/webm"
                style={{ display: "none" }}
                onChange={handleNarrationUpload}
              />
            </ProGated>
            {isRecording && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#ff5e3a", fontFamily: "monospace" }}>
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#ff5e3a", animation: "nbpulse 1s infinite" }} />
                recording...
              </div>
            )}

            <div style={{ width: "100%", height: 1, background: "rgba(42,42,42,0.15)", margin: "4px 0" }} />

            {AI_FEATURES_ENABLED && <ProGated featureName="AI Annotation Generation">
              {(() => {
                const hasBoardClips = clips.filter((c) => c.boardX !== undefined).length > 0;
                const hasNarration = clips.some((c) => c.type === "narration");
                const busy = !!aiPhase;
                const disabled = !hasBoardClips || busy;
                return (
                  <>
                    <button
                      onClick={() => {
                        if (disabled) return;
                        if (hasNarration) {
                          setAiError(null);
                          generateAnnotationsFromNarration();
                        } else {
                          setAiModalOpen(true);
                          setAiError(null);
                          setAiPhase(null);
                          setAiAudioFile(null);
                          setAiScriptText("");
                          setAiTab("audio");
                        }
                      }}
                      disabled={disabled}
                      title={
                        !hasBoardClips ? "Place images on the board first"
                        : hasNarration ? "Generate annotations from your timeline narration"
                        : "Generate annotations from narration audio or script"
                      }
                      style={{
                        ...sketchButton,
                        fontSize: 11,
                        padding: "6px 10px",
                        fontWeight: 700,
                        width: "100%",
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                    >
                      {busy ? `⟳ ${aiPhase}` : hasNarration ? "✨ Generate Annotations (from narration)" : "✨ Generate Annotations"}
                    </button>
                    {!aiModalOpen && aiError && (
                      <div style={{ fontSize: 10, color: "#cc2200", marginTop: 4, fontFamily: "monospace", lineHeight: 1.4 }}>
                        ✗ {aiError}
                      </div>
                    )}
                  </>
                );
              })()}
            </ProGated>}

            <input
              ref={mediaUploadRef}
              type="file"
              accept="image/*,video/*"
              multiple
              style={{ display: "none" }}
              onChange={handleMediaUpload}
            />
            <input
              ref={projectFileInputRef}
              type="file"
              accept=".nbp,.zip"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadBoard(f); }}
            />
            <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: "4px 0 0" }}>
              Upload images or videos — they auto-place on the board and timeline.
            </p>
          </div>

          {/* ── Center: board (primary) + preview overlay ── */}
          <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden", background: "rgba(20,20,20,0.06)" }}>

            {/* Board container — fills the whole center */}
            <div
              ref={boardContainerRef}
              style={{ position: "absolute", inset: 0, overflow: "hidden", cursor: "default" }}
              onPointerDown={handleBoardPointerDown}
            >
              {/* Board surface */}
              <div
                style={{
                  position: "absolute",
                  left: boardPan.x,
                  top: boardPan.y,
                  width: BOARD_W * boardZoom,
                  height: BOARD_H * boardZoom,
                  background: "#f7e5c1",
                  border: "1.5px solid #2a2a2a",
                  boxShadow: "4px 4px 18px rgba(42,42,42,0.3)",
                }}
                onPointerDown={handleBoardSurfacePointerDown}
              >
                {boardMarquee && (() => {
                  const x = Math.min(boardMarquee.startX, boardMarquee.currentX) * boardZoom;
                  const y = Math.min(boardMarquee.startY, boardMarquee.currentY) * boardZoom;
                  const w = Math.abs(boardMarquee.currentX - boardMarquee.startX) * boardZoom;
                  const h = Math.abs(boardMarquee.currentY - boardMarquee.startY) * boardZoom;
                  return (
                    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: "1.5px dashed #ff5e3a", background: "rgba(255,94,58,0.1)", pointerEvents: "none", zIndex: 20 }} />
                  );
                })()}
                {/* eslint-disable-next-line react-hooks/refs */}
                {clips.filter((c) => c.boardX !== undefined).map((clip) => {
                  const isSel = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                  return (
                    <div
                      key={clip.id}
                      style={{
                        position: "absolute",
                        left: clip.boardX! * boardZoom,
                        top: clip.boardY! * boardZoom,
                        width: clip.boardW! * boardZoom,
                        height: clip.boardH! * boardZoom,
                        border: isSel ? "2px solid #ff5e3a" : clip.type === "customZoom" ? "1.5px dashed #2e8fff" : "1.5px solid rgba(42,42,42,0.4)",
                        boxShadow: isSel
                          ? "0 0 0 1px #ff5e3a, 1px 1px 6px rgba(42,42,42,0.25)"
                          : "1px 1px 4px rgba(42,42,42,0.2)",
                        cursor: "grab",
                        overflow: "visible",
                      }}
                      onClick={(e) => { e.stopPropagation(); setClipSelection([clip.id]); }}
                      onPointerDown={(e) => { if (!isSpaceDown) handleBoardClipPointerDown(e, clip); }}
                    >
                      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                        {clip.needsRedownload ? (
                          <div
                            style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", gap: 4 }}
                            onClick={(e) => { e.stopPropagation(); redownloadYtClip(clip.id); }}
                          >
                            <span style={{ color: "#ff9f5e", fontSize: 18, pointerEvents: "none" }}>▶</span>
                            <span style={{ color: "#ff9f5e", fontSize: 8, fontFamily: "monospace", textAlign: "center", pointerEvents: "none", padding: "0 4px" }}>click to re-download</span>
                          </div>
                        ) : clip.type === "image" ? (
                          <canvas
                            ref={(canvas) => {
                              if (canvas) boardImageCanvasRefs.current.set(clip.id, canvas);
                              else boardImageCanvasRefs.current.delete(clip.id);
                            }}
                            width={Math.max(1, Math.round(clip.boardW!))}
                            height={Math.max(1, Math.round(clip.boardH!))}
                            aria-label={clip.name}
                            style={{ width: "100%", height: "100%", display: "block", userSelect: "none", pointerEvents: "none", transformOrigin: "center" }}
                          />
                        ) : clip.type === "customZoom" ? (
                          <div style={{ width: "100%", height: "100%", background: "rgba(184,226,255,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ color: "#1c6fc9", fontSize: 20, pointerEvents: "none" }}>🔍</span>
                          </div>
                        ) : (
                          <div style={{ width: "100%", height: "100%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ color: "#7df5b0", fontSize: 11, fontFamily: "monospace", pointerEvents: "none" }}>▶ {clip.name}</span>
                          </div>
                        )}
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "1px 4px", background: "rgba(42,42,42,0.7)", color: "#fff", fontSize: 9, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none" }}>
                          {clip.name}
                        </div>
                      </div>
                      {isSel && (["nw", "ne", "sw", "se"] as const).map((corner) => (
                        <div
                          key={corner}
                          style={{
                            position: "absolute",
                            width: BOARD_RESIZE_PX,
                            height: BOARD_RESIZE_PX,
                            background: "#ff5e3a",
                            border: "1.5px solid #fff",
                            cursor: (corner === "nw" || corner === "se") ? "nwse-resize" : "nesw-resize",
                            zIndex: 10,
                            ...(corner === "nw" ? { left: -BOARD_RESIZE_PX / 2, top: -BOARD_RESIZE_PX / 2 } :
                                corner === "ne" ? { right: -BOARD_RESIZE_PX / 2, top: -BOARD_RESIZE_PX / 2 } :
                                corner === "sw" ? { left: -BOARD_RESIZE_PX / 2, bottom: -BOARD_RESIZE_PX / 2 } :
                                                 { right: -BOARD_RESIZE_PX / 2, bottom: -BOARD_RESIZE_PX / 2 }),
                          }}
                          onPointerDown={(e) => handleBoardResizePointerDown(e, clip, corner)}
                        />
                      ))}
                    </div>
                  );
                })}

                <canvas
                  ref={boardCharacterCanvasRef}
                  width={BOARD_W}
                  height={BOARD_H}
                  aria-label="Characters on board"
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 6 }}
                />

                {/* Neural Search placeholders — not yet downloaded, click to trim & add */}
                {AI_FEATURES_ENABLED && neuralPlaceholders.map((ph) => (
                  <div
                    key={ph.id}
                    style={{
                      position: "absolute",
                      left: ph.boardX * boardZoom,
                      top: ph.boardY * boardZoom,
                      width: ph.boardW * boardZoom,
                      height: ph.boardH * boardZoom,
                      border: "2px dashed #a855f7",
                      boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                      cursor: "pointer",
                      overflow: "visible",
                    }}
                    onClick={(e) => { e.stopPropagation(); openTrimModalForPlaceholder(ph); }}
                    onMouseEnter={() => setHoveredPlaceholderId(ph.id)}
                    onMouseLeave={() => setHoveredPlaceholderId((prev) => (prev === ph.id ? null : prev))}
                  >
                    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#1a1a2e" }}>
                      {ph.thumbnailUrl && (
                        <img
                          src={ph.thumbnailUrl}
                          alt={ph.title}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.85, userSelect: "none", pointerEvents: "none" }}
                          draggable={false}
                        />
                      )}
                      <div style={{ position: "absolute", top: 3, left: 3, padding: "1px 5px", background: "#a855f7", color: "#fff", fontSize: 9, fontFamily: "monospace", fontWeight: 700, pointerEvents: "none" }}>
                        🔮 NOT ADDED
                      </div>
                    </div>
                    {hoveredPlaceholderId === ph.id && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0, padding: "4px 6px",
                        background: "rgba(42,42,42,0.85)", color: "#fff", fontFamily: "monospace",
                        pointerEvents: "none",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.title}</div>
                        {ph.viewCount > 0 && <div style={{ fontSize: 9, color: "#d4a8ff", marginTop: 1 }}>{formatViewCount(ph.viewCount)}</div>}
                      </div>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeNeuralPlaceholder(ph.id); }}
                      title="Remove"
                      style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: "50%", background: "#ff5e3a", border: "1.5px solid #fff", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {/* Neural Search image placeholders — not yet downloaded, click to preview & add */}
                {AI_FEATURES_ENABLED && imagePlaceholders.map((ph) => (
                  <div
                    key={ph.id}
                    style={{
                      position: "absolute",
                      left: ph.boardX * boardZoom,
                      top: ph.boardY * boardZoom,
                      width: ph.boardW * boardZoom,
                      height: ph.boardH * boardZoom,
                      border: "2px dashed #3b82f6",
                      boxShadow: "1px 1px 4px rgba(42,42,42,0.2)",
                      cursor: "pointer",
                      overflow: "visible",
                    }}
                    onClick={(e) => { e.stopPropagation(); setImagePreviewTarget(ph); }}
                    onMouseEnter={() => setHoveredPlaceholderId(ph.id)}
                    onMouseLeave={() => setHoveredPlaceholderId((prev) => (prev === ph.id ? null : prev))}
                  >
                    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#3a3a3a" }}>
                      <img
                        src={ph.imageUrl}
                        alt={ph.title}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: 0.9, userSelect: "none", pointerEvents: "none" }}
                        draggable={false}
                        onError={() => removeImagePlaceholder(ph.id)}
                      />
                      <div style={{ position: "absolute", top: 3, left: 3, padding: "1px 5px", background: "#3b82f6", color: "#fff", fontSize: 9, fontFamily: "monospace", fontWeight: 700, pointerEvents: "none" }}>
                        🖼 NOT ADDED
                      </div>
                    </div>
                    {hoveredPlaceholderId === ph.id && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0, padding: "4px 6px",
                        background: "rgba(42,42,42,0.85)", color: "#fff", fontFamily: "monospace",
                        pointerEvents: "none",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ph.title}</div>
                      </div>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeImagePlaceholder(ph.id); }}
                      title="Remove"
                      style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: "50%", background: "#ff5e3a", border: "1.5px solid #fff", color: "#fff", fontSize: 10, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}

                {/* SVG visual layer for non-text annotations */}
                <svg
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4, overflow: "visible" }}
                >
                  {annotations.filter((a) => a.type !== "text").map((ann) => {
                    if (ann.type === "arrow" && ann.arrowStartX !== undefined) {
                      const x1 = ann.arrowStartX * boardZoom, y1 = ann.arrowStartY! * boardZoom;
                      const x2 = ann.arrowEndX! * boardZoom, y2 = ann.arrowEndY! * boardZoom;
                      const angle = Math.atan2(y2 - y1, x2 - x1);
                      const hl = 15;
                      const sw = ann.strokeWidth ?? 3;
                      return (
                        <g key={ann.id}>
                          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                          <line x1={x2} y1={y2} x2={x2 - hl * Math.cos(angle - Math.PI / 6)} y2={y2 - hl * Math.sin(angle - Math.PI / 6)} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                          <line x1={x2} y1={y2} x2={x2 - hl * Math.cos(angle + Math.PI / 6)} y2={y2 - hl * Math.sin(angle + Math.PI / 6)} stroke={ann.color} strokeWidth={sw} strokeLinecap="round" />
                        </g>
                      );
                    } else if (ann.type === "circle") {
                      return (
                        <ellipse key={ann.id}
                          cx={ann.boardX * boardZoom + ann.boardW * boardZoom / 2}
                          cy={ann.boardY * boardZoom + ann.boardH * boardZoom / 2}
                          rx={ann.boardW * boardZoom / 2} ry={ann.boardH * boardZoom / 2}
                          fill="none" stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3}
                        />
                      );
                    } else if (ann.type === "highlight") {
                      const style = ann.highlightStyle ?? "rect";
                      const bx = ann.boardX * boardZoom, by = ann.boardY * boardZoom;
                      const bw = ann.boardW * boardZoom, bh = ann.boardH * boardZoom;
                      if (style === "rect") return <rect key={ann.id} x={bx} y={by} width={bw} height={bh} fill={ann.color} fillOpacity={0.3} />;
                      if (style === "underline") return <line key={ann.id} x1={bx} y1={by + bh} x2={bx + bw} y2={by + bh} stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3} strokeLinecap="round" />;
                      // curlyBrace
                      const cx = bx + bw, mid = by + bh / 2, q = Math.min(20, bh * 0.15);
                      return <path key={ann.id} d={`M ${cx} ${by} C ${cx+q} ${by}, ${cx+q} ${mid - bh*0.05}, ${cx} ${mid} C ${cx+q} ${mid + bh*0.05}, ${cx+q} ${by+bh}, ${cx} ${by+bh}`} fill="none" stroke={ann.color} strokeWidth={ann.strokeWidth ?? 3} strokeLinecap="round" />;
                    } else if (ann.type === "pen" && ann.points && ann.points.length >= 2) {
                      const d = ann.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x * boardZoom} ${p.y * boardZoom}`).join(" ");
                      return <path key={ann.id} d={d} fill="none" stroke={ann.color} strokeWidth={(ann.strokeWidth ?? 4) * boardZoom} strokeLinecap="round" strokeLinejoin="round" />;
                    } else if (ann.type === "emoji" && ann.emoji) {
                      return (
                        <text key={ann.id}
                          x={(ann.boardX + ann.boardW / 2) * boardZoom}
                          y={(ann.boardY + ann.boardH / 2) * boardZoom}
                          fontSize={(ann.fontSize ?? 120) * boardZoom}
                          textAnchor="middle" dominantBaseline="central"
                          style={{ userSelect: "none" }}
                        >{ann.emoji}</text>
                      );
                    }
                    return null;
                  })}
                  {/* Live pen preview during drawing */}
                  {penPreviewPoints && penPreviewPoints.length >= 2 && (
                    <path
                      d={penPreviewPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x * boardZoom} ${p.y * boardZoom}`).join(" ")}
                      fill="none" stroke={annotationColor} strokeWidth={4 * boardZoom}
                      strokeLinecap="round" strokeLinejoin="round" opacity={0.7}
                    />
                  )}
                </svg>

                {/* Annotation DOM overlays (hit targets + text rendering + resize handles) */}
                {/* eslint-disable-next-line react-hooks/refs */}
                {annotations.map((ann) => {
                  const isSel = ann.id === selectedAnnotationId || selectedAnnotationIds.includes(ann.id);
                  const isEditing = ann.id === editingAnnotationId;
                  const showHandles = isSel && annotationTool === "pointer" && !isEditing;
                  return (
                    <div
                      key={ann.id}
                      style={{
                        position: "absolute",
                        left: ann.boardX * boardZoom,
                        top: ann.boardY * boardZoom,
                        width: ann.type === "text" ? "auto" : ann.boardW * boardZoom,
                        height: ann.type === "text" ? "auto" : ann.boardH * boardZoom,
                        minWidth: ann.type === "text" ? ann.boardW * boardZoom : undefined,
                        outline: isSel && !isEditing ? "2px dashed #ff5e3a" : "none",
                        outlineOffset: 3,
                        cursor: annotationTool === "pointer" ? "pointer" : "default",
                        zIndex: 5,
                        pointerEvents: annotationTool === "pointer" || isEditing ? "auto" : "none",
                      }}
                      onClick={(e) => { if (annotationTool === "pointer") { e.stopPropagation(); setAnnotationSelection([ann.id]); } }}
                      onDoubleClick={(e) => {
                        if (ann.type === "text" && annotationTool === "pointer") {
                          e.stopPropagation();
                          setEditingAnnotationId(ann.id);
                          setEditingAnnotationText(ann.text ?? "");
                        }
                      }}
                      onPointerDown={(e) => { if (annotationTool === "pointer") handleAnnotationPointerDown(e, ann); }}
                    >
                      {ann.type === "text" && !isEditing && (
                        <div style={{
                          fontFamily: `'${ann.fontFamily ?? "Caveat"}', cursive`,
                          fontSize: (ann.fontSize ?? 80) * boardZoom,
                          fontWeight: ann.fontWeight ?? "normal",
                          color: ann.color,
                          userSelect: "none",
                          pointerEvents: "none",
                          whiteSpace: "pre",
                          lineHeight: 1.2,
                        }}>
                          {ann.text || <span style={{ opacity: 0.25, fontFamily: "monospace", fontSize: 11 }}>click to type…</span>}
                        </div>
                      )}
                      {ann.type === "text" && isEditing && (
                        <textarea
                          ref={(el) => { if (isEditing) editingTextareaRef.current = el; }}
                          value={editingAnnotationText}
                          onChange={(e) => setEditingAnnotationText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTextEdit(ann.id); }
                            else if (e.key === "Escape") { if (!ann.text) deleteAnnotation(ann.id); else setEditingAnnotationId(null); }
                          }}
                          onBlur={() => commitTextEdit(ann.id)}
                          style={{
                            fontFamily: `'${ann.fontFamily ?? "Caveat"}', cursive`,
                            fontSize: (ann.fontSize ?? 80) * boardZoom,
                            fontWeight: ann.fontWeight ?? "normal",
                            color: ann.color,
                            background: "rgba(255,255,255,0.15)",
                            border: "1px dashed rgba(255,94,58,0.6)",
                            outline: "none",
                            resize: "none",
                            minWidth: ann.boardW * boardZoom,
                            minHeight: (ann.fontSize ?? 80) * boardZoom * 1.4,
                            padding: 0,
                            lineHeight: 1.2,
                            whiteSpace: "pre",
                          }}
                        />
                      )}
                      {/* Resize handles */}
                      {showHandles && (
                        ann.type === "arrow" && ann.arrowStartX !== undefined ? (
                          // Arrow: two endpoint handles
                          (["start", "end"] as const).map((which) => {
                            const hx = ((which === "start" ? ann.arrowStartX! : ann.arrowEndX!) - ann.boardX) * boardZoom;
                            const hy = ((which === "start" ? ann.arrowStartY! : ann.arrowEndY!) - ann.boardY) * boardZoom;
                            return (
                              <div key={which} style={{
                                position: "absolute", left: hx - 6, top: hy - 6,
                                width: 12, height: 12, background: "#ff5e3a",
                                border: "2px solid #fff", borderRadius: "50%",
                                cursor: "move", zIndex: 20,
                              }}
                              onPointerDown={(e) => handleArrowEndpointDrag(e, ann, which)} />
                            );
                          })
                        ) : (
                          // All other types: four corner handles
                          (["nw", "ne", "sw", "se"] as const).map((corner) => (
                            <div key={corner} style={{
                              position: "absolute",
                              ...(corner === "nw" ? { left: -5, top: -5 } :
                                  corner === "ne" ? { right: -5, top: -5 } :
                                  corner === "sw" ? { left: -5, bottom: -5 } :
                                                    { right: -5, bottom: -5 }),
                              width: 10, height: 10, background: "#ff5e3a",
                              border: "1.5px solid #fff",
                              cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                              zIndex: 20,
                            }}
                            onPointerDown={(e) => { e.stopPropagation(); handleAnnotationCornerResize(e, ann, corner); }} />
                          ))
                        )
                      )}
                    </div>
                  );
                })}

                {/* Glass pane — captures all pointer events for annotation drawing */}
                {annotationTool !== "pointer" && !isSpaceDown && !editingAnnotationId && (
                  <div
                    style={{ position: "absolute", inset: 0, zIndex: 10, cursor: annotationTool === "text" ? "text" : annotationTool === "emoji" ? "copy" : "crosshair" }}
                    onPointerDown={handleAnnotationGlassPointerDown}
                  />
                )}

                {/* Glass pane — drag a rectangle to create a Custom Zoom clip */}
                {customZoomDrawMode && !isSpaceDown && (
                  <div
                    style={{ position: "absolute", inset: 0, zIndex: 10, cursor: "crosshair" }}
                    onPointerDown={handleCustomZoomGlassPointerDown}
                  />
                )}
                {customZoomDrawPreview && (() => {
                  const x = Math.min(customZoomDrawPreview.startX, customZoomDrawPreview.currentX) * boardZoom;
                  const y = Math.min(customZoomDrawPreview.startY, customZoomDrawPreview.currentY) * boardZoom;
                  const w = Math.abs(customZoomDrawPreview.currentX - customZoomDrawPreview.startX) * boardZoom;
                  const h = Math.abs(customZoomDrawPreview.currentY - customZoomDrawPreview.startY) * boardZoom;
                  return (
                    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: "2px solid #2e8fff", background: "rgba(184,226,255,0.3)", pointerEvents: "none", zIndex: 21 }} />
                  );
                })()}
              </div>

              {/* Empty state */}
              {clips.filter((c) => c.boardX !== undefined).length === 0 && (!AI_FEATURES_ENABLED || (neuralPlaceholders.length === 0 && imagePlaceholders.length === 0)) && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(42,42,42,0.4)" }}>
                    Upload images or videos to auto-add to the board
                  </span>
                </div>
              )}

              {/* Board info */}
              <div style={{ position: "absolute", bottom: 8, left: 8, fontFamily: "monospace", fontSize: 9, color: "rgba(42,42,42,0.4)", pointerEvents: "none" }}>
                {BOARD_W}×{BOARD_H} · {Math.round(boardZoom * 100)}% · space+drag=pan · scroll=zoom
              </div>

              {/* Annotation toolbar — collapsible, Pro gated */}
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <ProGated featureName="Annotation tools">
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setAnnotationToolbarOpen((v) => !v); }}
                      style={{
                        fontFamily: "monospace", fontSize: 10, fontWeight: 700,
                        padding: "5px 12px", border: "1.5px solid #2a2a2a",
                        background: annotationToolbarOpen ? "#2a2a2a" : "#fffdf5",
                        color: annotationToolbarOpen ? "#c8f135" : "#2a2a2a",
                        cursor: "pointer", boxShadow: "2px 2px 4px rgba(0,0,0,0.18)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🎨 Annotations {annotationToolbarOpen ? "▲" : "▼"}
                    </button>
                    {annotationToolbarOpen && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 2,
                        background: "#fffdf5",
                        border: "1.5px solid #2a2a2a",
                        boxShadow: "2px 2px 8px rgba(0,0,0,0.18)",
                        padding: "4px 8px",
                        whiteSpace: "nowrap",
                        position: "relative",
                      }}>
                        {/* Tool buttons */}
                        {([
                          { id: "pointer"   as AnnotationTool, icon: "↖", title: "Select / move" },
                          { id: "text"      as AnnotationTool, icon: "T",  title: "Text" },
                          { id: "arrow"     as AnnotationTool, icon: "↗",  title: "Arrow" },
                          { id: "circle"    as AnnotationTool, icon: "○",  title: "Circle / ellipse" },
                          { id: "highlight" as AnnotationTool, icon: "▭",  title: "Highlight" },
                          { id: "pen"       as AnnotationTool, icon: "✏",  title: "Freehand pen" },
                          { id: "emoji"     as AnnotationTool, icon: "😀", title: "Emoji" },
                        ]).map(({ id, icon, title }) => (
                          <button
                            key={id}
                            title={title}
                            onClick={(e) => {
                              e.stopPropagation();
                              setAnnotationTool(id);
                              if (id === "emoji") setEmojiPickerOpen((v) => !v);
                              else setEmojiPickerOpen(false);
                            }}
                            style={{
                              width: 28, height: 28, border: "none", padding: 0,
                              outline: annotationTool === id ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.25)",
                              background: annotationTool === id ? "#2a2a2a" : "transparent",
                              color: annotationTool === id ? "#fff" : "#2a2a2a",
                              cursor: "pointer", fontFamily: "monospace",
                              fontSize: id === "text" ? 13 : 15, fontWeight: 700,
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                          >
                            {icon}
                          </button>
                        ))}

                        <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />

                        {/* Color swatches */}
                        {(["#cc2200", "#1a6fd4", "#e8a800", "#228b22", "#e06020", "#1a1a1a"]).map((c) => (
                          <button
                            key={c}
                            title={c}
                            onClick={(e) => { e.stopPropagation(); setAnnotationColor(c); }}
                            style={{
                              width: 18, height: 18, padding: 0,
                              background: c,
                              border: annotationColor === c ? "2.5px solid #2a2a2a" : "1.5px solid rgba(0,0,0,0.2)",
                              cursor: "pointer", flexShrink: 0,
                            }}
                          />
                        ))}

                        {/* Font picker — text tool only */}
                        {annotationTool === "text" && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />
                            <select
                              value={annotationFont}
                              onChange={(e) => { e.stopPropagation(); setAnnotationFont(e.target.value); }}
                              style={{ fontFamily: "monospace", fontSize: 9, border: "1px solid rgba(42,42,42,0.3)", background: "#fff", padding: "2px 4px", cursor: "pointer" }}
                            >
                              <option value="Caveat">Caveat</option>
                              <option value="Permanent Marker">Permanent Marker</option>
                              <option value="Architects Daughter">Architects Daughter</option>
                              <option value="Patrick Hand">Patrick Hand</option>
                            </select>
                          </>
                        )}

                        {/* Highlight sub-type — highlight tool only */}
                        {annotationTool === "highlight" && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)", margin: "0 4px" }} />
                            {(["rect", "underline", "curlyBrace"] as const).map((s) => (
                              <button
                                key={s}
                                onClick={(e) => { e.stopPropagation(); setAnnotationHighlightStyle(s); }}
                                style={{
                                  padding: "2px 5px", fontSize: 9, fontFamily: "monospace",
                                  border: annotationHighlightStyle === s ? "2px solid #2a2a2a" : "1px solid rgba(42,42,42,0.3)",
                                  background: annotationHighlightStyle === s ? "#2a2a2a" : "transparent",
                                  color: annotationHighlightStyle === s ? "#fff" : "#2a2a2a",
                                  cursor: "pointer",
                                }}
                              >
                                {s === "rect" ? "▭" : s === "underline" ? "_" : "{}"}
                              </button>
                            ))}
                          </>
                        )}

                        {/* Emoji picker popover */}
                        {annotationTool === "emoji" && emojiPickerOpen && (
                          <div style={{
                            position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                            background: "#fffdf5", border: "1.5px solid #2a2a2a",
                            boxShadow: "3px 3px 0 #2a2a2a", padding: 8, zIndex: 50,
                            display: "grid", gridTemplateColumns: "repeat(9, 28px)", gap: 2,
                          }}>
                            {EMOJI_SET.map((em) => (
                              <button
                                key={em}
                                title={em}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAnnotationEmoji(em);
                                  setEmojiPickerOpen(false);
                                }}
                                style={{
                                  width: 28, height: 28, fontSize: 16, border: "none", padding: 0,
                                  background: annotationEmoji === em ? "#c8f135" : "transparent",
                                  cursor: "pointer", borderRadius: 2,
                                }}
                              >{em}</button>
                            ))}
                          </div>
                        )}

                        {/* Selected emoji indicator */}
                        {annotationTool === "emoji" && (
                          <span style={{ fontSize: 18, marginLeft: 4, userSelect: "none" }} title="Active emoji">
                            {annotationEmoji}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                </ProGated>
              </div>

              {/* Character toolbar — collapsible, Pro gated */}
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 29, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, marginTop: annotationToolbarOpen ? 48 : 0 }}>
                <ProGated featureName="Character">
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); openCharacterPanel(); }}
                      style={{
                        fontFamily: "monospace", fontSize: 10, fontWeight: 700,
                        padding: "5px 12px", border: "1.5px solid #2a2a2a",
                        background: characterPanelOpen ? "#2a2a2a" : "#fffdf5",
                        color: characterPanelOpen ? CHARACTER_COLOR : "#2a2a2a",
                        cursor: "pointer", boxShadow: "2px 2px 4px rgba(0,0,0,0.18)",
                        whiteSpace: "nowrap",
                        marginTop: annotationToolbarOpen ? 0 : 36,
                      }}
                    >
                      🧍 Character
                    </button>
                    {false && characterToolbarOpen && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 4,
                        background: "#fffdf5", border: "1.5px solid #2a2a2a",
                        boxShadow: "2px 2px 8px rgba(0,0,0,0.18)",
                        padding: "5px 10px", whiteSpace: "nowrap", position: "relative",
                      }}>
                        {/* Show/hide toggle */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowCharacter((v) => !v); }}
                          style={{
                            padding: "3px 8px", fontFamily: "monospace", fontSize: 9, cursor: "pointer",
                            border: "1px solid rgba(42,42,42,0.35)",
                            background: showCharacter ? CHARACTER_COLOR : "transparent",
                            color: "#2a2a2a",
                          }}
                        >
                          {showCharacter ? "● On" : "○ Off"}
                        </button>

                        {showCharacter && (
                          <>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* Auto / Manual mode toggle */}
                            <div style={{ display: "flex", border: "1px solid rgba(42,42,42,0.35)", overflow: "hidden" }}>
                              {(["auto", "manual"] as const).map((m) => (
                                <button
                                  key={m}
                                  title={m === "auto" ? "Follow camera keyframes automatically" : "Manually place actions only"}
                                  onClick={(e) => { e.stopPropagation(); setCharacterMode(m); }}
                                  style={{
                                    padding: "3px 7px", fontFamily: "monospace", fontSize: 9, cursor: "pointer",
                                    border: "none", borderRight: m === "auto" ? "1px solid rgba(42,42,42,0.35)" : "none",
                                    background: characterMode === m ? "#2a2a2a" : "transparent",
                                    color: characterMode === m ? CHARACTER_COLOR : "#2a2a2a",
                                    fontWeight: characterMode === m ? 700 : 400,
                                  }}
                                >
                                  {m === "auto" ? "Auto" : "Manual"}
                                </button>
                              ))}
                            </div>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* Action buttons — click to enter crosshair placement mode */}
                              {([
                                { mode: "walkTo" as const, label: "Walk", title: "Click board to walk to position (1.5s)" },
                                { mode: "jumpTo" as const, label: "Jump", title: "Click board to jump to position (1.0s)" },
                                { mode: "skateTo" as const, label: "Skate", title: "Click board to skate to position (3.0s)" },
                                { mode: "grapple" as const, label: "Grapple", title: "Click board to grapple-hook to position (1.8s)" },
                                { mode: "pointAt" as const, label: "Point", title: "Click board to point at position (2.0s)" },
                                { mode: "dance" as const, label: "Dance", title: "Click board to place a hip-shake dance action (2.5s)" },
                                { mode: "pullUps" as const, label: "Pull-ups", title: "Click board to place a grounded pull-up bar action (4.0s)" },
                                { mode: "bazooka" as const, label: "Bazooka", title: "Click an image to fire one terrain-damaging rocket (2.4s)" },
                                { mode: "mirrorCheck" as const, label: "Mirror", title: "Click board to place a mirror-check transformation action (5.0s)" },
                                { mode: "emote" as const, label: "Emote", title: "Choose emoji then place at playhead (2.0s)" },
                            ]).map(({ mode, label, title }) => (
                              <button
                                key={mode}
                                title={title}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (mode === "emote") {
                                    setCharacterEmojiPickerOpen((v) => !v);
                                    setCharacterAddMode(mode);
                                  } else {
                                    setCharacterEmojiPickerOpen(false);
                                    setCharacterAddMode((prev) => (prev === mode ? null : mode));
                                  }
                                }}
                                style={{
                                  padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                  border: characterAddMode === mode ? "2px solid #2a2a2a" : "1px solid rgba(42,42,42,0.35)",
                                  background: characterAddMode === mode ? "#2a2a2a" : "transparent",
                                  color: characterAddMode === mode ? CHARACTER_COLOR : "#2a2a2a",
                                  cursor: characterAddMode === mode ? "crosshair" : "pointer",
                                }}
                              >
                                {label}
                              </button>
                            ))}

                            {characterAddMode && characterAddMode !== "emote" && (
                              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#666", marginLeft: 2 }}>
                                ← click board
                              </span>
                            )}

                            {/* Emote emoji picker */}
                            {characterEmojiPickerOpen && (
                              <div style={{
                                position: "absolute", top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
                                background: "#fffdf5", border: "1.5px solid #2a2a2a",
                                boxShadow: "3px 3px 0 #2a2a2a", padding: 8, zIndex: 55,
                                display: "grid", gridTemplateColumns: "repeat(9, 28px)", gap: 2,
                              }}>
                                {EMOJI_SET.map((em) => (
                                  <button
                                    key={em}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCharacterEmoji(em);
                                      setCharacterEmojiPickerOpen(false);
                                      // Place emote action at playhead
                                      const newAction: CharacterAction = {
                                        id: generateId(), type: "emote",
                                        startTime: playheadRef.current, duration: 2.0,
                                        emoji: em,
                                      };
                                      setCharacterActions((prev) => [...prev, newAction]);
                                      setCharacterAddMode(null);
                                    }}
                                    style={{
                                      width: 28, height: 28, fontSize: 16, border: "none", padding: 0,
                                      background: characterEmoji === em ? CHARACTER_COLOR : "transparent",
                                      cursor: "pointer", borderRadius: 2,
                                    }}
                                  >{em}</button>
                                ))}
                              </div>
                            )}

                            {characterAddMode === "emote" && !characterEmojiPickerOpen && (
                              <span style={{ fontSize: 16, marginLeft: 2 }}>{characterEmoji}</span>
                            )}

                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            <ProGated featureName="Pose Lab">
                              <button
                                title="Open the visual keyframe animation editor"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href = "/board2/poselab";
                                }}
                                style={{
                                  padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                  border: "1px solid rgba(42,42,42,0.35)",
                                  background: "transparent",
                                  color: "#2a2a2a",
                                  cursor: "pointer",
                                }}
                              >
                                🎭 Pose Lab
                              </button>
                            </ProGated>
                            <div style={{ width: 1, height: 20, background: "rgba(42,42,42,0.2)" }} />
                            {/* AI choreography — describe moves in plain language, optionally synced to narration */}
                            <button
                              title="Describe what the character should do, or sync emotes to your narration"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDirectCharacterOpen((v) => {
                                  const next = !v;
                                  if (next) setSyncEmotesToNarration(clipsRef.current.some((c) => c.type === "narration"));
                                  return next;
                                });
                              }}
                              style={{
                                padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                border: "1px solid rgba(42,42,42,0.35)",
                                background: directCharacterOpen ? "#2a2a2a" : "transparent",
                                color: directCharacterOpen ? CHARACTER_COLOR : "#2a2a2a",
                                cursor: "pointer",
                              }}
                            >
                              ✨ Direct
                            </button>
                            {characterActions.some((a) => a.aiGenerated) && (
                              <button
                                title="Remove all AI-choreographed actions (hand-placed ones are kept)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCharacterActions((prev) => prev.filter((a) => !a.aiGenerated));
                                }}
                                style={{
                                  padding: "3px 7px", fontFamily: "monospace", fontSize: 9,
                                  border: "1px solid rgba(42,42,42,0.35)", background: "transparent",
                                  color: "#2a2a2a", cursor: "pointer",
                                }}
                              >
                                🧹 Clear AI
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </>
                </ProGated>
              </div>

              {/* Character placement overlay — captures board click when characterAddMode, start picking, or retargeting is set */}
              {activeCharacter.enabled && (characterStartPickId || (characterAddMode && characterAddMode !== "emote") || retargetCharActionId) && (
                <div
                  style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 28 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const rect = boardContainerRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    const rawBx = (e.clientX - rect.left - boardPanRef.current.x) / boardZoomRef.current;
                    const rawBy = (e.clientY - rect.top - boardPanRef.current.y) / boardZoomRef.current;
                    // Snap target to top of clip surface if clicked on an image/video
                    const snapped = snapToClipTop(rawBx, rawBy, clipsRef.current);
                    const clickedSurface = clipsRef.current
                      .find((c): c is Clip & RequiredSurfaceClip =>
                        isBoardSurface(c) &&
                        rawBx >= c.boardX && rawBx <= c.boardX + c.boardW &&
                        rawBy >= c.boardY && rawBy <= c.boardY + c.boardH
                      );
                    if (characterStartPickId) {
                      const next = { x: Math.round(snapped.x), y: Math.round(snapped.y) };
                      if (characterStartPickId === "c2") {
                        setCharacterStart2(next);
                        charInit2XRef.current = next.x;
                        charInit2YRef.current = next.y;
                      } else {
                        setCharacterStart(next);
                        charInitXRef.current = next.x;
                        charInitYRef.current = next.y;
                      }
                      if (liveControlEnabledRef.current) resetLiveRuntimeFor(characterStartPickId);
                      setCharacterStartPickId(null);
                      setToast(`Character ${characterStartPickId === "c2" ? "2" : "1"} start position set`);
                      drawFrameRef.current(playheadRef.current);
                      return;
                    }
                    const durationMap: Record<string, number> = {
                      walkTo: 1.5,
                      jumpTo: 1.0,
                      skateTo: 2.5 * PHASE_TIME_SCALE,
                      grapple: GRAPPLE_MANUAL_DURATION_SEC,
                      pointAt: 2.0,
                      dance: 2.5,
                      pullUps: 4.0,
                      bazooka: 2.4,
                      mirrorCheck: 5.0,
                      explainGesture: 2.4,
                      flip: 1.2,
                      zipline: 2.0,
                      wallClimb: 2.0,
                      sitAndWatch: 2.0,
                    };
                    if (retargetCharActionId) {
                      const existing = [...characterActionsRef.current, ...characterActions2Ref.current].find((action) => action.id === retargetCharActionId);
                      if (existing?.type === "bazooka" && clickedSurface?.type !== "image") return;
                      const owner: CharacterId = characterActions2Ref.current.some((a) => a.id === retargetCharActionId) ? "c2" : "c1";
                      updateCharacterActionsFor(owner, (prev) => prev.map((a) => a.id === retargetCharActionId ? {
                        ...a,
                        targetX: Math.round(a.type === "bazooka" ? rawBx : snapped.x),
                        targetY: Math.round(a.type === "bazooka" ? rawBy : snapped.y),
                        ...(a.type === "bazooka" && clickedSurface ? { targetLocalX: Math.round(rawBx-clickedSurface.boardX), targetLocalY: Math.round(rawBy-clickedSurface.boardY) } : {}),
                        ...(["skateTo", "bazooka"].includes(a.type) && clickedSurface?.id ? { targetClipId: clickedSurface.id } : { targetClipId: undefined }),
                      } : a));
                      setRetargetCharActionId(null);
                      return;
                    }
                    if (!characterAddMode || characterAddMode === "emote") return;
                    if (characterAddMode === "bazooka" && clickedSurface?.type !== "image") return;
                    let actionStartTime = playheadRef.current;
                    if (characterAddMode === "bazooka") {
                      const ownerActions = activeCharacterIdRef.current === "c2" ? characterActions2Ref.current : characterActionsRef.current;
                      actionStartTime = nextAvailableCharacterActionStart(ownerActions, actionStartTime, durationMap.bazooka);
                    }
                    const newAction: CharacterAction = {
                      id: generateId(),
                      type: characterAddMode,
                      startTime: actionStartTime,
                      duration: durationMap[characterAddMode] ?? 1.5,
                      targetX: Math.round(characterAddMode === "bazooka" ? rawBx : snapped.x),
                      targetY: Math.round(characterAddMode === "bazooka" ? rawBy : snapped.y),
                      ...(characterAddMode === "bazooka" && clickedSurface ? { targetLocalX: Math.round(rawBx-clickedSurface.boardX), targetLocalY: Math.round(rawBy-clickedSurface.boardY) } : {}),
                      ...(["skateTo", "bazooka"].includes(characterAddMode) && clickedSurface?.id ? { targetClipId: clickedSurface.id } : {}),
                    };
                    updateCharacterActionsFor(activeCharacterIdRef.current, (prev) => [...prev, newAction]);
                    setCharacterAddMode(null);
                  }}
                />
              )}

              {liveControlEnabled && liveHeldCommand && (
                <div
                  style={{ position: "absolute", inset: 0, cursor: "crosshair", zIndex: 31 }}
                  title={`${liveHeldCommand}: click a board target`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const target = boardPointFromClient(e.clientX, e.clientY);
                    if (!target) return;
                    const liveTarget = liveHeldCommand === "wallClimb" && target.surface
                      ? {
                          ...target,
                          x: target.rawX < target.surface.boardX + target.surface.boardW / 2
                            ? target.surface.boardX + 40
                            : target.surface.boardX + target.surface.boardW - 40,
                          y: target.surface.boardY,
                        }
                      : target;
                    issueLiveAction(activeCharacterIdRef.current, liveHeldCommand, liveTarget);
                    setLiveHeldCommand(null);
                  }}
                />
              )}

              {liveControlEnabled && (
                <div style={{ position: "absolute", left: 10, bottom: 10, zIndex: 32, width: liveLegendOpen ? 260 : "auto", background: "rgba(255,253,245,0.94)", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", fontSize: 9, color: "#2a2a2a", pointerEvents: "auto" }}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setLiveLegendOpen((v) => !v); }}
                    style={{ width: "100%", border: "none", borderBottom: liveLegendOpen ? "1px solid rgba(42,42,42,0.25)" : "none", background: "#2a2a2a", color: CHARACTER_COLOR, fontFamily: "monospace", fontSize: 10, fontWeight: 700, padding: "5px 7px", textAlign: "left", cursor: "pointer" }}
                  >
                    🎮 Live Control {liveLegendOpen ? "▲" : "▼"} {liveHeldCommand ? `— ${liveHeldCommand}: click target` : ""}
                  </button>
                  {liveLegendOpen && (
                    <div style={{ padding: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", lineHeight: 1.35 }}>
                      <span>W+click Walk</span><span>R+click Run</span>
                      <span>J+click Jump</span><span>F+click Flip</span>
                      <span>G+click Grapple</span><span>Z+click Zip</span>
                      <span>S+click Skate</span><span>C+click Climb</span>
                      <span>D Dance</span><span>P Pull-ups</span>
                      <span>M Mirror</span><span>T Sit</span>
                      <span>E Emote</span><span>X Stop</span>
                      <span>V Camera</span><span>{liveCameraMode === "scene" ? "Scene shot" : "Character shot"}</span>
                      <span>1/2 or Tab switch</span><span>{activeCharacterId === "c2" ? "Active: C2" : "Active: C1"}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Preview overlay — resizable PiP, top-right */}
            <div
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 20,
                pointerEvents: "auto",
                touchAction: "none",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 3 }}>
                <div style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(42,42,42,0.58)", letterSpacing: 0.5 }}>
                  PREVIEW
                </div>
                <div style={{ display: "flex", gap: 3 }}>
                  <button
                    type="button"
                    title="Reset preview size"
                    onClick={(e) => { e.stopPropagation(); setPreviewHeight(PREVIEW_DEFAULT_H_PX); }}
                    style={{ ...miniButton, width: 36, height: 18, padding: 0, fontSize: 8, background: "rgba(255,253,245,0.9)" }}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    title="Maximize preview inside the board area"
                    onClick={(e) => { e.stopPropagation(); setPreviewHeight(maxPreviewHeight()); }}
                    style={{ ...miniButton, width: 28, height: 18, padding: 0, fontSize: 8, background: "rgba(255,253,245,0.9)" }}
                  >
                    Max
                  </button>
                </div>
              </div>
              <div style={{ position: "relative", width: previewW, height: previewHeight }}>
                <canvas
                  ref={canvasRef}
                  width={canvasW}
                  height={canvasH}
                  style={{
                    display: "block",
                    width: previewW,
                    height: previewHeight,
                    border: "1.5px solid #2a2a2a",
                    boxShadow: "2px 2px 6px rgba(0,0,0,0.35)",
                    background: "#111",
                  }}
                />
                <div
                  title="Drag to resize preview"
                  onPointerDown={handlePreviewResizePointerDown}
                  style={{
                    position: "absolute",
                    left: -6,
                    bottom: -6,
                    width: 18,
                    height: 18,
                    border: "1.5px solid #2a2a2a",
                    background: "#c8f135",
                    cursor: "nesw-resize",
                    boxShadow: "1px 1px 0 rgba(42,42,42,0.45)",
                  }}
                />
              </div>
            </div>
          </div>

          {/* ── Right: properties panel (no keyframes) ── */}
          <div style={{ width: 240, flexShrink: 0, borderLeft: "1.5px solid rgba(42,42,42,0.15)", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", background: "rgba(255,253,245,0.65)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={panelLabelStyle}>Properties</div>
              <button
                type="button"
                onClick={openCharacterPanel}
                style={{ ...miniButton, padding: "3px 7px", background: characterPanelOpen || !!selectedCharAction ? "#2a2a2a" : "transparent", color: characterPanelOpen || !!selectedCharAction ? CHARACTER_COLOR : "#2a2a2a" }}
              >
                Character
              </button>
            </div>

            {(selectedCharAction || characterPanelOpen) && (() => {
              const actionIcons: Record<string, string> = {
                walkTo: "⇒", jumpTo: "↑", skateTo: "🛹", grapple: "🪝", pointAt: "→", dance: "♪", pullUps: "💪", bazooka: "🚀", mirrorCheck: "▯", explainGesture: "💬", emote: selectedCharAction?.emoji ?? "🤔",
                flip: "🤸", zipline: "🪢", wallClimb: "🧗", sitAndWatch: "🍿", idle: "⏸",
              };
              const targetableAction = selectedCharAction && !["emote", "idle"].includes(selectedCharAction.type);
              const addButtons: Array<{ mode: CharacterAddMode; label: string; title: string }> = [
                { mode: "walkTo", label: "Walk", title: "Click board to walk to a position" },
                { mode: "jumpTo", label: "Jump", title: "Click board to jump to a position" },
                { mode: "flip", label: "Flip", title: "Click board to flip to a position" },
                { mode: "grapple", label: "Grapple", title: "Click board to grapple-hook to a position" },
                { mode: "zipline", label: "Zipline", title: "Click board to zipline to a position" },
                { mode: "wallClimb", label: "Climb", title: "Click board to climb to a position" },
                { mode: "skateTo", label: "Skate", title: "Click a target image/video to skate there" },
                { mode: "sitAndWatch", label: "Sit & Watch", title: "Click board to sit and watch" },
                { mode: "explainGesture", label: "Talk", title: "Click board to place talking hand motions" },
                { mode: "pointAt", label: "Point", title: "Click board to point at a position" },
                { mode: "dance", label: "Dance", title: "Click board to place a hip-shake dance loop" },
                { mode: "emote", label: "Emote", title: "Choose an emoji and place it at the playhead" },
                { mode: "pullUps", label: "Pull-ups", title: "Click board to place a grounded pull-up bar" },
                { mode: "bazooka", label: "Bazooka", title: "Click an image to fire one terrain-damaging rocket" },
                { mode: "mirrorCheck", label: "Mirror Check", title: "Click board to place a mirror-check transformation" },
              ];
              return (
                <>
                  {selectedCharAction && (
                    <div style={{ border: "1.5px solid rgba(42,42,42,0.28)", background: "#fffdf5", padding: 9, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ ...panelLabelStyle, marginBottom: -2 }}>Action</div>
                      <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
                        {actionIcons[selectedCharAction.type] ?? "•"} {selectedCharAction.type}{selectedCharAction.aiGenerated ? " ✨" : ""}
                      </div>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "monospace", fontSize: 9, color: "#6a6a6a" }}>
                        Start time
                        <input
                          type="number"
                          min={0}
                          step={0.05}
                          value={Number.isFinite(selectedCharAction.startTime) ? selectedCharAction.startTime.toFixed(2) : "0.00"}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isFinite(v)) return;
                            updateCharacterActionsFor(selectedCharActionOwner ?? activeCharacterId, (prev) => prev.map((a) => a.id === selectedCharAction.id ? { ...a, startTime: Math.max(0, v) } : a));
                          }}
                          style={{ width: "100%", fontFamily: "monospace", fontSize: 11, padding: "4px 6px", border: "1px solid rgba(42,42,42,0.4)", background: "#fff", boxSizing: "border-box" }}
                        />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "monospace", fontSize: 9, color: "#6a6a6a" }}>
                        Duration
                        <input
                          type="number"
                          min={0.1}
                          step={0.05}
                          value={Number.isFinite(selectedCharAction.duration) ? selectedCharAction.duration.toFixed(2) : "1.00"}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isFinite(v)) return;
                            updateCharacterActionsFor(selectedCharActionOwner ?? activeCharacterId, (prev) => prev.map((a) => a.id === selectedCharAction.id ? { ...a, duration: Math.max(0.1, v) } : a));
                          }}
                          style={{ width: "100%", fontFamily: "monospace", fontSize: 11, padding: "4px 6px", border: "1px solid rgba(42,42,42,0.4)", background: "#fff", boxSizing: "border-box" }}
                        />
                      </label>
                      {targetableAction && (
                        <button
                          type="button"
                          onClick={() => {
                            if ((selectedCharActionOwner ?? activeCharacterId) === "c2") setShowCharacter2(true);
                            else setShowCharacter(true);
                            setActiveCharacterId(selectedCharActionOwner ?? activeCharacterId);
                            setRetargetCharActionId(selectedCharAction.id);
                            setCharacterAddMode(null);
                            setCharacterStartPickId(null);
                          }}
                          style={{ ...miniButton, background: retargetCharActionId === selectedCharAction.id ? "#2a2a2a" : "transparent", color: retargetCharActionId === selectedCharAction.id ? CHARACTER_COLOR : "#2a2a2a" }}
                        >
                          {retargetCharActionId === selectedCharAction.id ? "Click board..." : "Re-pick target"}
                        </button>
                      )}
                      {selectedCharAction.type === "emote" && (
                        <div>
                          <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Emoji</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 24px)", gap: 2 }}>
                            {EMOJI_SET.map((em) => (
                              <button
                                key={em}
                                type="button"
                                onClick={() => updateCharacterActionsFor(selectedCharActionOwner ?? activeCharacterId, (prev) => prev.map((a) => a.id === selectedCharAction.id ? { ...a, emoji: em } : a))}
                                style={{ width: 24, height: 24, border: "none", padding: 0, background: selectedCharAction.emoji === em ? CHARACTER_COLOR : "transparent", cursor: "pointer", fontSize: 15 }}
                              >
                                {em}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const id = selectedCharAction.id;
                          deleteCharacterAction(id);
                        }}
                        style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}
                      >
                        ✕ Delete action
                      </button>
                    </div>
                  )}

                  <ProGated featureName="Character">
                    <div style={{ border: "1.5px solid rgba(42,42,42,0.18)", background: "rgba(255,253,245,0.82)", padding: 9, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {(["c1", "c2"] as CharacterId[]).map((id) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setActiveCharacterId(id)}
                            style={{ ...miniButton, flex: 1, padding: "4px 5px", background: activeCharacterId === id ? "#2a2a2a" : "transparent", color: activeCharacterId === id ? (id === "c2" ? "#dcd6ff" : CHARACTER_COLOR) : "#2a2a2a" }}
                          >
                            Character {id === "c1" ? "1" : "2"}
                          </button>
                        ))}
                      </div>
                      {!showCharacter2 && activeCharacterId === "c2" && (
                        <button
                          type="button"
                          onClick={() => setShowCharacter2(true)}
                          style={{ ...miniButton, background: "#e7ddff", fontWeight: 700 }}
                        >
                          + Add second character
                        </button>
                      )}
                      {showCharacter2 && activeCharacterId === "c2" && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm("Remove Character 2 and delete its actions?")) return;
                            setShowCharacter2(false);
                            setCharacterActions2([]);
                            setCharacterFace2(null);
                            setCharacterStart2(null);
                            setSelectedCharActionId(null);
                          }}
                          style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}
                        >
                          Remove Character 2
                        </button>
                      )}
                      <div style={{ ...panelLabelStyle, marginBottom: -2 }}>Character</div>
                      <button
                        type="button"
                        onClick={() => {
                          const centerX = boardPanRef.current.x + BOARD_W / (2 * boardZoomRef.current);
                          const surfaces = clipsRef.current.filter((clip): clip is Clip & RequiredSurfaceClip => isBoardSurface(clip));
                          const surface = surfaces.filter((clip) => centerX >= clip.boardX && centerX <= clip.boardX + clip.boardW).sort((a, b) => Math.abs(a.boardY - boardPanRef.current.y) - Math.abs(b.boardY - boardPanRef.current.y))[0] ?? surfaces[0];
                          const next = surface ? { x: clamp(centerX, surface.boardX + 45, surface.boardX + surface.boardW - 45), y: surface.boardY } : { x: BOARD_W / 2, y: BOARD_H / 2 };
                          setSpawnDoor(next); spawnDoorRef.current = next; setToast("Spawn Door placed at the current view");
                        }}
                        style={{ ...miniButton, background: spawnDoor ? "#f4b942" : "transparent" }}
                      >
                        🚪 {spawnDoor ? "Move Spawn Door here" : "Place Spawn Door"}
                      </button>
                      <button
                        type="button"
                        onClick={() => activeCharacterId === "c2" ? setShowCharacter2((v) => !v) : setShowCharacter((v) => !v)}
                        style={{ ...miniButton, background: activeCharacter.enabled ? (activeCharacterId === "c2" ? "#dcd6ff" : CHARACTER_COLOR) : "transparent", color: "#2a2a2a" }}
                      >
                        {activeCharacter.enabled ? "● Show Character" : "○ Show Character"}
                      </button>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => {
                            if (activeCharacterId === "c2") setShowCharacter2(true);
                            else setShowCharacter(true);
                            setCharacterPanelOpen(true);
                            setRetargetCharActionId(null);
                            setCharacterAddMode(null);
                            setCharacterEmojiPickerOpen(false);
                            setCharacterStartPickId((prev) => (prev === activeCharacterId ? null : activeCharacterId));
                          }}
                          style={{ ...miniButton, flex: 1, background: characterStartPickId === activeCharacterId || !!activeCharacter.start ? "#f4b942" : "transparent" }}
                        >
                          {characterStartPickId === activeCharacterId ? "Click board for start..." : activeCharacter.start ? "Move Start Position" : "Set Start Position"}
                        </button>
                        {activeCharacter.start && (
                          <button
                            type="button"
                            onClick={() => {
                              if (activeCharacterId === "c2") {
                                const fallback = { x: charInit.x + 60, y: charInit.y };
                                setCharacterStart2(null);
                                charInit2XRef.current = fallback.x;
                                charInit2YRef.current = fallback.y;
                                if (liveControlEnabledRef.current) resetLiveRuntimeFor("c2");
                              } else {
                                setCharacterStart(null);
                                charInitXRef.current = defaultCharInit.x;
                                charInitYRef.current = defaultCharInit.y;
                                if (liveControlEnabledRef.current) resetLiveRuntimeFor("c1");
                              }
                              setCharacterStartPickId(null);
                              setToast(`Character ${activeCharacterId === "c2" ? "2" : "1"} start reset`);
                              drawFrameRef.current(playheadRef.current);
                            }}
                            style={{ ...miniButton, padding: "5px 6px", color: "#ff5e3a", borderColor: "#ff5e3a" }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <ProGated featureName="Live Character Control">
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 6, border: "1px solid rgba(42,42,42,0.22)", background: liveControlEnabled ? "#f0ffe0" : "transparent" }}>
                          <button
                            type="button"
                            onClick={() => {
                              setLiveHeldCommand(null);
                              if (!liveControlEnabled) {
                                if (activeCharacterId === "c2") setShowCharacter2(true); else setShowCharacter(true);
                                setCharacterPanelOpen(true);
                                setLiveCameraMode("character");
                                setIsPlaying(false);
                                isPlayingRef.current = false;
                              }
                              setLiveControlEnabled((v) => !v);
                            }}
                            style={{ ...miniButton, background: liveControlEnabled ? "#2a2a2a" : "transparent", color: liveControlEnabled ? CHARACTER_COLOR : "#2a2a2a", fontWeight: 700 }}
                          >
                            🎮 Live Control {liveControlEnabled ? "ON" : "OFF"}
                          </button>
                          {liveControlEnabled && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 5, fontFamily: "monospace", fontSize: 10, color: "#2a2a2a" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <span>Camera: {liveCameraMode === "scene" ? "scene shot" : "character shot"} · V toggles</span>
                              <span style={{ color: streamPublishing ? "#228b22" : "#8a6a00", fontWeight: 700 }}>
                                {streamPublishing ? "LIVE" : "LOCAL"}
                              </span>
                              </div>
                              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                <span>Guest appearance</span>
                                <select value={streamGuestSkin} onChange={(event) => setStreamGuestSkin(event.target.value === "styled" ? "styled" : "stick")} style={{ fontFamily: "monospace", fontSize: 10, border: "1px solid #2a2a2a", background: "#fffdf4" }}>
                                  <option value="stick">stick</option>
                                  <option value="styled">styled</option>
                                </select>
                              </label>
                              <strong>Participants ({streamGuests.length}/{MAX_GUESTS})</strong>
                              {/* refs are read only when the click handler runs */}
                              {/* eslint-disable-next-line react-hooks/refs */}
                              {streamGuests.map((guest) => <div key={guest.guestId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}><span>{guest.name}</span>{validGuestSignDataUrl(guest.signDataUrl) && <img src={guest.signDataUrl} alt="" style={{ width: 34, height: 23, objectFit: "cover", border: "1px solid #2a2a2a", background: "#fffdf4" }} />}{validGuestSignDataUrl(guest.signDataUrl) && <button type="button" style={{ ...miniButton, padding: "2px 5px" }} onClick={() => { streamChannelRef.current?.send({ type: "broadcast", event: "remove-sign", payload: { guestId: guest.guestId, sentAt: Date.now() } }); if (guest.guestId) streamGuestSignsRef.current.delete(guest.guestId); }}>remove sign</button>}<button type="button" style={{ ...miniButton, color: "#cc2200", padding: "2px 5px" }} onClick={() => kickStreamGuest(guest.guestId)}>KICK</button></div>)}
                            </div>
                          )}
                        </div>
                      </ProGated>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => setFacePickerOpen(true)}
                          style={{ ...miniButton, flex: 1, padding: "5px 6px", background: activeCharacter.faceBlobUrl ? "#e8f0ff" : "transparent" }}
                        >
                          {activeCharacter.faceBlobUrl ? "Change Face" : "Add Face"}
                        </button>
                        {activeCharacter.faceBlobUrl && (
                          <button
                            type="button"
                            onClick={removeCharacterFace}
                            style={{ ...miniButton, padding: "5px 6px", color: "#ff5e3a", borderColor: "#ff5e3a" }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <div style={{ display: "flex", border: "1px solid rgba(42,42,42,0.35)", overflow: "hidden" }}>
                        {(["stick", "styled"] as const).map((skin) => (
                          <button
                            key={skin}
                            type="button"
                            onClick={() => activeCharacterId === "c2" ? setCharacterSkin2(skin) : setCharacterSkin(skin)}
                            title={skin === "stick" ? "Classic stick figure" : "Styled character skin"}
                            style={{
                              flex: 1,
                              padding: "5px 6px",
                              fontFamily: "monospace",
                              fontSize: 10,
                              cursor: "pointer",
                              border: "none",
                              borderRight: skin === "stick" ? "1px solid rgba(42,42,42,0.35)" : "none",
                              background: activeCharacter.skin === skin ? "#2a2a2a" : "transparent",
                              color: activeCharacter.skin === skin ? (activeCharacterId === "c2" ? "#dcd6ff" : CHARACTER_COLOR) : "#2a2a2a",
                              fontWeight: activeCharacter.skin === skin ? 700 : 400,
                            }}
                          >
                            {skin === "stick" ? "Stick" : "Styled"}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: "flex", border: "1px solid rgba(42,42,42,0.35)", overflow: "hidden" }}>
                        {(["auto", "manual"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => activeCharacterId === "c2" ? setCharacterMode2(m) : setCharacterMode(m)}
                            style={{ flex: 1, padding: "5px 6px", fontFamily: "monospace", fontSize: 10, cursor: "pointer", border: "none", borderRight: m === "auto" ? "1px solid rgba(42,42,42,0.35)" : "none", background: activeCharacter.mode === m ? "#2a2a2a" : "transparent", color: activeCharacter.mode === m ? (activeCharacterId === "c2" ? "#dcd6ff" : CHARACTER_COLOR) : "#2a2a2a", fontWeight: activeCharacter.mode === m ? 700 : 400 }}
                          >
                            {m === "auto" ? "Auto" : "Manual"}
                          </button>
                        ))}
                      </div>
                      {DEV_MOUTH_TEST && (
                        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontFamily: "monospace", fontSize: 10 }}>
                          <span>Mouth test</span>
                          <select
                            value={activeCharacterId === "c2" ? characterViseme2 : characterViseme}
                            onChange={(event) => {
                              const raw = event.target.value as Viseme | "auto";
                              const next = raw === "auto" ? "rest" : raw;
                              if (activeCharacterId === "c2") {
                                characterVisemeMode2Ref.current = raw;
                                characterViseme2Ref.current = next;
                                setCharacterViseme2(raw);
                              } else {
                                characterVisemeModeRef.current = raw;
                                characterVisemeRef.current = next;
                                setCharacterViseme(raw);
                              }
                              drawFrameRef.current(playheadRef.current);
                            }}
                            style={{ flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: 10, border: "1px solid #2a2a2a", background: "#fffdf4", padding: "3px 5px" }}
                          >
                            <option value="auto">auto</option>
                            {VISEME_OPTIONS.map((viseme) => (
                              <option key={viseme} value={viseme}>{viseme}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {addButtons.map(({ mode, label, title }) => (
                          <button
                            key={mode}
                            type="button"
                            title={title}
                            onClick={() => {
                              if (activeCharacterId === "c2") {
                                setShowCharacter2(true);
                                setCharacterMode2("manual");
                              } else {
                                setShowCharacter(true);
                                setCharacterMode("manual");
                              }
                              setRetargetCharActionId(null);
                              setCharacterStartPickId(null);
                              if (mode === "emote") {
                                setCharacterEmojiPickerOpen((v) => !v);
                                setCharacterAddMode("emote");
                              } else {
                                setCharacterEmojiPickerOpen(false);
                                setCharacterAddMode((prev) => (prev === mode ? null : mode));
                              }
                            }}
                            style={{ ...miniButton, padding: "4px 6px", background: characterAddMode === mode ? "#2a2a2a" : "transparent", color: characterAddMode === mode ? CHARACTER_COLOR : "#2a2a2a" }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {characterAddMode && characterAddMode !== "emote" && (
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>Click the board to place {characterAddMode}.</div>
                      )}
                      {characterStartPickId === activeCharacterId && (
                        <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a" }}>Click the board to set this character start position.</div>
                      )}
                      {characterEmojiPickerOpen && (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 24px)", gap: 2 }}>
                          {EMOJI_SET.map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={() => {
                                setCharacterEmoji(em);
                                setCharacterEmojiPickerOpen(false);
                                const newAction: CharacterAction = { id: generateId(), type: "emote", startTime: playhead, duration: 2.0, emoji: em };
                                updateCharacterActionsFor(activeCharacterId, (prev) => [...prev, newAction]);
                                setCharacterAddMode(null);
                              }}
                              style={{ width: 24, height: 24, border: "none", padding: 0, background: characterEmoji === em ? CHARACTER_COLOR : "transparent", cursor: "pointer", fontSize: 15 }}
                            >
                              {em}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        <ProGated featureName="Pose Lab">
                          <button type="button" onClick={() => { window.location.href = "/board2/poselab"; }} style={{ ...miniButton, padding: "4px 6px" }}>🎭 Pose Lab</button>
                        </ProGated>
                        {AI_FEATURES_ENABLED && <button
                          type="button"
                          onClick={() => {
                            setDirectCharacterOpen((v) => {
                              const next = !v;
                              if (next) setSyncEmotesToNarration(clipsRef.current.some((c) => c.type === "narration"));
                              return next;
                            });
                          }}
                          style={{ ...miniButton, padding: "4px 6px", background: directCharacterOpen ? "#2a2a2a" : "transparent", color: directCharacterOpen ? CHARACTER_COLOR : "#2a2a2a" }}
                        >
                          ✨ Direct
                        </button>}
                        {AI_FEATURES_ENABLED && activeCharacter.actions.some((a) => a.aiGenerated) && (
                          <button type="button" onClick={() => updateCharacterActionsFor(activeCharacterId, (prev) => prev.filter((a) => !a.aiGenerated))} style={{ ...miniButton, padding: "4px 6px" }}>
                            🧹 Clear AI
                          </button>
                        )}
                      </div>
                    </div>
                  </ProGated>
                </>
              );
            })()}

            {!(selectedCharAction || characterPanelOpen) && (() => {
              const selectedAnnotation = annotations.find((a) => a.id === selectedAnnotationId) ?? null;
              if (selectedAnnotation) return (
                <>
                  <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
                    {selectedAnnotation.type === "text" ? "T Text" : selectedAnnotation.type === "arrow" ? "↗ Arrow" : selectedAnnotation.type === "circle" ? "○ Circle" : selectedAnnotation.type === "highlight" ? "▭ Highlight" : selectedAnnotation.type === "pen" ? "✏ Pen" : `${selectedAnnotation.emoji ?? "😀"} Emoji`}
                  </div>
                  {(selectedAnnotation.type === "text" || selectedAnnotation.type === "emoji") && (
                    <div>
                      <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Font size (board px)</div>
                      <input
                        type="range"
                        min={20} max={300} step={1}
                        value={selectedAnnotation.fontSize ?? (selectedAnnotation.type === "emoji" ? 120 : 80)}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          setAnnotations((prev) => prev.map((a) => a.id === selectedAnnotation.id ? { ...a, fontSize: v } : a));
                        }}
                        style={{ width: "100%", accentColor: "#c8f135" }}
                      />
                      <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                        {selectedAnnotation.fontSize ?? (selectedAnnotation.type === "emoji" ? 120 : 80)}px
                      </div>
                    </div>
                  )}
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Color</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {["#cc2200", "#1a6fd4", "#e8a800", "#228b22", "#e06020", "#1a1a1a"].map((c) => (
                        <button key={c} onClick={() => setAnnotations((prev) => prev.map((a) => a.id === selectedAnnotation.id ? { ...a, color: c } : a))}
                          style={{ width: 20, height: 20, background: c, border: selectedAnnotation.color === c ? "2.5px solid #2a2a2a" : "1.5px solid rgba(0,0,0,0.2)", cursor: "pointer", padding: 0 }}
                        />
                      ))}
                    </div>
                  </div>
                  <div style={{ marginTop: "auto" }}>
                    <button onClick={() => deleteAnnotation(selectedAnnotation.id)} style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}>
                      ✕ Delete annotation
                    </button>
                  </div>
                </>
              );
              return null;
            })()}

            {!(selectedCharAction || characterPanelOpen) && (!selectedClip ? (
              !selectedAnnotationId ? (
                <p style={{ fontSize: 10, color: "#9a9a9a", fontFamily: "monospace", lineHeight: 1.6, margin: 0 }}>
                  Select a clip or annotation to view its properties.
                </p>
              ) : null
            ) : (
              <>
                <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {selectedClip.type === "pan" ? "⟷ Pan clip" : selectedClip.type === "characterZoom" ? "◎ Character zoom" : selectedClip.type === "customZoom" ? "🔍 Custom zoom" : selectedClip.type === "narration" ? "🎙 Narration" : selectedClip.name}
                </div>
                {selectedClip.type === "pan" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#6a6a6a", background: PAN_CLIP_COLOR, padding: "3px 6px", border: "1px solid rgba(42,42,42,0.2)" }}>
                    Sweeps across all board images
                  </div>
                )}
                {selectedClip.type === "characterZoom" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#4a4a7a", background: CHARACTER_ZOOM_CLIP_COLOR, padding: "3px 6px", border: "1px solid rgba(42,42,42,0.2)" }}>
                    Camera follows and zooms on the character
                  </div>
                )}
                {selectedClip.type === "customZoom" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#1c6fc9", background: CUSTOM_ZOOM_CLIP_COLOR, padding: "3px 6px", border: "1px solid rgba(42,42,42,0.2)" }}>
                    Zooms into a hand-drawn region of the board — drag the corners to adjust it
                  </div>
                )}
                {selectedClip.type === "narration" && (
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "#5a1530", background: NARRATION_COLOR, padding: "3px 6px", border: "1px solid rgba(180,80,130,0.35)" }}>
                    Audio-only clip — plays during export
                  </div>
                )}

                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#6a6a6a" }}>
                  Start: {selectedClip.startTime.toFixed(2)}s
                </div>

                <div>
                  <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Duration (s)</div>
                  <input
                    type="number"
                    value={selectedClip.duration.toFixed(2)}
                    step={0.1}
                    min={0.1}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0.1) {
                        setClips((prev) =>
                          prev.map((c) => c.id === selectedClipId ? { ...c, duration: v } : c)
                        );
                      }
                    }}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: 11, padding: "4px 6px", border: "1px solid rgba(42,42,42,0.4)", background: "#fff", boxSizing: "border-box" }}
                  />
                </div>

                {selectedClip.type === "narration" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      onClick={() => void setNarrationSpeechBubbles(selectedClip, !selectedClip.speechBubbles)}
                      disabled={transcribingNarrationId === selectedClip.id}
                      style={{ ...sketchButton, width: "100%", padding: "7px 8px", background: selectedClip.speechBubbles ? "#c8f135" : "#fffdf5", opacity: transcribingNarrationId === selectedClip.id ? 0.55 : 1 }}
                    >
                      {transcribingNarrationId === selectedClip.id ? "⟳ Whisper transcription…" : selectedClip.speechBubbles ? `💬 Speech bubbles on · ${narrationSentenceCues(selectedClip.transcriptSegments ?? []).length}` : "💬 Add comic speech bubbles"}
                    </button>
                    {selectedClip.speechBubbles && (
                      <button
                        type="button"
                        onClick={() => setNarrationSpeechGestures(selectedClip, selectedClip.speechBubbleGestures === false)}
                        style={{ ...miniButton, background: selectedClip.speechBubbleGestures === false ? "transparent" : "#f4b942" }}
                      >
                        {selectedClip.speechBubbleGestures === false ? "Talking hands off" : "Talking hands on"}
                      </button>
                    )}
                  </div>
                )}

                {selectedClip.type !== "narration" && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Hold / Transition</div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.95}
                      step={0.01}
                      value={selectedClip.holdFraction ?? HOLD_FRACTION}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (cameraKeyframesRef.current.length > 0) setKeyframesOutOfDate(true);
                        setClips((prev) =>
                          prev.map((c) => c.id === selectedClipId ? { ...c, holdFraction: v } : c)
                        );
                      }}
                      style={{ width: "100%", accentColor: "#c8f135" }}
                    />
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                      Hold: {Math.round((selectedClip.holdFraction ?? HOLD_FRACTION) * 100)}% · Trans: {Math.round((1 - (selectedClip.holdFraction ?? HOLD_FRACTION)) * 100)}%
                    </div>
                  </div>
                )}

                {selectedClip.boardX !== undefined && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Board Position</div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6a6a6a", lineHeight: 1.8 }}>
                      <div>X: {Math.round(selectedClip.boardX)} &nbsp; Y: {Math.round(selectedClip.boardY!)}</div>
                      <div>W: {Math.round(selectedClip.boardW!)} &nbsp; H: {Math.round(selectedClip.boardH!)}</div>
                    </div>
                  </div>
                )}

                {(selectedClip.type === "video" || selectedClip.type === "narration") && (
                  <div>
                    <div style={{ ...panelLabelStyle, marginBottom: 5 }}>Volume</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="range"
                        min={0} max={1} step={0.01}
                        value={selectedClip.muted ? 0 : (selectedClip.volume ?? 1)}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, volume: v, muted: false } : c));
                        }}
                        style={{ flex: 1, accentColor: "#c8f135" }}
                      />
                      <button
                        onClick={() => setClips((prev) => prev.map((c) => c.id === selectedClipId ? { ...c, muted: !c.muted } : c))}
                        style={{ ...miniButton, background: selectedClip.muted ? "#ff5e3a" : "transparent", color: selectedClip.muted ? "#fff" : "#2a2a2a", padding: "2px 6px" }}
                      >
                        {selectedClip.muted ? "🔇" : "🔊"}
                      </button>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 9, color: "#6a6a6a", marginTop: 2 }}>
                      {selectedClip.muted ? "Muted" : `${Math.round((selectedClip.volume ?? 1) * 100)}%`}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: "auto" }}>
                  <button
                    onClick={() => deleteClip(selectedClip.id)}
                    style={{ ...miniButton, color: "#ff5e3a", borderColor: "#ff5e3a" }}
                  >
                    ✕ Delete clip
                  </button>
                </div>
              </>
            ))}
          </div>
        </div>

        {/* ── Bottom: timeline ── */}
        <div style={{ height: TIMELINE_H, flexShrink: 0, background: "rgba(255,253,245,0.85)", display: "flex", flexDirection: "column" }}>

          {/* Timeline controls bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(245,236,216,0.85)", flexShrink: 0, flexWrap: "nowrap" }}>
            <button
              onClick={togglePlay}
              style={{ ...sketchButton, width: 34, height: 34, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: isPlaying ? "#ff5e3a" : "#c8f135", color: isPlaying ? "#fff" : "#2a2a2a" }}
            >
              {isPlaying ? "■" : "▶"}
            </button>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#2a2a2a", border: "1.5px solid #2a2a2a", padding: "3px 8px", background: "#fffdf5", boxShadow: "2px 2px 0 #2a2a2a", minWidth: 72, textAlign: "center" }}>
              {formatTime(playhead)}
            </span>
            <button onClick={() => { setPlayhead(0); setIsPlaying(false); }} style={miniButton}>↩ reset</button>
            <button onClick={fitTimeline} style={{ ...sketchButton, height: 30, padding: "0 10px", fontSize: 11 }}>Fit</button>
            <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: 9, fontFamily: "monospace", color: "#9a9a9a" }}>zoom</span>
              <button onClick={() => { const n = clamp(pxPerSec / 1.5, MIN_PX_PER_SEC, MAX_PX_PER_SEC); pxPerSecRef.current = n; setPxPerSec(n); }} style={miniButton}>−</button>
              <button onClick={() => { const n = clamp(pxPerSec * 1.5, MIN_PX_PER_SEC, MAX_PX_PER_SEC); pxPerSecRef.current = n; setPxPerSec(n); }} style={miniButton}>+</button>
            </div>
            <span style={{ fontSize: 9, fontFamily: "monospace", color: "#bbb" }}>space=play · ⌘C/V/D=copy/paste/dup · ⌫=delete · drag vertically=change layer</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              {isExporting && (
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "#ff5e3a" }}>{Math.round(exportProgress * 100)}%</span>
              )}
              <button
                onClick={isExporting ? cancelExport : startExport}
                style={{ ...sketchButton, padding: "4px 10px", fontSize: 11, background: isExporting ? "#ff5e3a" : "#c8f135", color: isExporting ? "#fff" : "#2a2a2a" }}
              >
                {isExporting ? "✕ Cancel" : "⬇ Export"}
              </button>
              <div style={{ display: "flex", gap: 3 }}>
                {(["16:9", "9:16"] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setCanvasAspect(a)}
                    style={{ ...miniButton, background: canvasAspect === a ? "#2a2a2a" : "transparent", color: canvasAspect === a ? "#fff" : "#2a2a2a" }}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <label
                title="Keep visible off-timeline videos looping silently while the camera passes them."
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, fontFamily: "monospace", color: "#2a2a2a", whiteSpace: "nowrap", userSelect: "none" }}
              >
                <input
                  type="checkbox"
                  checked={ambientVideoEnabled}
                  onChange={(e) => setAmbientVideoEnabled(e.target.checked)}
                  style={{ width: 12, height: 12, margin: 0, accentColor: "#c8f135" }}
                />
                Ambient video
              </label>
            </div>
          </div>

          {/* Ruler */}
          <div
            style={{ height: RULER_H, flexShrink: 0, position: "relative", overflow: "hidden", borderBottom: "1px solid rgba(42,42,42,0.12)", background: "rgba(42,42,42,0.04)", cursor: "col-resize" }}
            onPointerDown={handleRulerPointerDown}
          >
            <div style={{ position: "absolute", left: -timelineScroll, top: 0, width: timelineWidth + 200, height: "100%", pointerEvents: "none" }}>
              {rulerTicks()}
            </div>
            <div style={{ position: "absolute", left: playhead * pxPerSec - timelineScroll, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none" }} />
          </div>

          {/* Track — 5 visual layers above, narration audio row below */}
          <div
            ref={scrollerRef}
            style={{ flex: 1, minHeight: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H * (showCharacter2 ? 2 : 1) + 16, position: "relative", overflowX: "auto", overflowY: "hidden" }}
            onScroll={(e) => {
              const sl = (e.target as HTMLDivElement).scrollLeft;
              timelineScrollRef.current = sl;
              setTimelineScroll(sl);
            }}
            onPointerDown={handleTimelinePointerDown}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleTimelineDrop}
            onContextMenu={(e) => {
              e.preventDefault();
              const rect = scrollerRef.current!.getBoundingClientRect();
              const timeSec = Math.max(0, (e.clientX - rect.left + timelineScrollRef.current) / pxPerSecRef.current);
              const clipEl = (e.target as HTMLElement).closest("[data-clipblock]") as HTMLElement | null;
              const clipId = clipEl?.dataset.clipid;
              setContextMenu({ x: e.clientX, y: e.clientY, timeSec, clipId });
            }}
          >
            <div style={{ position: "relative", width: timelineWidth, height: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H * (showCharacter2 ? 2 : 1) + 12 }}>
              {/* Layer row backgrounds (L0–L4) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * LAYER_H, height: LAYER_H, background: i % 2 === 0 ? "rgba(100,130,180,0.04)" : "rgba(100,130,180,0.08)", borderTop: i === 0 ? "1px solid rgba(42,42,42,0.08)" : "1px solid rgba(42,42,42,0.05)" }} />
              ))}
              {/* Layer labels L0–L4 (track scroll position) */}
              {Array.from({ length: N_LAYERS }, (_, i) => (
                <div key={i} style={{ position: "absolute", left: timelineScroll + 2, top: i * LAYER_H + 1, zIndex: 15, display: "flex", alignItems: "center", gap: 3 }}>
                  <button
                    title={mutedLayers[i] ? `Unmute layer L${i}` : `Mute layer L${i}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); toggleLayerMute(i); }}
                    style={{
                      width: 16,
                      height: 14,
                      padding: 0,
                      border: "1px solid rgba(42,42,42,0.35)",
                      background: mutedLayers[i] ? "#ff5e3a" : "rgba(255,253,245,0.85)",
                      color: mutedLayers[i] ? "#fff" : "#2a2a2a",
                      fontSize: 8,
                      lineHeight: "12px",
                      fontFamily: "monospace",
                      cursor: "pointer",
                    }}
                  >
                    {mutedLayers[i] ? "×" : "♪"}
                  </button>
                  <span style={{ fontSize: 7, fontFamily: "monospace", color: mutedLayers[i] ? "#ff5e3a" : "rgba(42,42,42,0.3)", letterSpacing: 0.5 }}>L{i}</span>
                </div>
              ))}
              {/* Narration row background */}
              <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + 4, height: NARRATION_TRACK_H, background: "rgba(255,150,200,0.05)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />
              {/* Row label for narration row */}
              <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + 6, pointerEvents: "none", zIndex: 15 }}>
                <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(180,80,130,0.5)", letterSpacing: 0.5, textTransform: "uppercase" }}>audio</span>
              </div>
              {timelineMarquee && (() => {
                const left = Math.min(timelineMarquee.startX, timelineMarquee.currentX);
                const top = Math.min(timelineMarquee.startY, timelineMarquee.currentY);
                const width = Math.abs(timelineMarquee.currentX - timelineMarquee.startX);
                const height = Math.abs(timelineMarquee.currentY - timelineMarquee.startY);
                return (
                  <div style={{ position: "absolute", left, top, width, height, border: "1.5px dashed #ff5e3a", background: "rgba(255,94,58,0.12)", pointerEvents: "none", zIndex: 30 }} />
                );
              })()}

              {/* Visual clips (image / video / pan) */}
              {clips.filter((c) => c.type !== "narration").map((clip, ci) => {
                const color = clip.type === "pan" ? PAN_CLIP_COLOR : clip.type === "characterZoom" ? CHARACTER_ZOOM_CLIP_COLOR : clip.type === "customZoom" ? CUSTOM_ZOOM_CLIP_COLOR : CLIP_COLORS[ci % CLIP_COLORS.length];
                const selected = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                const hf = clip.holdFraction ?? HOLD_FRACTION;
                const innerW = clipPx - HANDLE_W * 2;
                const holdW = Math.max(0, innerW * hf);
                const transW = Math.max(0, innerW * (1 - hf));
                const holdColor = shadeColor(color, 0.82);
                const transColor = shadeColor(color, 1.18);
                const dividerLeft = HANDLE_W + holdW;
                const clipLayer = clip.layer ?? 1;
                return (
                  <div
                    key={clip.id}
                    data-clipblock
                    data-clipid={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: clipLayer * LAYER_H + 2,
                      width: clipPx,
                      height: LAYER_H - 4,
                      border: selected ? "2px solid #2a2a2a" : "1.5px solid rgba(42,42,42,0.35)",
                      boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                      cursor: "grab",
                      userSelect: "none",
                      overflow: "hidden",
                    }}
                    onClick={(e) => { e.stopPropagation(); setClipSelection([clip.id]); }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                  >
                    {/* Hold region */}
                    <div style={{ position: "absolute", left: HANDLE_W, top: 0, width: holdW, bottom: 0, background: holdColor, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {holdW > 30 && (
                        <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(42,42,42,0.5)", textTransform: "uppercase", letterSpacing: 0.5, pointerEvents: "none" }}>hold</span>
                      )}
                    </div>
                    {/* Transition region */}
                    <div style={{ position: "absolute", left: HANDLE_W + holdW, top: 0, width: transW, bottom: 0, background: transColor, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {transW > 36 && (
                        <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(42,42,42,0.5)", textTransform: "uppercase", letterSpacing: 0.5, pointerEvents: "none" }}>trans</span>
                      )}
                    </div>
                    {/* Divider */}
                    <div
                      style={{ position: "absolute", left: dividerLeft - 1, top: 0, bottom: 0, width: 3, background: "rgba(42,42,42,0.65)", cursor: "col-resize", zIndex: 5 }}
                      onPointerDown={(e) => handleDividerPointerDown(e, clip)}
                    />
                    {/* Left resize handle */}
                    <div
                      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.25)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")}
                    />
                    {/* Clip name */}
                    <span style={{ position: "absolute", left: HANDLE_W + 4, right: HANDLE_W + 4, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 9, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#2a2a2a", pointerEvents: "none", zIndex: 4 }}>
                      {clip.type === "pan" ? "⟷ Pan" : clip.type === "characterZoom" ? "◎ Char Zoom" : clip.type === "customZoom" ? "🔍 Custom Zoom" : `${clip.name}${clip.boardX !== undefined ? " [B]" : ""}`}
                    </span>
                    {/* Right resize handle */}
                    <div
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.25)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")}
                    />
                  </div>
                );
              })}

              {/* Narration clips row */}
              {clips.filter((c) => c.type === "narration").map((clip) => {
                const selected = clip.id === selectedClipId || selectedClipIds.includes(clip.id);
                const clipPx = Math.max(HANDLE_W * 2 + 4, clip.duration * pxPerSec);
                return (
                  <div
                    key={clip.id}
                    data-clipblock
                    data-clipid={clip.id}
                    style={{
                      position: "absolute",
                      left: clip.startTime * pxPerSec,
                      top: TRACK_H + 4 + 2,
                      width: clipPx,
                      height: NARRATION_TRACK_H - 4,
                      background: NARRATION_COLOR,
                      border: selected ? "2px solid #2a2a2a" : "1.5px solid rgba(180,80,130,0.5)",
                      boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                      cursor: "grab",
                      userSelect: "none",
                      overflow: "hidden",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setClipSelection([clip.id]);
                      if (!clip.speechBubbles && transcribingNarrationId !== clip.id) void setNarrationSpeechBubbles(clip, true);
                    }}
                    onPointerDown={(e) => handleClipPointerDown(e, clip, "move")}
                  >
                    {/* Left resize handle */}
                    <div
                      style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-left")}
                    />
                    {/* Waveform */}
                    {clip.waveform && clip.waveform.length > 0 && (
                      <svg
                        viewBox={`0 0 ${clip.waveform.length} 1`}
                        preserveAspectRatio="none"
                        style={{ position: "absolute", left: HANDLE_W, right: HANDLE_W, top: 0, bottom: 0, width: `calc(100% - ${HANDLE_W * 2}px)`, height: "100%", pointerEvents: "none" }}
                      >
                        {clip.waveform.map((v, i) => (
                          <rect key={i} x={i} y={(1 - v) / 2} width={0.85} height={Math.max(0.02, v)} fill="rgba(120,40,80,0.4)" />
                        ))}
                      </svg>
                    )}
                    {/* Label */}
                    <span style={{ position: "absolute", left: HANDLE_W + 4, right: HANDLE_W + 4, top: "50%", transform: "translateY(-50%)", fontFamily: "monospace", fontSize: 8, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#5a1530", pointerEvents: "none", zIndex: 4 }}>
                      {clip.speechBubbles ? "💬" : "🎙"} {clip.name} {clip.duration.toFixed(1)}s
                    </span>
                    {clip.speechBubbles && (
                      <>
                        <div style={{ position: "absolute", left: HANDLE_W, right: HANDLE_W, top: 0, height: 4, background: "#c8f135", pointerEvents: "none", zIndex: 4 }} />
                        {narrationSentenceCues(clip.transcriptSegments ?? []).slice(1).map((cue) => {
                          const local = cue.start - (clip.sourceOffsetSec ?? 0);
                          if (local <= 0 || local >= clip.duration) return null;
                          return <div key={`${clip.id}-${cue.index}`} style={{ position: "absolute", left: HANDLE_W + local / clip.duration * (clipPx - HANDLE_W * 2), top: 4, bottom: 0, borderLeft: "1px dashed rgba(42,42,42,.35)", pointerEvents: "none", zIndex: 3 }} />;
                        })}
                      </>
                    )}
                    {/* Right resize handle */}
                    <div
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                      onPointerDown={(e) => handleClipPointerDown(e, clip, "resize-right")}
                    />
                  </div>
                );
              })}

              {/* Character row background */}
              {showCharacter && (
                <>
                  <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + NARRATION_TRACK_H + 8, height: CHARACTER_TRACK_H, background: "rgba(100,200,100,0.06)", borderTop: "1px dashed rgba(42,42,42,0.18)" }} />
                  <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + NARRATION_TRACK_H + 10, pointerEvents: "none", zIndex: 15 }}>
                    <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(60,130,60,0.6)", letterSpacing: 0.5, textTransform: "uppercase" }}>char 1</span>
                  </div>
                  {/* Character action blocks — show derived auto-actions (dimmed) + manual actions */}
                  {resolvedCharActions.map((action) => {
                    const isAuto = characterMode === "auto" && !characterActions.find((m) => m.id === action.id);
                    const selected = selectedCharActionId === action.id;
                    const actionPx = Math.max(HANDLE_W * 2 + 4, action.duration * pxPerSec);
                    const icons: Record<string, string> = {
                      walkTo: "⇒", jumpTo: "↑", skateTo: "🛹", grapple: "🪝", pointAt: "→", dance: "♪", pullUps: "💪", bazooka: "🚀", mirrorCheck: "▯", explainGesture: "💬", emote: action.emoji ?? "🤔", idle: "⏸",
                      flip: "🤸", zipline: "🪢", wallClimb: "🧗", sitAndWatch: "🍿",
                    };
                    return (
                      <div
                        key={action.id}
                        data-charaction
                        data-actionid={action.id}
                        title={characterActionHasWalkIn(action, clips) ? `${action.type} includes walk-in` : action.type}
                        style={{
                          position: "absolute",
                          left: action.startTime * pxPerSec,
                          top: TRACK_H + NARRATION_TRACK_H + 10,
                          width: actionPx,
                          height: CHARACTER_TRACK_H - 4,
                          background: isAuto ? "rgba(180,220,170,0.45)" : CHARACTER_COLOR,
                          border: selected ? "2px solid #2a2a2a" : isAuto ? "1px dashed rgba(60,130,60,0.35)" : "1.5px solid rgba(60,130,60,0.5)",
                          boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                          cursor: isAuto ? "default" : "grab",
                          userSelect: "none",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          opacity: isAuto ? 0.7 : 1,
                        }}
                        onPointerDown={isAuto ? undefined : (e) => handleCharActionPointerDown(e, action, "move")}
                        onContextMenu={isAuto ? undefined : (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          selectCharAction(action.id);
                          setCharActionContextMenu({ x: e.clientX, y: e.clientY, actionId: action.id });
                        }}
                        onClick={isAuto ? undefined : (e) => { e.stopPropagation(); selectCharAction(action.id); }}
                      >
                        {/* Left resize — manual only */}
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-left")}
                          />
                        )}
                        <span style={{ position: "absolute", left: HANDLE_W + 3, right: HANDLE_W + 3, fontSize: 8, fontFamily: "monospace", color: "#2a4a2a", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", pointerEvents: "none", zIndex: 4 }}>
                          {icons[action.type]} {action.type}
                        </span>
                        {/* AI-choreographed badge — drag/resize/delete work the same as any manual action */}
                        {action.aiGenerated && (
                          <span title="AI-choreographed" style={{ position: "absolute", top: -1, right: 1, fontSize: 8, zIndex: 5, pointerEvents: "none" }}>✨</span>
                        )}
                        {!isAuto && (
                          <button
                            type="button"
                            title="Delete action"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); deleteCharacterAction(action.id); }}
                            style={{
                              position: "absolute",
                              right: HANDLE_W + 1,
                              top: 1,
                              width: 14,
                              height: 14,
                              border: "1px solid rgba(42,42,42,0.55)",
                              background: "#fffdf5",
                              color: "#ff5e3a",
                              fontSize: 9,
                              lineHeight: 1,
                              padding: 0,
                              cursor: "pointer",
                              zIndex: 8,
                            }}
                          >
                            ×
                          </button>
                        )}
                        {/* Right resize — manual only */}
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-right")}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {/* Character 2 row background */}
              {showCharacter2 && (
                <>
                  <div style={{ position: "absolute", left: 0, right: 0, top: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H + 8, height: CHARACTER_TRACK_H, background: "rgba(150,130,220,0.08)", borderTop: "1px dashed rgba(58,58,90,0.22)" }} />
                  <div style={{ position: "absolute", left: timelineScroll + 2, top: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H + 10, pointerEvents: "none", zIndex: 15 }}>
                    <span style={{ fontSize: 7, fontFamily: "monospace", color: "rgba(58,58,90,0.68)", letterSpacing: 0.5, textTransform: "uppercase" }}>char 2</span>
                  </div>
                  {resolvedCharActions2.map((action) => {
                    const isAuto = characterMode2 === "auto" && !characterActions2.find((m) => m.id === action.id);
                    const selected = selectedCharActionId === action.id;
                    const actionPx = Math.max(HANDLE_W * 2 + 4, action.duration * pxPerSec);
                    const icons: Record<string, string> = {
                      walkTo: "⇒", jumpTo: "↑", skateTo: "🛹", grapple: "🪝", pointAt: "→", dance: "♪", pullUps: "💪", bazooka: "🚀", mirrorCheck: "▯", explainGesture: "💬", emote: action.emoji ?? "🤔", idle: "⏸",
                      flip: "🤸", zipline: "🪢", wallClimb: "🧗", sitAndWatch: "🍿",
                    };
                    return (
                      <div
                        key={action.id}
                        data-charaction
                        data-actionid={action.id}
                        title={characterActionHasWalkIn(action, clips) ? `${action.type} includes walk-in` : action.type}
                        style={{
                          position: "absolute",
                          left: action.startTime * pxPerSec,
                          top: TRACK_H + NARRATION_TRACK_H + CHARACTER_TRACK_H + 10,
                          width: actionPx,
                          height: CHARACTER_TRACK_H - 4,
                          background: isAuto ? "rgba(190,180,235,0.45)" : "#dcd6ff",
                          border: selected ? "2px solid #2a2a2a" : isAuto ? "1px dashed rgba(58,58,90,0.35)" : "1.5px solid rgba(58,58,90,0.5)",
                          boxShadow: selected ? "2px 2px 0 #2a2a2a" : "none",
                          cursor: isAuto ? "default" : "grab",
                          userSelect: "none",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          opacity: isAuto ? 0.7 : 1,
                        }}
                        onPointerDown={isAuto ? undefined : (e) => handleCharActionPointerDown(e, action, "move")}
                        onContextMenu={isAuto ? undefined : (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          selectCharAction(action.id);
                          setCharActionContextMenu({ x: e.clientX, y: e.clientY, actionId: action.id });
                        }}
                        onClick={isAuto ? undefined : (e) => { e.stopPropagation(); selectCharAction(action.id); }}
                      >
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-left")}
                          />
                        )}
                        <span style={{ position: "absolute", left: HANDLE_W + 3, right: HANDLE_W + 3, fontSize: 8, fontFamily: "monospace", color: "#303052", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", pointerEvents: "none", zIndex: 4 }}>
                          {icons[action.type]} {action.type}
                        </span>
                        {action.aiGenerated && (
                          <span title="AI-choreographed" style={{ position: "absolute", top: -1, right: 1, fontSize: 8, zIndex: 5, pointerEvents: "none" }}>✨</span>
                        )}
                        {!isAuto && (
                          <button
                            type="button"
                            title="Delete action"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); deleteCharacterAction(action.id); }}
                            style={{ position: "absolute", right: HANDLE_W + 1, top: 1, width: 14, height: 14, border: "1px solid rgba(42,42,42,0.55)", background: "#fffdf5", color: "#ff5e3a", fontSize: 9, lineHeight: 1, padding: 0, cursor: "pointer", zIndex: 8 }}
                          >
                            ×
                          </button>
                        )}
                        {!isAuto && (
                          <div
                            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: "ew-resize", background: "rgba(42,42,42,0.2)", zIndex: 6 }}
                            onPointerDown={(e) => handleCharActionPointerDown(e, action, "resize-right")}
                          />
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              <div style={{ position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#ff5e3a", pointerEvents: "none", zIndex: 10 }} />
            </div>
          </div>
        </div>
      </div>

      {/* Character action context menu */}
      {charActionContextMenu && (
        <div
          style={{ position: "fixed", left: charActionContextMenu.x, top: charActionContextMenu.y, zIndex: 9999, background: "#fffdf5", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", minWidth: 120 }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            onClick={() => { deleteCharacterAction(charActionContextMenu.actionId); }}
            style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, color: "#ff5e3a" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#ffe5e5")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            ✕ Delete action
          </div>
        </div>
      )}

      {/* Timeline context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 9998, background: "#fffdf5", border: "1.5px solid #2a2a2a", boxShadow: "2px 2px 0 #2a2a2a", fontFamily: "monospace", minWidth: 140 }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.clipId ? (
            // Clip right-click menu
            <>
              <div onClick={() => { copyClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⌘C Copy
              </div>
              <div onClick={() => { duplicateClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⌘D Duplicate
              </div>
              {clipboardReady && (
                <div onClick={() => { pasteClip(); setContextMenu(null); }}
                  style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.08)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  ⌘V Paste
                </div>
              )}
              <div onClick={() => { deleteClip(contextMenu.clipId!); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, color: "#ff5e3a" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#ffe5e5")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ✕ Delete
              </div>
            </>
          ) : (
            // Empty timeline right-click menu
            <>
              <div onClick={() => { addPanClip(contextMenu.timeSec); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.12)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = PAN_CLIP_COLOR)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ⟷ Add pan here
              </div>
              <div onClick={() => { addCharacterZoomClip(contextMenu.timeSec); setContextMenu(null); }}
                style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11, borderBottom: "1px solid rgba(42,42,42,0.12)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = CHARACTER_ZOOM_CLIP_COLOR)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                ◎ Zoom on character
              </div>
              {clipboardReady && (
                <div onClick={() => { pasteClip(); setContextMenu(null); }}
                  style={{ padding: "7px 12px", cursor: "pointer", fontSize: 11 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#c8f135")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  ⌘V Paste here
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Divider drag tooltip */}
      {dividerTooltip && (
        <div style={{ position: "fixed", left: dividerTooltip.x + 12, top: dividerTooltip.y - 32, background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 10, padding: "3px 8px", border: "1px solid #c8f135", pointerEvents: "none", zIndex: 9999, whiteSpace: "nowrap" }}>
          {dividerTooltip.label}
        </div>
      )}

      {/* Character face picker */}
      {facePickerOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setFacePickerOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.58)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ width: 520, maxWidth: "92vw", maxHeight: "82vh", overflow: "hidden", background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", fontFamily: "monospace", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <strong style={{ fontSize: 13 }}>ADD CHARACTER FACE</strong>
              <button type="button" onClick={() => setFacePickerOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ padding: 14, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ ...sketchButton, display: "block", textAlign: "center", cursor: "pointer" }}>
                ↑ Upload new image
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    e.currentTarget.value = "";
                    handleFaceUpload(file);
                  }}
                />
              </label>
              <div style={{ ...panelLabelStyle }}>Images on board</div>
              {clips.filter((c) => c.type === "image" && c.sourceUrl).length === 0 ? (
                <div style={{ fontSize: 10, color: "#7a7a7a", border: "1px dashed rgba(42,42,42,0.28)", padding: 10 }}>
                  No image clips yet. Upload an image above.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {clips.filter((c) => c.type === "image" && c.sourceUrl).map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      onClick={() => openFaceCropFromSource(clip.sourceUrl, clip.name)}
                      style={{ border: "1.5px solid rgba(42,42,42,0.35)", background: "#fff", padding: 4, cursor: "pointer", textAlign: "left" }}
                    >
                      <img src={clip.sourceUrl} alt={clip.name} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", display: "block", background: "#ddd" }} />
                      <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{clip.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Character face cropper */}
      {faceCropSource && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setFaceCropSource(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.64)", zIndex: 1001, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ width: 700, maxWidth: "94vw", maxHeight: "92vh", overflow: "hidden", background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", fontFamily: "monospace", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <strong style={{ fontSize: 13 }}>CROP FACE — {faceCropSource.name.slice(0, 42)}</strong>
              <button type="button" onClick={() => setFaceCropSource(null)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>
            <div style={{ padding: 14, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 120px", gap: 14, alignItems: "start" }}>
              <div style={{ border: "1.5px solid rgba(42,42,42,0.35)", background: "#1a1a1a", padding: 8 }}>
                <div style={{ position: "relative", width: "100%", userSelect: "none", touchAction: "none" }}>
                  <img src={faceCropSource.url} alt={faceCropSource.name} draggable={false} style={{ display: "block", width: "100%", height: "auto" }} />
                  <div
                    onPointerDown={(e) => handleFaceCropPointerDown(e, "move")}
                    style={{
                      position: "absolute",
                      left: `${faceCrop.x * 100}%`,
                      top: `${faceCrop.y * 100}%`,
                      width: `${faceCrop.w * 100}%`,
                      height: `${faceCrop.h * 100}%`,
                      border: "2px dotted #fff",
                      borderRadius: "50%",
                      boxShadow: "0 0 0 9999px rgba(0,0,0,0.36)",
                      cursor: "move",
                    }}
                  >
                    {(["nw", "ne", "sw", "se"] as FaceCropCorner[]).map((corner) => (
                      <div
                        key={corner}
                        onPointerDown={(e) => handleFaceCropPointerDown(e, "resize", corner)}
                        style={{
                          position: "absolute",
                          width: 12,
                          height: 12,
                          border: "2px solid #2a2a2a",
                          background: "#c8f135",
                          left: corner.includes("w") ? -7 : "auto",
                          right: corner.includes("e") ? -7 : "auto",
                          top: corner.includes("n") ? -7 : "auto",
                          bottom: corner.includes("s") ? -7 : "auto",
                          cursor: `${corner}-resize`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                <div style={{ ...panelLabelStyle, alignSelf: "stretch" }}>Preview</div>
                <div
                  style={{
                    position: "relative",
                    width: faceCropPreview && faceCropPreview.aspect > 1 ? Math.round(86 / faceCropPreview.aspect) : 86,
                    height: faceCropPreview && faceCropPreview.aspect < 1 ? Math.round(86 * faceCropPreview.aspect) : 86,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "repeating-conic-gradient(#e2e2e2 0% 25%, #fafafa 0% 50%) 50% / 12px 12px",
                  }}
                >
                  {/* Rendered straight from the same bake as "Use Face" — no CSS approximation,
                      so what's shown here is exactly the oval that lands on the character. */}
                  {faceCropPreview && (
                    <img
                      src={faceCropPreview.url}
                      alt=""
                      draggable={false}
                      style={{ display: "block", width: "100%", height: "100%" }}
                    />
                  )}
                  <div
                    onPointerDown={handleMouthAnchorPointerDown}
                    title="Mouth anchor"
                    style={{
                      position: "absolute",
                      left: `${(faceMouthAnchor.x + 1) * 50}%`,
                      top: `${(faceMouthAnchor.y + 1) * 50}%`,
                      width: 12,
                      height: 12,
                      transform: "translate(-50%, -50%)",
                      borderRadius: "50%",
                      border: "2px solid #2a2a2a",
                      background: "#c8f135",
                      boxShadow: "0 0 0 2px rgba(255,253,245,0.9)",
                      cursor: "grab",
                    }}
                  />
                </div>
                <div style={{ fontSize: 9, color: "#6a6a6a", textAlign: "center", lineHeight: 1.45 }}>
                  Drag the oval to move it. Drag a corner to resize. Drag the green dot to place the mouth.
                </div>
                <button type="button" onClick={confirmFaceCrop} style={{ ...sketchButton, width: "100%", background: "#c8f135", fontWeight: 700 }}>
                  Use Face
                </button>
                <button type="button" onClick={() => setFaceCropSource(null)} style={{ ...miniButton, width: "100%" }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* YouTube Modal */}
      {ytModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setYtModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 640, maxWidth: "95vw", maxHeight: "90vh", display: "flex", flexDirection: "column", fontFamily: "monospace", overflow: "hidden" }}>

            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>
                {ytView === "search" ? "▶ ADD YOUTUBE CLIP" : `▶ TRIM  —  ${(ytSelected?.title ?? "").slice(0, 45)}${(ytSelected?.title?.length ?? 0) > 45 ? "…" : ""}`}
              </span>
              <button onClick={() => setYtModalOpen(false)} style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15 }}>×</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              {ytView === "search" ? (
                <>
                  {/* Tabs */}
                  <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                    {(["paste", "search"] as const).map((tab) => (
                      <button key={tab} onClick={() => { setYtTab(tab); setYtError(""); }}
                        style={{ fontFamily: "monospace", padding: "6px 14px", fontSize: 11, fontWeight: ytTab === tab ? 700 : 400, background: ytTab === tab ? "#2a2a2a" : "transparent", color: ytTab === tab ? "#fffdf5" : "#2a2a2a", border: "none", borderBottom: ytTab === tab ? "2px solid #c8f135" : "none", cursor: "pointer" }}>
                        {tab === "paste" ? "Paste URL" : "Search"}
                      </button>
                    ))}
                  </div>

                  {ytTab === "paste" ? (
                    <div>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <input autoFocus type="text" value={ytUrlInput}
                          onChange={(e) => setYtUrlInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleYtPasteUrl(); }}
                          placeholder="https://www.youtube.com/watch?v=..."
                          style={{ flex: 1, fontFamily: "monospace", fontSize: 12, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                        />
                        <button onClick={handleYtPasteUrl} style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700 }}>
                          Next →
                        </button>
                      </div>
                      {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, margin: 0 }}>{ytError}</p>}
                      <p style={{ fontSize: 10, color: "#9a9a9a", lineHeight: 1.6, marginTop: 10 }}>
                        Paste a YouTube URL — you&apos;ll trim it in the next step.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                        <div style={{ display: "flex", flexShrink: 0 }}>
                          {(["Shorts", "Normal"] as const).map((label) => {
                            const active = label === "Shorts" ? ytShortsOnly : !ytShortsOnly;
                            return (
                              <button key={label}
                                onClick={() => { const v = label === "Shorts"; setYtShortsOnly(v); handleYtSearch(v); }}
                                style={{ ...miniButton, fontSize: 11, padding: "4px 8px", background: active ? "#2a2a2a" : "transparent", color: active ? "#fffdf5" : "#2a2a2a", marginRight: label === "Shorts" ? -1 : 0, position: "relative", zIndex: active ? 1 : 0 }}>
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        <input autoFocus type="text" value={ytQuery}
                          onChange={(e) => setYtQuery(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleYtSearch(); }}
                          placeholder="search youtube..."
                          style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: "8px 10px", border: "1.5px solid #2a2a2a", background: "#fffdf5", outline: "none", boxShadow: "2px 2px 0 #2a2a2a" }}
                        />
                        <button onClick={() => handleYtSearch()} disabled={ytLoading}
                          style={{ ...miniButton, padding: "8px 16px", fontSize: 12, fontWeight: 700, opacity: ytLoading ? 0.5 : 1 }}>
                          {ytLoading ? "..." : "search"}
                        </button>
                      </div>
                      {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, marginBottom: 8 }}>{ytError}</p>}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                        {ytResults.map((r) => (
                          <div key={r.id}
                            onClick={() => {
                              const maxSec = parseDurationSec(r.duration);
                              const initEnd = Math.min(30, maxSec || 30);
                              setYtSelected(r);
                              setYtStart(0); setYtStartInput("0:00");
                              setYtEnd(initEnd); setYtEndInput(formatTimestamp(initEnd));
                              ytRangeRef.current = { start: 0, end: initEnd };
                              setYtView("trim");
                            }}
                            style={{ border: "1.5px solid #2a2a2a", cursor: "pointer", background: "rgba(255,253,245,0.9)", boxShadow: "2px 2px 0 #2a2a2a", overflow: "hidden" }}
                          >
                            {r.thumbnail && <img src={r.thumbnail} alt="" style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover" }} />}
                            <div style={{ padding: "5px 7px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.3, marginBottom: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
                                {r.title ?? "(no title)"}
                              </div>
                              <div style={{ fontSize: 9, color: "#6a6a6a" }}>
                                {r.channel ?? ""}{r.channel && r.duration != null ? " · " : ""}
                                {r.duration != null ? (typeof r.duration === "number" ? formatTimestamp(r.duration) : r.duration) : ""}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  {ytSelected && (() => {
                    const maxSec = parseDurationSec(ytSelected.duration) || 600;
                    const pctOf = (v: number) => Math.max(0, Math.min(100, (v / Math.max(0.1, maxSec)) * 100));
                    const clipLen = Math.max(0, ytEnd - ytStart);
                    const handleSliderMouseDown = (which: "start" | "end") => (e: React.MouseEvent) => {
                      e.preventDefault();
                      const track = ytSliderTrackRef.current;
                      if (!track) return;
                      const onMove = (ev: MouseEvent) => {
                        const rect = track.getBoundingClientRect();
                        const raw = ((ev.clientX - rect.left) / rect.width) * maxSec;
                        const clamped = Math.max(0, Math.min(maxSec, raw));
                        if (which === "start") {
                          const curEnd = ytRangeRef.current.end;
                          const newStart = Math.max(0, Math.min(clamped, curEnd - 0.5));
                          ytRangeRef.current.start = newStart;
                          setYtStart(newStart); setYtStartInput(formatTimestamp(newStart));
                          if (curEnd - newStart > 30) {
                            const newEnd = newStart + 30;
                            ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                          }
                        } else {
                          const curStart = ytRangeRef.current.start;
                          const newEnd = Math.max(curStart + 0.5, Math.min(maxSec, Math.min(clamped, curStart + 30)));
                          ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                        }
                      };
                      const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                      window.addEventListener("mousemove", onMove);
                      window.addEventListener("mouseup", onUp);
                    };
                    return (
                      <div>
                        <div style={{ marginBottom: 14, background: "#000", lineHeight: 0 }}>
                          <iframe
                            src={`https://www.youtube.com/embed/${ytSelected.id}?start=${Math.floor(ytStart)}&autoplay=0`}
                            style={{ width: "100%", aspectRatio: "16/9", border: "none" }}
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowFullScreen
                          />
                        </div>
                        <div ref={ytSliderTrackRef} style={{ position: "relative", height: 36, margin: "0 4px 14px", userSelect: "none" }}>
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: 0, right: 0, height: 8, background: "#d8d5c9", border: "1.5px solid #2a2a2a" }} />
                          <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `${pctOf(ytStart)}%`, width: `${Math.max(0, pctOf(ytEnd) - pctOf(ytStart))}%`, height: 8, background: "#c8f135", borderTop: "1.5px solid #2a2a2a", borderBottom: "1.5px solid #2a2a2a" }} />
                          <div onMouseDown={handleSliderMouseDown("start")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytStart)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                          <div onMouseDown={handleSliderMouseDown("end")} style={{ position: "absolute", top: "50%", left: `${pctOf(ytEnd)}%`, transform: "translate(-50%, -50%)", width: 12, height: 24, background: "#2a2a2a", cursor: "ew-resize", zIndex: 3 }} />
                        </div>
                        <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>Start</div>
                            <input type="text" value={ytStartInput} placeholder="0:00"
                              onChange={(e) => {
                                setYtStartInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newStart = Math.max(0, Math.min(maxSec - 0.5, p));
                                  const curEnd = ytRangeRef.current.end;
                                  ytRangeRef.current.start = newStart; setYtStart(newStart);
                                  if (curEnd <= newStart + 0.5) {
                                    const newEnd = Math.min(newStart + 30, maxSec);
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                                  } else if (curEnd - newStart > 30) {
                                    const newEnd = newStart + 30;
                                    ytRangeRef.current.end = newEnd; setYtEnd(newEnd); setYtEndInput(formatTimestamp(newEnd));
                                  }
                                }
                              }}
                              onBlur={() => setYtStartInput(formatTimestamp(ytStart))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: "#6a6a6a", marginBottom: 3 }}>End</div>
                            <input type="text" value={ytEndInput} placeholder="0:30"
                              onChange={(e) => {
                                setYtEndInput(e.target.value);
                                const p = parseTimestampSec(e.target.value);
                                if (p !== null) {
                                  const newEnd = Math.max(ytRangeRef.current.start + 0.5, Math.min(maxSec, Math.min(p, ytRangeRef.current.start + 30)));
                                  ytRangeRef.current.end = newEnd; setYtEnd(newEnd);
                                }
                              }}
                              onBlur={() => setYtEndInput(formatTimestamp(ytEnd))}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 13, border: "1.5px solid #2a2a2a", padding: "6px 8px", background: "#fffdf5", boxSizing: "border-box" } as React.CSSProperties}
                            />
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "monospace" }}>
                          Clip length: {formatTimestamp(clipLen)}
                          <span style={{ marginLeft: 8 }}>· {formatTimestamp(maxSec)} total</span>
                        </div>
                        {ytError && <p style={{ color: "#ff3a3a", fontSize: 11, fontFamily: "monospace", marginTop: 6, marginBottom: 0 }}>{ytError}</p>}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {ytView === "trim" && (
              <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => { setYtView("search"); setYtSelected(null); setYtError(""); }} style={{ ...miniButton, padding: "6px 12px", fontSize: 11 }}>← back</button>
                <button onClick={handleYtConfirm}
                  style={{ ...miniButton, marginLeft: "auto", padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#c8f135", borderColor: "#2a2a2a" }}>
                  Add to board
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Annotation Modal */}
      {AI_FEATURES_ENABLED && directCharacterOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !choreoPhase) setDirectCharacterOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>

            {/* Header */}
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>🎬 DIRECT CHARACTER</span>
              <button
                onClick={() => { if (!choreoPhase) setDirectCharacterOpen(false); }}
                style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: choreoPhase ? 0.4 : 1 }}
              >×</button>
            </div>

            <div style={{ padding: 16 }}>
              <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                Describe what the character should do through the video. GPT-4o maps it onto your actual clip order and camera timing.
              </p>
              <textarea
                value={characterDirection}
                onChange={(e) => setCharacterDirection(e.target.value)}
                disabled={!!choreoPhase}
                placeholder="He flips in onto image 1, explains it excitedly, grapples to the video and watches with popcorn, then ziplines to the last image and flips off screen"
                rows={5}
                style={{
                  width: "100%", fontFamily: "monospace", fontSize: 11,
                  border: "1.5px solid #2a2a2a", padding: "8px",
                  resize: "vertical", boxSizing: "border-box",
                  background: choreoPhase ? "#f5f5f0" : "#fff",
                } as React.CSSProperties}
              />

              {clips.some((c) => c.type === "narration") && (
                <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 11, cursor: choreoPhase ? "default" : "pointer" }}>
                  <input
                    type="checkbox"
                    checked={syncEmotesToNarration}
                    disabled={!!choreoPhase}
                    onChange={(e) => setSyncEmotesToNarration(e.target.checked)}
                  />
                  Sync emotes to my narration
                </label>
              )}

              {choreoPhase && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                  ⟳ {choreoPhase}
                </div>
              )}
              {choreoError && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                  ✗ {choreoError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { if (!choreoPhase) setDirectCharacterOpen(false); }}
                disabled={!!choreoPhase}
                style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: choreoPhase ? 0.4 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateChoreography}
                disabled={!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))}
                style={{
                  ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                  background: "#c8f135", borderColor: "#2a2a2a",
                  opacity: (!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))) ? 0.5 : 1,
                  cursor: (!!choreoPhase || (!characterDirection.trim() && !(syncEmotesToNarration && clips.some((c) => c.type === "narration")))) ? "not-allowed" : "pointer",
                }}
              >
                {choreoPhase ? "Working…" : "Generate choreography →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {AI_FEATURES_ENABLED && aiModalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !aiPhase) setAiModalOpen(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", boxShadow: "4px 4px 0 #2a2a2a", width: 480, maxWidth: "95vw", fontFamily: "monospace", overflow: "hidden" }}>

            {/* Header */}
            <div style={{ padding: "10px 16px", borderBottom: "1.5px solid #2a2a2a", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>✨ AUTO-GENERATE ANNOTATIONS</span>
              <button
                onClick={() => { if (!aiPhase) setAiModalOpen(false); }}
                style={{ ...miniButton, marginLeft: "auto", padding: "1px 7px", fontSize: 15, opacity: aiPhase ? 0.4 : 1 }}
              >×</button>
            </div>

            <div style={{ padding: 16 }}>
              {/* Tabs */}
              <div style={{ display: "flex", marginBottom: 14, borderBottom: "1.5px solid #2a2a2a" }}>
                {(["audio", "script"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => { if (!aiPhase) setAiTab(tab); }}
                    style={{
                      fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                      padding: "5px 14px", border: "none", cursor: aiPhase ? "default" : "pointer",
                      background: aiTab === tab ? "#2a2a2a" : "transparent",
                      color: aiTab === tab ? "#fff" : "#6a6a6a",
                      borderBottom: aiTab === tab ? "2px solid #2a2a2a" : "2px solid transparent",
                      marginBottom: -2,
                    }}
                  >
                    {tab === "audio" ? "↑ Upload audio" : "✎ Paste script"}
                  </button>
                ))}
              </div>

              {aiTab === "audio" ? (
                <div>
                  <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                    Upload a narration recording (.mp3, .wav, .m4a, .webm) — max 25MB. Whisper will transcribe it, then GPT-4o will generate annotations.
                  </p>
                  <input
                    type="file"
                    accept=".mp3,.wav,.m4a,.webm,audio/*"
                    disabled={!!aiPhase}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (!f) return;
                      if (f.size > 25 * 1024 * 1024) { setAiError("File too large (max 25MB)"); return; }
                      setAiAudioFile(f);
                      setAiError(null);
                    }}
                    style={{ display: "block", marginBottom: 8, fontFamily: "monospace", fontSize: 11 }}
                  />
                  {aiAudioFile && (
                    <div style={{ fontSize: 10, color: "#228b22", marginBottom: 4 }}>
                      ✓ {aiAudioFile.name} ({(aiAudioFile.size / 1024 / 1024).toFixed(1)} MB)
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 11, color: "#6a6a6a", margin: "0 0 10px", lineHeight: 1.5 }}>
                    Paste your narration script. GPT-4o will read it and generate annotations that emphasize key ideas on the board.
                  </p>
                  <textarea
                    value={aiScriptText}
                    onChange={(e) => setAiScriptText(e.target.value)}
                    disabled={!!aiPhase}
                    placeholder="Paste your narration script here…"
                    rows={8}
                    style={{
                      width: "100%", fontFamily: "monospace", fontSize: 11,
                      border: "1.5px solid #2a2a2a", padding: "8px",
                      resize: "vertical", boxSizing: "border-box",
                      background: aiPhase ? "#f5f5f0" : "#fff",
                    } as React.CSSProperties}
                  />
                </div>
              )}

              {aiPhase && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#1a6fd4" }}>
                  ⟳ {aiPhase}
                </div>
              )}
              {aiError && (
                <div style={{ marginTop: 10, fontSize: 11, color: "#cc2200" }}>
                  ✗ {aiError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "10px 16px", borderTop: "1.5px solid #2a2a2a", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { if (!aiPhase) setAiModalOpen(false); }}
                disabled={!!aiPhase}
                style={{ ...miniButton, padding: "6px 14px", fontSize: 11, opacity: aiPhase ? 0.4 : 1 }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateAnnotations}
                disabled={!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())}
                style={{
                  ...miniButton, padding: "6px 18px", fontSize: 12, fontWeight: 700,
                  background: "#c8f135", borderColor: "#2a2a2a",
                  opacity: (!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())) ? 0.5 : 1,
                  cursor: (!!aiPhase || (aiTab === "audio" ? !aiAudioFile : !aiScriptText.trim())) ? "not-allowed" : "pointer",
                }}
              >
                {aiPhase ? "Working…" : "Generate →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#2a2a2a", color: "#c8f135", fontFamily: "monospace", fontSize: 11, padding: "8px 16px", border: "1.5px solid #c8f135", boxShadow: "2px 2px 0 #c8f135", zIndex: 9999, pointerEvents: "none", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
      {renderDownloadToasts()}
      {renderNeuralSearchModal()}
      {renderTop5Modal()}
      {renderImagePreviewModal()}

      {/* Save modal */}
      {saveModalOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }} onClick={() => setSaveModalOpen(false)}>
          <div style={{ background: "#fffdf5", border: "2px solid #2a2a2a", padding: "24px 28px", minWidth: 300, boxShadow: "4px 4px 0 #2a2a2a" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#6a6a6a", textTransform: "uppercase", marginBottom: 14 }}>Save project</div>
            <input
              type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)}
              placeholder="Board name" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") saveBoard(); if (e.key === "Escape") setSaveModalOpen(false); }}
              style={{ width: "100%", fontFamily: "monospace", fontSize: 14, padding: "9px 10px", border: "1.5px solid #2a2a2a", background: "#fff", boxSizing: "border-box" as const, marginBottom: 14, outline: "none" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveBoard} disabled={isSaving} style={{ ...sketchButton, flex: 1, background: "#c8f135", fontWeight: 700 }}>
                {isSaving ? "Saving…" : "💾 Download .nbp"}
              </button>
              <button onClick={() => setSaveModalOpen(false)} style={{ ...sketchButton, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Narration compilation utilities ─────────────────────────────────────────

function writeWavStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function audioBufferToWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const n = buf.length;
  const dataLen = n * ch * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  writeWavStr(v, 0, "RIFF"); v.setUint32(4, 36 + dataLen, true); writeWavStr(v, 8, "WAVE");
  writeWavStr(v, 12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  writeWavStr(v, 36, "data"); v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function compileNarrationToBlob(narrationClips: Clip[]): Promise<Blob> {
  const sorted = [...narrationClips].sort((a, b) => a.startTime - b.startTime);
  const tmpCtx = new AudioContext();
  const decoded: { clip: Clip; buffer: AudioBuffer }[] = [];
  try {
    for (const clip of sorted) {
      const ab = clip.audioBlob
        ? await clip.audioBlob.arrayBuffer()
        : await fetch(clip.sourceUrl).then((r) => r.arrayBuffer());
      const buffer = await tmpCtx.decodeAudioData(ab);
      decoded.push({ clip, buffer });
    }
  } finally {
    await tmpCtx.close().catch(() => {});
  }
  const sampleRate = decoded[0].buffer.sampleRate;
  const firstStart = sorted[0].startTime;
  const lastClip = sorted[sorted.length - 1];
  const totalDur = lastClip.startTime + lastClip.duration - firstStart;
  const totalSamples = Math.ceil(totalDur * sampleRate);
  const numChannels = Math.max(...decoded.map((d) => d.buffer.numberOfChannels));
  const offCtx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
  for (const { clip, buffer } of decoded) {
    const node = offCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(offCtx.destination);
    const offset = Math.min(Math.max(0, clip.sourceOffsetSec ?? 0), Math.max(0, buffer.duration - 0.01));
    node.start(clip.startTime - firstStart, offset, Math.min(clip.duration, buffer.duration - offset));
  }
  const rendered = await offCtx.startRendering();
  return audioBufferToWav(rendered);
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Courier New', Courier, monospace",
  backgroundColor: "#f5f1e8",
  backgroundImage:
    "linear-gradient(rgba(100,130,180,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(100,130,180,.18) 1px, transparent 1px)",
  backgroundSize: "22px 22px",
  color: "#2a2a2a",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 22px",
  borderBottom: "1.5px dashed #2a2a2a",
  background: "rgba(255,253,245,0.75)",
  flexShrink: 0,
};

const navLinkStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#6a6a6a",
  fontFamily: "monospace",
  textDecoration: "none",
};

const panelLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: "monospace",
  color: "#6a6a6a",
  letterSpacing: 1,
  textTransform: "uppercase",
};

const sketchButton: React.CSSProperties = {
  fontFamily: "'Courier New', monospace",
  background: "#fffdf5",
  color: "#2a2a2a",
  border: "1.5px solid #2a2a2a",
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "2px 2px 0 #2a2a2a",
};

const miniButton: React.CSSProperties = {
  fontFamily: "monospace",
  background: "transparent",
  border: "1px solid #2a2a2a",
  padding: "2px 6px",
  cursor: "pointer",
  fontSize: 10,
};
