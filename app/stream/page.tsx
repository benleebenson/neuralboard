"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { DEBUG_STREAM, STREAM_OWNER_NAME, STREAM_OWNER_USER_ID } from "@/app/board2/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { RENDERER_VERSION, drawBazookaHeld, drawEliminationSequence, drawTommyGunHeld, drawWeaponProjectile, eliminationFrameForGuest, streamCharacterConstructionParams } from "@/lib/character/renderer";
import { bazookaShake, craterForImpact, drawBazookaEffect, drawCrateredImage, type BazookaVisualEvent } from "@/lib/character/craters";
import { groundProfileY, raycastSolid, type TerrainClip } from "@/lib/character/terrain";
import { CharacterEntity, type CharacterEntityIdentity } from "@/lib/character/entity";
import { isGrounded } from "@/lib/character/grounding";
import { GUEST_EMOTES, GUEST_NAME_MAX_LENGTH, GUEST_VERBS, GuestCharacterFrame, MAX_GUESTS, MAX_GUEST_SIGN_DATA_URL_BYTES, STREAM_FPS, StreamAnnotation, StreamBazookaFireMessage, StreamCamera, StreamCharacterDebugRow, StreamChokeMessage, StreamCrater, StreamEliminationMessage, StreamFrameMessage, StreamKickMessage, StreamParticipantPresence, StreamShotFiredMessage, StreamSnapshotMessage, StreamWeaponHitMessage, resolveStreamSkin, streamChannelName } from "@/lib/stream";
import { ActionWheel, wheelTriggerStyle } from "@/app/components/ActionWheel";

type Mode = "landing" | "watch" | "join" | "guest";
type GuestPhysics = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number | null;
  targetY: number | null;
  facing: 1 | -1;
  grounded: boolean;
  surfaceId: string | null;
  action: GuestCharacterFrame["actionType"];
  actionStarted: number;
  actionDurationMs?: number;
  actionFromX?: number;
  actionFromY?: number;
  actionTargetX?: number;
  actionTargetY?: number;
  actionParams?: Record<string, number | string | boolean | null | undefined>;
  emote?: string;
  spawnAt: number;
  frozenUntil?: number;
  eliminatedBy?: string;
  physique: "slim" | "jacked";
  terrainSlope?: number;
  terrainLeftFootY?: number;
  terrainRightFootY?: number;
};
const BOARD_W = 4000;
const GUEST_RESPAWN_BELOW_LOWEST_SURFACE = 650;
const GUEST_VERB_SET = new Set<string>(GUEST_VERBS);
const GUEST_DEFAULT_SKIN: "stick" | "styled" = "stick";
const GUEST_WALK_SPEED = 420;
const GUEST_RUN_SPEED = 720;
const GUEST_SKATE_ROLL_SPEED = 560;
const GUEST_PHASE_TIME_SCALE = 1.2;
const GUEST_SKATE_MOUNT_SEC = 0.3 * GUEST_PHASE_TIME_SCALE;
const GUEST_SKATE_LAND_SEC = 0.4 * GUEST_PHASE_TIME_SCALE;
const GUEST_SKATE_EDGE_MARGIN = 50;
const GUEST_SKATE_LANDING_ROLLOUT_PX = 90;
const GUEST_SKATE_MIN_POP_HEIGHT = 80;
const GUEST_SKATE_MAX_POP_HEIGHT = 140;
const GUEST_SKATE_POP_CLEARANCE = 60;
const GUEST_SKATE_PREP_SEC = 0.25 * GUEST_PHASE_TIME_SCALE;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type StreamSurface = StreamSnapshotMessage["clips"][number];
const GUEST_PLANNED_TRAVEL = new Set<GuestCharacterFrame["actionType"]>(["jump", "flip", "grapple", "skateTo", "wallClimb", "zipline"]);
const GUEST_AUTO_STOW_ACTIONS = new Set<GuestCharacterFrame["actionType"]>(["grapple", "skateTo", "wallClimb", "zipline", "forceChoke", "eliminated"]);

function streamDebugLog(...args: unknown[]) {
  if (DEBUG_STREAM) console.log("[stream:guest]", ...args);
}

function cleanName(value: string) {
  const name = value.trim().replace(/\s+/g, " ").slice(0, GUEST_NAME_MAX_LENGTH);
  const blocked = ["fuck", "shit", "bitch", "cunt", "nigger", "faggot"];
  return name && !blocked.some((word) => name.toLowerCase().includes(word)) ? name : "";
}

async function bakeFace(file: File): Promise<string> {
  const source = await createImageBitmap(file);
  const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 112;
  const ctx = canvas.getContext("2d")!; const scale = Math.max(96 / source.width, 112 / source.height);
  const w = source.width * scale, h = source.height * scale;
  ctx.beginPath(); ctx.ellipse(48, 56, 45, 53, 0, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(source, (96 - w) / 2, (112 - h) / 2, w, h); source.close();
  return canvas.toDataURL("image/png", 0.82);
}

function validSignDataUrl(value?: string): value is string {
  return !!value && value.startsWith("data:image/") && value.length <= MAX_GUEST_SIGN_DATA_URL_BYTES;
}

function drawAnnotation(ctx: CanvasRenderingContext2D, ann: StreamAnnotation, cam: StreamCamera, sf: number, W: number, H: number) {
  const sx = (x: number) => (x - cam.cameraX) * sf + W / 2, sy = (y: number) => (y - cam.cameraY) * sf + H / 2;
  ctx.save(); ctx.strokeStyle = ann.color; ctx.fillStyle = ann.color; ctx.lineWidth = Math.max(1, (ann.strokeWidth ?? 3) * sf); ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (ann.type === "text" && ann.text) { ctx.font = `${ann.fontWeight ?? "normal"} ${Math.max(9, (ann.fontSize ?? 70) * sf)}px '${ann.fontFamily ?? "Caveat"}', cursive`; ctx.textBaseline = "top"; ctx.fillText(ann.text, sx(ann.boardX), sy(ann.boardY)); }
  else if (ann.type === "arrow" && ann.arrowStartX !== undefined) { const x1=sx(ann.arrowStartX),y1=sy(ann.arrowStartY??ann.boardY),x2=sx(ann.arrowEndX??ann.boardX),y2=sy(ann.arrowEndY??ann.boardY); ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke(); }
  else if (ann.type === "circle") { ctx.beginPath();ctx.ellipse(sx(ann.boardX+ann.boardW/2),sy(ann.boardY+ann.boardH/2),ann.boardW*sf/2,ann.boardH*sf/2,0,0,Math.PI*2);ctx.stroke(); }
  else if (ann.type === "highlight") { ctx.globalAlpha=.28;ctx.fillRect(sx(ann.boardX),sy(ann.boardY),ann.boardW*sf,ann.boardH*sf); }
  else if (ann.type === "pen" && ann.points?.length) { ctx.beginPath();ctx.moveTo(sx(ann.points[0].x),sy(ann.points[0].y));for(const p of ann.points.slice(1))ctx.lineTo(sx(p.x),sy(p.y));ctx.stroke(); }
  else if (ann.type === "emoji" && ann.emoji) { ctx.font=`${Math.max(16,(ann.fontSize??120)*sf)}px system-ui`;ctx.textAlign="center";ctx.fillText(ann.emoji,sx(ann.boardX+ann.boardW/2),sy(ann.boardY+ann.boardH/2)); }
  ctx.restore();
}

function drawDoor(ctx: CanvasRenderingContext2D, x: number, y: number, cam: StreamCamera, sf: number, W: number, H: number, pulse = 0) {
  const sx=(x-cam.cameraX)*sf+W/2, sy=(y-cam.cameraY)*sf+H/2, dw=90*sf,dh=150*sf;
  ctx.save();ctx.shadowColor="#f4b942";ctx.shadowBlur=pulse*28*sf;ctx.fillStyle="#f4b942";ctx.strokeStyle="#27221f";ctx.lineWidth=Math.max(1.5,3*sf);ctx.beginPath();ctx.roundRect(sx-dw/2,sy-dh,dw*(1-pulse*.35),dh,[dw*.5,dw*.5,3,3]);ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(sx+dw*.22,sy-dh*.45,4*sf,0,Math.PI*2);ctx.fillStyle="#fff8df";ctx.fill();ctx.stroke();ctx.restore();
}

function isDrawableImage(img: HTMLImageElement | undefined | null): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.fillStyle = "#e5dcc7";
  ctx.strokeStyle = "rgba(42,42,42,0.26)";
  ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.01);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  ctx.moveTo(x + w * 0.12, y + h * 0.82);
  ctx.lineTo(x + w * 0.42, y + h * 0.52);
  ctx.lineTo(x + w * 0.58, y + h * 0.66);
  ctx.lineTo(x + w * 0.86, y + h * 0.34);
  ctx.stroke();
  ctx.restore();
}

function drawImageSafe(ctx: CanvasRenderingContext2D, img: HTMLImageElement | undefined | null, x: number, y: number, w: number, h: number): boolean {
  if (!isDrawableImage(img)) return false;
  try {
    ctx.drawImage(img, x, y, w, h);
    return true;
  } catch {
    return false;
  }
}

function streamSurfaces(snapshot: StreamSnapshotMessage): StreamSurface[] {
  return snapshot.clips.filter((clip) => clip.type === "image" || clip.type === "video");
}

function findGuestSupport(x: number, y: number, surfaces: StreamSurface[]): StreamSurface | undefined {
  return surfaces
    .filter((surface) => x >= surface.boardX + 12 && x <= surface.boardX + surface.boardW - 12)
    .sort((a, b) => Math.abs(a.boardY - y) - Math.abs(b.boardY - y))[0];
}

function clampInsideGuestSurface(surface: StreamSurface, x: number, pad = GUEST_SKATE_EDGE_MARGIN): number {
  const innerPad = Math.min(pad, Math.max(0, surface.boardW / 2 - 1));
  return clamp(x, surface.boardX + innerPad, surface.boardX + surface.boardW - innerPad);
}

function guestSkateParams(fromX: number, fromY: number, targetX: number, targetY: number, surfaces: StreamSurface[], targetSurface?: StreamSurface, craters: readonly StreamCrater[] = []): Record<string, number | string | boolean> | undefined {
  const source = findGuestSupport(fromX, fromY, surfaces);
  const target = targetSurface ?? findGuestSupport(targetX, targetY, surfaces);
  if (!source || !target) return undefined;
  const sourceCenterX = source.boardX + source.boardW / 2;
  const targetCenterX = target.boardX + target.boardW / 2;
  const facing: 1 | -1 = targetCenterX >= sourceCenterX ? 1 : -1;
  let edgeX = facing === 1 ? source.boardX + source.boardW - GUEST_SKATE_EDGE_MARGIN : source.boardX + GUEST_SKATE_EDGE_MARGIN;
  const targetHoldX = clampInsideGuestSurface(target, targetX, GUEST_SKATE_EDGE_MARGIN);
  let gapEndX = clampInsideGuestSurface(target, targetHoldX - facing * GUEST_SKATE_LANDING_ROLLOUT_PX, GUEST_SKATE_EDGE_MARGIN);
  let finalX = clampInsideGuestSurface(target, gapEndX + facing * GUEST_SKATE_LANDING_ROLLOUT_PX, GUEST_SKATE_EDGE_MARGIN);
  const gaps=craters.filter(crater=>crater.clipId===source.id&&Math.abs(crater.cy)<crater.r).map(crater=>{const half=Math.sqrt(crater.r**2-crater.cy**2);return{left:source.boardX+crater.cx-half,right:source.boardX+crater.cx+half,width:half*2};}).filter(gap=>facing===1?gap.left>fromX&&gap.left<targetX:gap.right<fromX&&gap.right>targetX).sort((a,b)=>facing===1?a.left-b.left:b.right-a.right);
  const terrainGap=gaps[0];
  if(terrainGap){edgeX=facing===1?terrainGap.left:terrainGap.right;gapEndX=facing===1?terrainGap.right:terrainGap.left;if(terrainGap.width>120)finalX=gapEndX=edgeX+facing*90;else finalX=gapEndX+facing*GUEST_SKATE_LANDING_ROLLOUT_PX;}else if(source.id===target.id)return undefined;
  const rollDistance = Math.abs(edgeX - fromX);
  const ollyDistance = Math.abs(gapEndX - edgeX);
  const heightDelta = target.boardY - source.boardY;
  const verticalClimb = Math.max(0, source.boardY - target.boardY);
  const peakHeight = clamp(verticalClimb + GUEST_SKATE_POP_CLEARANCE, GUEST_SKATE_MIN_POP_HEIGHT, GUEST_SKATE_MAX_POP_HEIGHT);
  return {
    plan: "skateTo",
    facing,
    startX: fromX,
    startY: groundProfileY(surfaces as TerrainClip[],craters,fromX)?.y??source.boardY,
    edgeX,
    launchY: groundProfileY(surfaces as TerrainClip[],craters,edgeX)?.y??source.boardY,
    gapEndX,
    landingY: groundProfileY(surfaces as TerrainClip[],craters,gapEndX)?.y??target.boardY,
    finalX,
    rollDistance,
    ollyDistance,
    heightDelta,
    peakHeight,
    targetSurfaceId: target.id,
    sourceSurfaceId: source.id,
    terrainGapWidth: terrainGap?.width??0,
    terrainAutoOllie: !!terrainGap&&terrainGap.width<=120,
  };
}

function guestGrappleParams(fromX: number, fromY: number, targetX: number, targetY: number, surfaces: StreamSurface[]): Record<string, number | string | boolean> {
  const landingY = findGuestSupport(targetX, targetY, surfaces)?.boardY ?? targetY;
  return {
    plan: "grapple",
    anchorX: fromX + (targetX - fromX) * 0.55,
    anchorY: Math.min(fromY, landingY) - 380,
    landingY,
  };
}

function nearestGuestSurface(x: number, y: number, surfaces: StreamSurface[]): StreamSurface | undefined {
  return [...surfaces].sort((a, b) => {
    const ax = clamp(x, a.boardX + 24, a.boardX + a.boardW - 24);
    const bx = clamp(x, b.boardX + 24, b.boardX + b.boardW - 24);
    return Math.hypot(ax - x, a.boardY - y) - Math.hypot(bx - x, b.boardY - y);
  })[0];
}

function resolveGuestSpawn(snapshot: StreamSnapshotMessage) {
  const surfaces = streamSurfaces(snapshot);
  const doorX = snapshot.spawnDoor?.x ?? snapshot.board.width / 2;
  const doorY = snapshot.spawnDoor?.y ?? snapshot.board.height / 2;
  const support = findGuestSupport(doorX, doorY, surfaces) ?? nearestGuestSurface(doorX, doorY, surfaces);
  if (!support) return { x: doorX, y: doorY, grounded: false, surfaceId: null as string | null };
  return {
    x: clamp(doorX, support.boardX + 24, support.boardX + support.boardW - 24),
    y: support.boardY,
    grounded: true,
    surfaceId: support.id,
  };
}

function lowestGuestSurfaceBottom(snapshot: StreamSnapshotMessage): number {
  const surfaces = streamSurfaces(snapshot);
  return surfaces.length > 0
    ? Math.max(...surfaces.map((surface) => surface.boardY + surface.boardH))
    : snapshot.spawnDoor?.y ?? snapshot.board.height;
}

function guestActionDuration(action: GuestCharacterFrame["actionType"], distance = 0, heightDelta = 0): number {
  if (action === "flip") return 0.95;
  if (action === "jump") return 1.1;
  if (action === "grapple") return 1.8;
  if (action === "zipline") return clamp(distance / 650, 0.8, 2.5);
  if (action === "skateTo") return Math.max(1.2, Math.min(4.5, distance / GUEST_SKATE_ROLL_SPEED + 0.8));
  if (action === "wallClimb") return clamp(Math.abs(heightDelta) / 350 + 0.8, 0.9, 2.8);
  if (action === "dance") return 2.5;
  if (action === "pullUps") return 2.6;
  if (action === "mirrorCheck") return 1.6;
  if (action === "sitAndWatch") return 3.0;
  if (action === "forceChoke") return 1.4;
  if (action === "emote") return 1.5;
  if (action === "eliminated") return 3.2;
  return action === "run" ? 0.75 : action === "walk" ? 0.9 : 2;
}

function guestFrameFromPhysics(p: GuestPhysics, guestId: string, name: string, sessionId: string, now: number, seq: number, skin: "stick" | "styled", signDataUrl?: string, signActive = false): GuestCharacterFrame {
  const sentAt = Date.now();
  const duration = (p.actionDurationMs ?? guestActionDuration(p.action) * 1000) / 1000;
  const progress = clamp((now - p.actionStarted) / Math.max(1, duration * 1000), 0, 1.4);
  return {
    kind: "guest-state",
    seq,
    streamId: STREAM_OWNER_USER_ID,
    sessionId,
    sentAt,
    guestId,
    name,
    position: { x: p.x, y: p.y },
    velocity: { x: p.vx, y: p.vy },
    facing: p.facing,
    actionType: p.action,
    actionProgress: progress,
    actionStartTime: sentAt - progress * duration * 1000,
    actionDuration: duration,
    actionParams: p.actionTargetX !== undefined || p.terrainSlope !== undefined ? {
      ...(p.actionParams ?? {}),
      fromX: p.actionFromX,
      fromY: p.actionFromY,
      targetX: p.actionTargetX,
      targetY: p.actionTargetY,
      terrainSlope: p.terrainSlope,
      terrainLeftFootY:p.terrainLeftFootY,
      terrainRightFootY:p.terrainRightFootY,
      terrainGrounded:p.grounded,
    } : undefined,
    skin,
    physique: p.physique,
    signDataUrl,
    signActive: !!signDataUrl && signActive,
    emote: p.emote,
  };
}

function clearGuestActionPlan(p: GuestPhysics) {
  p.actionDurationMs = undefined;
  p.actionFromX = undefined;
  p.actionFromY = undefined;
  p.actionTargetX = undefined;
  p.actionTargetY = undefined;
  p.actionParams = undefined;
}

function startGuestStationaryAction(p: GuestPhysics, action: GuestCharacterFrame["actionType"], now = performance.now()) {
  p.vx = 0;
  p.vy = 0;
  p.targetX = null;
  p.targetY = null;
  p.action = action;
  p.actionStarted = now;
  clearGuestActionPlan(p);
  p.actionDurationMs = guestActionDuration(action) * 1000;
}

function startGuestPlannedAction(p: GuestPhysics, action: GuestCharacterFrame["actionType"], targetX: number, targetY: number, surfaces: StreamSurface[] = [], targetSurface?: StreamSurface, now = performance.now(), craters: readonly StreamCrater[] = []) {
  const fromX = p.x;
  const fromY = p.y;
  const skateParams = action === "skateTo" ? guestSkateParams(fromX, fromY, targetX, targetY, surfaces, targetSurface, craters) : undefined;
  const grappleParams = action === "grapple" ? guestGrappleParams(fromX, fromY, targetX, targetY, surfaces) : undefined;
  const effectiveTargetX = typeof skateParams?.finalX === "number" ? skateParams.finalX : targetX;
  const effectiveTargetY = typeof skateParams?.landingY === "number" ? skateParams.landingY : (typeof grappleParams?.landingY === "number" ? grappleParams.landingY : targetY);
  const dx = effectiveTargetX - fromX;
  const dy = effectiveTargetY - fromY;
  const dist = Math.hypot(dx, dy);
  p.facing = Math.abs(dx) > 4 ? (dx >= 0 ? 1 : -1) : p.facing;
  p.targetX = null;
  p.targetY = null;
  p.action = action;
  p.actionStarted = now;
  p.actionDurationMs = guestActionDuration(action, dist, dy) * 1000;
  p.actionFromX = fromX;
  p.actionFromY = fromY;
  p.actionTargetX = effectiveTargetX;
  p.actionTargetY = effectiveTargetY;
  p.actionParams = {
    ...(skateParams ?? grappleParams ?? {}),
    fromX,
    fromY,
    targetX,
    targetY,
    effectiveTargetX,
    effectiveTargetY,
    durationSec: p.actionDurationMs / 1000,
  };
  p.vx = dx / Math.max(0.001, p.actionDurationMs / 1000);
  p.vy = dy / Math.max(0.001, p.actionDurationMs / 1000);
  p.grounded = isGrounded({actionType:action,explicitGrounded:action==="skateTo"?true:undefined,skateAirborne:false});
  p.surfaceId = null;
  if(skateParams?.terrainAutoOllie)streamDebugLog("terrain auto-ollie guest",{gapWidth:skateParams.terrainGapWidth,popPoint:skateParams.edgeX,path:"existing-skate-pop-land"});
}

function numParam(params: Record<string, number | string | boolean | null | undefined> | undefined, key: string): number | undefined {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function guestSkateTiming(params: Record<string, number | string | boolean | null | undefined>, durationSec: number) {
  const rollDistance = numParam(params, "rollDistance") ?? 1;
  const ollyDistance = numParam(params, "ollyDistance") ?? 1;
  const naturalRoll = Math.max(0.05 * GUEST_PHASE_TIME_SCALE, rollDistance / GUEST_SKATE_ROLL_SPEED);
  const naturalAir = Math.max(0.08 * GUEST_PHASE_TIME_SCALE, ollyDistance / GUEST_SKATE_ROLL_SPEED);
  const fixed = GUEST_SKATE_MOUNT_SEC + GUEST_SKATE_LAND_SEC;
  let mountDur = GUEST_SKATE_MOUNT_SEC;
  let landDur = GUEST_SKATE_LAND_SEC;
  let rollDur = naturalRoll;
  let airDur = naturalAir;
  if (durationSec >= fixed + 0.12) {
    const variableBudget = Math.max(0.12, durationSec - fixed);
    const variableNatural = Math.max(0.001, naturalRoll + naturalAir);
    rollDur = variableBudget * (naturalRoll / variableNatural);
    airDur = variableBudget * (naturalAir / variableNatural);
  } else {
    const naturalTotal = fixed + naturalRoll + naturalAir;
    const scale = durationSec / Math.max(0.001, naturalTotal);
    mountDur *= scale;
    landDur *= scale;
    rollDur *= scale;
    airDur *= scale;
  }
  const mountEnd = mountDur;
  const airStart = mountDur + rollDur;
  const airEnd = airStart + airDur;
  const prepDur = Math.min(GUEST_SKATE_PREP_SEC, Math.max(0, rollDur), rollDistance > 0 ? (Math.min(120, rollDistance) / rollDistance) * rollDur : 0);
  return { mountDur, landDur, rollDur, airDur, mountEnd, airStart, airEnd, prepDur };
}

function guestPlannedRootPosition(p: GuestPhysics, rawT: number, surfaces: StreamSurface[] = [], craters: readonly StreamCrater[] = []): { x: number; y: number; grounded: boolean } | null {
  if (!p.actionParams || p.actionTargetX === undefined || p.actionTargetY === undefined || p.actionFromX === undefined || p.actionFromY === undefined || !p.actionDurationMs) return null;
  if (p.action === "skateTo" && p.actionParams.plan === "skateTo") {
    const durationSec = p.actionDurationMs / 1000;
    const timing = guestSkateTiming(p.actionParams, durationSec);
    const elapsed = rawT * durationSec;
    const startX = numParam(p.actionParams, "startX") ?? p.actionFromX;
    const startY = numParam(p.actionParams, "startY") ?? p.actionFromY;
    const edgeX = numParam(p.actionParams, "edgeX") ?? p.actionTargetX;
    const gapEndX = numParam(p.actionParams, "gapEndX") ?? p.actionTargetX;
    const finalX = numParam(p.actionParams, "finalX") ?? p.actionTargetX;
    const landingY = numParam(p.actionParams, "landingY") ?? p.actionTargetY;
    const peakHeight = numParam(p.actionParams, "peakHeight") ?? 100;
    const heightDelta = numParam(p.actionParams, "heightDelta") ?? 0;
    if (elapsed < timing.mountEnd) return { x: startX, y: startY, grounded: true };
    if (elapsed < timing.airStart) {
      const rollT = timing.rollDur > 0 ? clamp((elapsed - timing.mountEnd) / timing.rollDur, 0, 1) : 1;
      const probeX=lerp(startX,edgeX,rollT),profile=groundProfileY(surfaces as TerrainClip[],craters,probeX),slopeSpeed=1+clamp((profile?.slope??0)*(edgeX>=startX?1:-1)*.15,-.15,.15),x=lerp(startX,edgeX,clamp(rollT*slopeSpeed,0,1));
      return { x, y: groundProfileY(surfaces as TerrainClip[],craters,x)?.y??startY, grounded: true };
    }
    if (elapsed < timing.airEnd) {
      const airElapsed = Math.max(0, elapsed - timing.airStart);
      const T = Math.max(0.001, timing.airDur);
      const t = clamp(airElapsed / T, 0, 1);
      const g = Math.pow((Math.sqrt(2 * peakHeight) + Math.sqrt(Math.max(0.001, 2 * (peakHeight + heightDelta)))) / T, 2);
      const v0 = -Math.sqrt(2 * g * peakHeight);
      return {
        x: lerp(edgeX, gapEndX, t),
        y: startY + v0 * airElapsed + 0.5 * g * airElapsed * airElapsed,
        grounded: false,
      };
    }
    const landT = timing.landDur > 0 ? clamp((elapsed - timing.airEnd) / timing.landDur, 0, 1) : 1;
    const rolloutT = clamp(landT / 0.68, 0, 1);
    const x=lerp(gapEndX,finalX,rolloutT);
    return { x, y: groundProfileY(surfaces as TerrainClip[],craters,x)?.y??landingY, grounded: true };
  }
  if (p.action === "grapple" && p.actionParams.plan === "grapple") {
    const progress = rawT;
    const pullStart = 0.32;
    const releaseDetach = 0.85;
    const freefallEnd = 0.93;
    const landingY = numParam(p.actionParams, "landingY") ?? p.actionTargetY;
    if (progress < pullStart) return { x: p.actionFromX, y: p.actionFromY, grounded: true };
    if (progress < releaseDetach) {
      const zipT = 1 - Math.pow(1 - clamp((progress - pullStart) / (releaseDetach - pullStart), 0, 1), 3);
      const sag = Math.sin(Math.PI * zipT) * 28;
      return { x: lerp(p.actionFromX, p.actionTargetX, zipT), y: lerp(p.actionFromY, landingY - 60, zipT) + sag, grounded: false };
    }
    if (progress < freefallEnd) {
      const t = (progress - releaseDetach) / (freefallEnd - releaseDetach);
      return { x: p.actionTargetX, y: lerp(landingY - 60, landingY, t * t), grounded: false };
    }
    return { x: p.actionTargetX, y: landingY, grounded: true };
  }
  return null;
}

function updateGuestPlannedAction(p: GuestPhysics, now: number, surfaces: StreamSurface[], craters: readonly StreamCrater[] = []): boolean {
  if (p.actionTargetX === undefined || p.actionTargetY === undefined || p.actionFromX === undefined || p.actionFromY === undefined || !p.actionDurationMs || !GUEST_PLANNED_TRAVEL.has(p.action)) return false;
  const rawT = clamp((now - p.actionStarted) / Math.max(1, p.actionDurationMs), 0, 1);
  const plannedRoot = guestPlannedRootPosition(p, rawT, surfaces, craters);
  const t = p.action === "grapple" || p.action === "zipline" ? 1 - Math.pow(1 - rawT, 2.2) : rawT;
  const prevX = p.x;
  const prevY = p.y;
  p.x = plannedRoot?.x ?? lerp(p.actionFromX, p.actionTargetX, t);
  p.y = plannedRoot?.y ?? lerp(p.actionFromY, p.actionTargetY, t);
  p.vx = (p.x - prevX) / Math.max(0.001, 1 / 60);
  p.vy = (p.y - prevY) / Math.max(0.001, 1 / 60);
  if (Math.abs(p.actionTargetX - p.actionFromX) > 4) p.facing = p.actionTargetX >= p.actionFromX ? 1 : -1;
  p.grounded = isGrounded({actionType:p.action,explicitGrounded:plannedRoot?.grounded,skateAirborne:p.action==="skateTo"&&plannedRoot?.grounded===false,grappleAirborne:p.action==="grapple"&&plannedRoot?.grounded===false});
  if(p.grounded){const profile=groundProfileY(surfaces as TerrainClip[],craters,p.x);if(profile){p.y=lerp(p.y,profile.y,.3);p.terrainSlope=profile.slope;p.surfaceId=profile.imageId;p.terrainLeftFootY=(groundProfileY(surfaces as TerrainClip[],craters,p.x-14)?.y??profile.y)-profile.y;p.terrainRightFootY=(groundProfileY(surfaces as TerrainClip[],craters,p.x+14)?.y??profile.y)-profile.y;}}
  if (rawT >= 1) {
    p.x = p.actionTargetX;
    const completionGround=groundProfileY(surfaces as TerrainClip[],craters,p.x);
    p.y = completionGround?.y??p.actionTargetY;
    p.vx = 0;
    p.vy = 0;
    p.grounded = true;
    p.surfaceId = completionGround?.imageId??findGuestSupport(p.x, p.y, surfaces)?.id??null;
    p.terrainSlope=completionGround?.slope??0;
    p.action = "idle";
    p.actionStarted = now;
    clearGuestActionPlan(p);
  }
  return true;
}

function hostDebugRow(ch: StreamFrameMessage["characters"][number], faceAspect?: number, hasFace = false): StreamCharacterDebugRow {
  const resolved = resolveStreamSkin(ch.skin, { isHost: true, sourceIfPublished: "presence", warnContext: `stream-host:${ch.id}` });
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
    construction: streamCharacterConstructionParams(resolved.skin, 1, { hasFace, faceAspect: faceAspect ?? 1, jacked: ch.physique === "jacked" }),
  };
}

function guestDebugRow(frame: GuestCharacterFrame, guestSkinOverride?: "stick" | "styled", hasFace = false): StreamCharacterDebugRow {
  const resolved = resolveStreamSkin(frame.skin, { isHost: false, sourceIfPublished: "presence", guestSkinOverride, warnContext: `stream-guest:${frame.guestId}` });
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
    construction: streamCharacterConstructionParams(resolved.skin, 1, { hasFace, faceAspect: 1, jacked: (frame.physique ?? "slim") === "jacked" }),
  };
}

export default function StreamPage() {
  const containerRef=useRef<HTMLElement>(null), canvasRef=useRef<HTMLCanvasElement>(null), signCanvasRef=useRef<HTMLCanvasElement>(null), channelRef=useRef<RealtimeChannel|null>(null), imageCache=useRef(new Map<string,HTMLImageElement>()), faceCache=useRef(new Map<string,HTMLImageElement>()), signCache=useRef(new Map<string,HTMLImageElement>());
  const characterEntities=useRef(new Map<string,CharacterEntity>());
  const latestHost=useRef<StreamFrameMessage|null>(null), hostPresent=useRef(false), snapshotRef=useRef<StreamSnapshotMessage|null>(null), snapshotRequestedAt=useRef(0), lastDebugFrameAt=useRef(0), imageRetried=useRef(new Set<string>()), reconnectAttempt=useRef(0), remoteGuests=useRef(new Map<string,GuestCharacterFrame>()), renderedGuests=useRef(new Map<string,GuestCharacterFrame>()), remoteGuestSeq=useRef(new Map<string,number>()), remoteClockOffsets=useRef(new Map<string,number>()), hostClockOffset=useRef(0), hostGuestSkin=useRef<"stick"|"styled">(GUEST_DEFAULT_SKIN), eliminations=useRef(new Map<string,StreamEliminationMessage>()), chokeStates=useRef(new Map<string,StreamChokeMessage>()), weaponState=useRef<StreamFrameMessage["weapon"]|null>(null), weaponShots=useRef<StreamShotFiredMessage[]>([]), weaponHits=useRef(new Map<string,StreamWeaponHitMessage>()), physics=useRef<GuestPhysics|null>(null), camera=useRef<StreamCamera>({cameraX:2000,cameraY:1500,boardZoom:1}), publishAt=useRef(0), guestSeq=useRef(0), emoteIndex=useRef(0), guestHeldKeys=useRef(new Set<string>());
  const signDataUrlRef=useRef<string|undefined>(undefined), signActiveRef=useRef(false), signDrawingRef=useRef(false);
  const bazookaEventsRef=useRef<BazookaVisualEvent[]>([]),cratersRef=useRef<StreamCrater[]>([]),guestBazookaArmedRef=useRef(false),guestBazookaAimRef=useRef<{x:number;y:number}|null>(null),guestBazookaLastFireAtRef=useRef(0);
  const repairAtRef=useRef(0);
  const [snapshot,setSnapshot]=useState<StreamSnapshotMessage|null>(null),[live,setLive]=useState(false),[mode,setMode]=useState<Mode>("landing"),[status,setStatus]=useState("connecting"),[subscribeStatus,setSubscribeStatus]=useState("PENDING"),[participants,setParticipants]=useState<StreamParticipantPresence[]>([]),[name,setName]=useState(""),[face,setFace]=useState<string>(),[joinError,setJoinError]=useState(""),[hostCam,setHostCam]=useState(false),[signOpen,setSignOpen]=useState(false),[signText,setSignText]=useState(""),[signColor,setSignColor]=useState("#27221f"),[signErase,setSignErase]=useState(false),[signActive,setSignActive]=useState(false),[guestSkinLabel,setGuestSkinLabel]=useState<"stick"|"styled">(GUEST_DEFAULT_SKIN),[wheelOpen,setWheelOpen]=useState(false),[wheelMenuOpen,setWheelMenuOpen]=useState(false),[debugOpen,setDebugOpen]=useState(false),[maximize,setMaximize]=useState(false),[nativeFullscreen,setNativeFullscreen]=useState(false),[guestBazookaArmed,setGuestBazookaArmed]=useState(false);
  const guestId=`guest-${useId().replace(/:/g,"-")}`, nameRef=useRef("");
  const renderDebugRowsRef=useRef<StreamCharacterDebugRow[]>([]), renderDebugOverlayAt=useRef(0);
  const [renderDebugRows,setRenderDebugRows]=useState<StreamCharacterDebugRow[]>([]);
  const entityFor=(identity:CharacterEntityIdentity)=>{let entity=characterEntities.current.get(identity.id);if(!entity){entity=new CharacterEntity(identity);characterEntities.current.set(identity.id,entity);}entity.identity=identity;return entity;};
  const loadSnapshot=useCallback(async()=>{try{const res=await fetch(`/api/stream/snapshot?streamId=${encodeURIComponent(STREAM_OWNER_USER_ID)}`,{cache:"no-store"});const data=await res.json();streamDebugLog("snapshot endpoint",{status:res.status,live:!!data.live,hasSnapshot:!!data.snapshot,updatedAt:data.updatedAt});if(data.live&&data.snapshot){snapshotRef.current=data.snapshot;setLive(true);setSnapshot(data.snapshot);setStatus("live");}else if(!latestHost.current&&!hostPresent.current){setLive(false);setStatus("offline");}}catch(error){streamDebugLog("snapshot endpoint failed",error);if(!latestHost.current&&!hostPresent.current)setStatus("reconnecting");}},[]);
  const cacheSignImage=(id:string,dataUrl?:string)=>{if(!validSignDataUrl(dataUrl))return;const current=signCache.current.get(id);if(current?.src===dataUrl)return;const img=new Image();img.src=dataUrl;signCache.current.set(id,img);};
  const refreshGuestPresence=async(_active=signActiveRef.current,dataUrl=signDataUrlRef.current)=>{if(mode!=="guest")return;const presence={role:"guest",isHost:false,guestId,name:nameRef.current,faceDataUrl:face,skin:hostGuestSkin.current,physique:physics.current?.physique??"slim",signDataUrl:validSignDataUrl(dataUrl)?dataUrl:undefined,joinedAt:Date.now()} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channelRef.current?.track(presence);};
  const clearSignCanvas=()=>{const c=signCanvasRef.current,ctx=c?.getContext("2d");if(!c||!ctx)return;ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle="#fffdf4";ctx.fillRect(0,0,c.width,c.height);};
  const bakeSign=async()=>{const source=signCanvasRef.current;if(!source)return;const out=document.createElement("canvas");out.width=256;out.height=171;const ctx=out.getContext("2d")!;ctx.fillStyle="#fffdf4";ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(source,0,0,out.width,out.height);const text=signText.trim().slice(0,40);if(text){ctx.fillStyle=signColor;ctx.font="700 27px Caveat, cursive, monospace";ctx.textAlign="center";ctx.textBaseline="middle";const words=text.split(/\s+/),lines:string[]=[];let line="";for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>218&&line){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);const start=out.height/2-(lines.length-1)*17;lines.slice(0,4).forEach((ln,i)=>ctx.fillText(ln,out.width/2,start+i*34));}const dataUrl=out.toDataURL("image/png");if(dataUrl.length>MAX_GUEST_SIGN_DATA_URL_BYTES){setJoinError("That sign is too large. Try fewer strokes.");return;}signDataUrlRef.current=dataUrl;signActiveRef.current=true;setSignActive(true);cacheSignImage(guestId,dataUrl);setSignOpen(false);await refreshGuestPresence(true,dataUrl);};
  const receiveBazookaFire=(event:StreamBazookaFireMessage)=>{const clips=(snapshotRef.current?.clips.filter(c=>c.type==="image")??[]) as TerrainClip[],impact=raycastSolid(clips,cratersRef.current,event.from,event.target),impactPoint=impact?.point??event.target,visualEvent:BazookaVisualEvent={...event,target:impactPoint,fizzle:!impact};bazookaEventsRef.current=[...bazookaEventsRef.current,visualEvent].slice(-12);const clip=impact?clips.find(candidate=>candidate.id===impact.imageId):undefined,impactDelay=Math.max(0,event.startTime+Math.hypot(impactPoint.x-event.from.x,impactPoint.y-event.from.y)/1100*1000-Date.now());window.setTimeout(()=>{if(event.startTime<repairAtRef.current)return;if(clip&&impact){const crater=craterForImpact(clip,impact.point,event.seed);cratersRef.current=[...cratersRef.current.filter(c=>c.clipId!==clip.id),...cratersRef.current.filter(c=>c.clipId===clip.id).slice(-23),crater];const p=physics.current;if(p&&Math.hypot(p.x-impact.point.x,p.y-90-impact.point.y)<140){p.vx+=(p.x<impact.point.x?-1:1)*320;p.vy=-280;p.grounded=false;p.action="jump";}}},impactDelay);};
  const fireGuestBazooka=(aim:{x:number;y:number})=>{const p=physics.current,host=latestHost.current;if(!p||!host||!guestBazookaArmedRef.current)return;const now=Date.now();if(now-guestBazookaLastFireAtRef.current<1200)return;guestBazookaLastFireAtRef.current=now;const shoulder={x:p.x,y:p.y-110},dx=aim.x-shoulder.x,dy=aim.y-shoulder.y,length=Math.max(1,Math.hypot(dx,dy)),dir={x:dx/length,y:dy/length},from={x:shoulder.x+dir.x*92,y:shoulder.y+dir.y*92},target={x:from.x+dir.x*3200,y:from.y+dir.y*3200},event:StreamBazookaFireMessage={kind:"bazooka_fire",sequenceType:"bazookaFire",streamId:STREAM_OWNER_USER_ID,sessionId:host.sessionId,sentAt:now,startTime:now,from,target,seed:Math.floor(Math.random()*1_000_000)};p.facing=dir.x>=0?1:-1;p.x-=p.facing*12;p.vx-=p.facing*90;receiveBazookaFire(event);void channelRef.current?.send({type:"broadcast",event:"bazooka_fire",payload:event});};

  useEffect(()=>{const initial=window.setTimeout(()=>void loadSnapshot(),0);const supabase=getBrowserSupabase();const channelName=streamChannelName(STREAM_OWNER_USER_ID);if(!supabase){streamDebugLog("realtime not configured",{channel:channelName});window.setTimeout(()=>setStatus("realtime-not-configured"),0);return()=>window.clearTimeout(initial);}const key=`client-${guestId}`;streamDebugLog("join channel",{channel:channelName,key});const channel=supabase.channel(channelName,{config:{broadcast:{self:false},presence:{key}}});channelRef.current=channel;
    const requestSnapshot=()=>{const now=Date.now();if(now-snapshotRequestedAt.current<1000)return;snapshotRequestedAt.current=now;streamDebugLog("snapshot request",{channel:channelName,requestedAt:now});void channel.send({type:"broadcast",event:"snapshot-request",payload:{streamId:STREAM_OWNER_USER_ID,sentAt:now}});};
    channel.on("broadcast",{event:"snapshot"},({payload})=>{streamDebugLog("snapshot broadcast",{sessionId:(payload as StreamSnapshotMessage).sessionId,clips:(payload as StreamSnapshotMessage).clips?.length});snapshotRef.current=payload as StreamSnapshotMessage;setSnapshot(snapshotRef.current);setLive(true);setStatus("live");})
      .on("broadcast",{event:"frame"},({payload})=>{const frame=payload as StreamFrameMessage;const previousSeq=latestHost.current?.seq??-1;if(frame.seq!==undefined&&frame.seq<=previousSeq){streamDebugLog("drop stale host frame",{seq:frame.seq,previousSeq});return;}if(frame.guestSkin){hostGuestSkin.current=frame.guestSkin;setGuestSkinLabel(frame.guestSkin);}const measured=Date.now()-frame.sentAt;hostClockOffset.current=hostClockOffset.current?hostClockOffset.current*.88+measured*.12:measured;if(frame.weapon)weaponState.current=frame.weapon;if(DEBUG_STREAM&&Date.now()-lastDebugFrameAt.current>2000){lastDebugFrameAt.current=Date.now();streamDebugLog("frame broadcast",{seq:frame.seq,sentAt:frame.sentAt,clockOffset:Math.round(hostClockOffset.current),renderer:RENDERER_VERSION,guestSkin:hostGuestSkin.current,weapon:frame.weapon,characters:frame.characters?.filter(ch=>ch.enabled).map(ch=>ch.id)});}latestHost.current=frame;setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();})
      .on("broadcast",{event:"guest-state"},({payload})=>{const f=payload as GuestCharacterFrame;if(f.sessionId===latestHost.current?.sessionId||!latestHost.current){const prevSeq=remoteGuestSeq.current.get(f.guestId)??-1;if(f.seq!==undefined&&f.seq<=prevSeq){streamDebugLog("drop stale guest-state",{guestId:f.guestId,seq:f.seq,prevSeq});return;}if(f.seq!==undefined)remoteGuestSeq.current.set(f.guestId,f.seq);if(validSignDataUrl(f.signDataUrl))cacheSignImage(f.guestId,f.signDataUrl);const measured=Date.now()-f.sentAt;const prev=remoteClockOffsets.current.get(f.guestId)??measured;remoteClockOffsets.current.set(f.guestId,prev*.85+measured*.15);remoteGuests.current.set(f.guestId,{...f,receivedAt:Date.now()});}})
      .on("broadcast",{event:"elimination"},({payload})=>{const event=payload as StreamEliminationMessage;eliminations.current.set(event.targetGuestId,event);streamDebugLog("elimination received",{target:event.targetGuestId,start:event.startTime,duration:event.duration});const p=physics.current;if(event.targetGuestId===guestId&&p){signActiveRef.current=false;setSignActive(false);p.action="eliminated";p.actionStarted=performance.now();p.frozenUntil=event.startTime+event.duration*1000+250;p.eliminatedBy=event.hostName;p.targetX=null;p.targetY=null;p.vx=0;p.vy=0;clearGuestActionPlan(p);void refreshGuestPresence(false);}})
      .on("broadcast",{event:"weapon_state"},({payload})=>{streamDebugLog("ignore legacy weapon_state; frame.weapon is authoritative",payload);})
      .on("broadcast",{event:"shot_fired"},({payload})=>{streamDebugLog("shot_fired received",(payload as StreamShotFiredMessage).shotId);weaponShots.current=[...weaponShots.current,payload as StreamShotFiredMessage].slice(-80);})
      .on("broadcast",{event:"bazooka_fire"},({payload})=>receiveBazookaFire(payload as StreamBazookaFireMessage))
      .on("broadcast",{event:"repair_board"},({payload})=>{repairAtRef.current=(payload as {sentAt:number}).sentAt;cratersRef.current=[];streamDebugLog("repair board guest");})
      .on("broadcast",{event:"hit"},({payload})=>{const hit=payload as StreamWeaponHitMessage;weaponHits.current.set(hit.guestId,hit);if(hit.guestId===guestId&&physics.current){clearGuestActionPlan(physics.current);physics.current.vx+=hit.dir.x*140;physics.current.vy-=120;physics.current.action="jump";physics.current.actionStarted=performance.now();}})
      .on("broadcast",{event:"choke_state"},({payload})=>{const msg=payload as StreamChokeMessage;if(msg.phase==="end")chokeStates.current.delete(msg.targetGuestId);else chokeStates.current.set(msg.targetGuestId,msg);const p=physics.current;if(msg.targetGuestId===guestId&&p){if(msg.phase==="hold"){if(signActiveRef.current){signActiveRef.current=false;setSignActive(false);void refreshGuestPresence(false);}p.x=msg.position.x;p.y=msg.position.y;p.vx=0;p.vy=0;p.targetX=null;p.targetY=null;p.grounded=false;p.action="forceChoke";p.actionStarted=performance.now();clearGuestActionPlan(p);}else if(msg.phase==="drop"){p.x=msg.position.x;p.y=msg.position.y;p.vx=0;p.vy=420;p.grounded=false;p.action="jump";p.actionStarted=performance.now();clearGuestActionPlan(p);}}})
      .on("broadcast",{event:"remove-sign"},({payload})=>{const msg=payload as {guestId?:string};if(msg.guestId===guestId){signDataUrlRef.current=undefined;signActiveRef.current=false;setSignActive(false);signCache.current.delete(guestId);void refreshGuestPresence(false,undefined);}})
      .on("broadcast",{event:"kick"},({payload})=>{const kick=payload as StreamKickMessage;if(kick.guestId===guestId){eliminations.current.delete(guestId);chokeStates.current.delete(guestId);remoteGuests.current.delete(guestId);renderedGuests.current.delete(guestId);remoteGuestSeq.current.delete(guestId);signDataUrlRef.current=undefined;signActiveRef.current=false;setSignActive(false);signCache.current.delete(guestId);channel.untrack();physics.current=null;setMode("landing");setJoinError(kick.reason==="elimination_tommygun"?`💥 KICKED by ${kick.hostName||"Host"}`:"You were removed by the host.");}})
      .on("broadcast",{event:"session-end"},()=>{streamDebugLog("session end");hostPresent.current=false;latestHost.current=null;snapshotRef.current=null;setSnapshot(null);setLive(false);setStatus("ended");physics.current=null;setMode("landing");})
      .on("presence",{event:"sync"},()=>{const rows=Object.values(channel.presenceState()).flat() as unknown as StreamParticipantPresence[];streamDebugLog("presence sync",rows);const hostRow=rows.find(p=>p.role==="host");if(hostRow?.guestSkin){hostGuestSkin.current=hostRow.guestSkin;setGuestSkinLabel(hostRow.guestSkin);}hostPresent.current=rows.some(p=>p.role==="host");setParticipants(rows);if(hostPresent.current){setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();}for(const p of rows){if(p.guestId){const stale=eliminations.current.get(p.guestId);if(stale&&p.joinedAt>stale.sentAt){streamDebugLog("clear stale elimination on rejoin",{guestId:p.guestId,joinedAt:p.joinedAt,eliminationSentAt:stale.sentAt});eliminations.current.delete(p.guestId);remoteGuests.current.delete(p.guestId);renderedGuests.current.delete(p.guestId);}if(p.faceDataUrl&&!faceCache.current.has(p.guestId)){const img=new Image();img.src=p.faceDataUrl;faceCache.current.set(p.guestId,img);}if(validSignDataUrl(p.signDataUrl))cacheSignImage(p.guestId,p.signDataUrl);}}})
      .subscribe(async s=>{setSubscribeStatus(s);streamDebugLog("subscribe status",s);if(s==="SUBSCRIBED"){reconnectAttempt.current=0;const presence={role:"viewer",isHost:false,joinedAt:Date.now()} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channel.track(presence);requestSnapshot();window.setTimeout(()=>{if(!snapshotRef.current)requestSnapshot();},1200);void loadSnapshot();}else if(s==="CHANNEL_ERROR"||s==="TIMED_OUT"||s==="CLOSED"){setStatus("reconnecting");const delay=Math.min(8000,1000*2**reconnectAttempt.current++);window.setTimeout(()=>{streamDebugLog("reconnect retry",{delay});void loadSnapshot();requestSnapshot();},delay);}});return()=>{window.clearTimeout(initial);hostPresent.current=false;supabase.removeChannel(channel);channelRef.current=null;};},[guestId,loadSnapshot]);

  useEffect(()=>{if(!snapshot)return;cratersRef.current=snapshot.craters??[];streamDebugLog("snapshot craters late join",cratersRef.current);const load=(cache:Map<string,HTMLImageElement>,url:string)=>{if(!url||cache.has(url))return;const img=new Image();img.crossOrigin="anonymous";img.onerror=()=>streamDebugLog("image load failed",{url:url.slice(0,48)});img.src=url;cache.set(url,img);};for(const clip of snapshot.clips){const url=clip.type==="video"?(clip.thumbnailUrl||clip.sourceUrl):clip.sourceUrl;load(imageCache.current,url);}for(const ch of snapshot.characters)if(ch.faceDataUrl&&!faceCache.current.has(ch.id)){const img=new Image();img.src=ch.faceDataUrl;faceCache.current.set(ch.id,img);}},[snapshot]);

  const beginGuest=async()=>{const safe=cleanName(name);if(!safe){setJoinError("Enter a short, appropriate name.");return;}const guests=participants.filter(p=>p.role==="guest");if(guests.length>=MAX_GUESTS){setJoinError("This room is full.");return;}if(!snapshot)return;nameRef.current=safe;if(face&&!faceCache.current.has(guestId)){const img=new Image();img.src=face;faceCache.current.set(guestId,img);}if(signDataUrlRef.current)cacheSignImage(guestId,signDataUrlRef.current);const spawn=resolveGuestSpawn(snapshot);physics.current={x:spawn.x,y:spawn.y,vx:0,vy:0,targetX:null,targetY:null,facing:1,grounded:spawn.grounded,surfaceId:spawn.surfaceId,action:"idle",actionStarted:performance.now(),spawnAt:performance.now(),physique:"slim"};camera.current={cameraX:spawn.x,cameraY:spawn.y-120,boardZoom:1.35};guestSeq.current=0;const joinedAt=Date.now();const presence={role:"guest",isHost:false,guestId,name:safe,faceDataUrl:face,skin:hostGuestSkin.current,physique:"slim",signDataUrl:validSignDataUrl(signDataUrlRef.current)?signDataUrlRef.current:undefined,joinedAt} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channelRef.current?.track(presence);setMode("guest");setJoinError("");};
  const emote=()=>{const p=physics.current;if(!p||!GUEST_VERB_SET.has("emote"))return;p.emote=GUEST_EMOTES[emoteIndex.current++%GUEST_EMOTES.length];startGuestStationaryAction(p,"emote");};
  const flipGuestTo=(targetX?:number,targetY?:number)=>{const p=physics.current;if(!p||!p.grounded)return;startGuestPlannedAction(p,"flip",targetX??p.x+p.facing*520,targetY??p.y);};
  const guestTargetVerb=(): GuestCharacterFrame["actionType"]|null=>{const keys=guestHeldKeys.current;if(keys.has("g"))return"grapple";if(keys.has("s"))return"skateTo";if(keys.has("c"))return"wallClimb";if(keys.has("z"))return"zipline";return null;};
  const issueGuestTargetVerb=(action:GuestCharacterFrame["actionType"],targetX:number,targetY:number,surfaces:StreamSurface[]=[],targetSurface?:StreamSurface)=>{const p=physics.current;if(!p)return;startGuestPlannedAction(p,action,targetX,targetY,surfaces,targetSurface,performance.now(),cratersRef.current);};
  const leave=async()=>{await channelRef.current?.track({role:"viewer",joinedAt:Date.now()} satisfies StreamParticipantPresence);physics.current=null;setMode("landing");};
  const dismissWheel=()=>{setWheelOpen(false);setWheelMenuOpen(false);};
  const exitFullscreen=useCallback(async()=>{const doc=document as FullscreenDocument;if(document.fullscreenElement||doc.webkitFullscreenElement){if(document.exitFullscreen)await document.exitFullscreen();else await doc.webkitExitFullscreen?.();}setMaximize(false);setNativeFullscreen(false);},[]);
  const toggleFullscreen=useCallback(async()=>{const doc=document as FullscreenDocument;if(document.fullscreenElement||doc.webkitFullscreenElement||maximize){await exitFullscreen();return;}const target=containerRef.current as FullscreenElement|null;if(!target)return;if(target.requestFullscreen){await target.requestFullscreen();setNativeFullscreen(true);}else if(target.webkitRequestFullscreen){await target.webkitRequestFullscreen();setNativeFullscreen(true);}else setMaximize(true);},[exitFullscreen,maximize]);
  useEffect(()=>{const changed=()=>setNativeFullscreen(Boolean(document.fullscreenElement||(document as FullscreenDocument).webkitFullscreenElement));document.addEventListener("fullscreenchange",changed);document.addEventListener("webkitfullscreenchange",changed);return()=>{document.removeEventListener("fullscreenchange",changed);document.removeEventListener("webkitfullscreenchange",changed);};},[]);

  useEffect(() => {
    if (mode !== "watch" && mode !== "guest") return;
    let raf = 0;
    let last = performance.now();
    const retryImage = (url: string) => {
      if (!url || imageRetried.current.has(url)) return;
      imageRetried.current.add(url);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onerror = () => streamDebugLog("image retry failed", { url: url.slice(0, 48) });
      img.src = url;
      imageCache.current.set(url, img);
    };
    const frame = (now: number) => {
      try {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) {
          raf = requestAnimationFrame(frame);
          return;
        }
        const dpr = Math.min(2, devicePixelRatio || 1);
        const w = Math.floor(innerWidth * dpr);
        const h = Math.floor(innerHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const host = latestHost.current;
        const p = physics.current;
        if (p && snapshot) {
          const surfaces = streamSurfaces(snapshot);
          const held = chokeStates.current.get(guestId);
          if (held?.phase === "hold") {
            p.x = lerp(p.x, held.position.x, 0.45);
            p.y = lerp(p.y, held.position.y, 0.45);
            p.vx = 0;
            p.vy = 0;
            p.targetX = null;
            p.targetY = null;
            p.grounded = false;
            p.action = "forceChoke";
            clearGuestActionPlan(p);
          }
          const frozen = (p.frozenUntil !== undefined && Date.now() < p.frozenUntil) || held?.phase === "hold";
          if (p.action === "emote" && now - p.actionStarted > 1500) {
            p.action = "idle";
            p.emote = undefined;
            clearGuestActionPlan(p);
          }
          if (["dance","pullUps","mirrorCheck","sitAndWatch"].includes(p.action) && now - p.actionStarted > (p.actionDurationMs ?? guestActionDuration(p.action) * 1000)) {
            p.action = "idle";
            clearGuestActionPlan(p);
          }
          const planned = !frozen && held?.phase !== "hold" && updateGuestPlannedAction(p, now, surfaces, cratersRef.current);
          const target = p.targetX;
          if (!planned && target !== null && !frozen) {
            const dx = target - p.x;
            if (Math.abs(dx) < 14) {
              p.vx = 0;
              p.targetX = null;
              if (p.grounded) p.action = "idle";
            } else {
              p.facing = dx > 0 ? 1 : -1;
              const speed = Math.abs(dx) > 280 ? GUEST_RUN_SPEED : GUEST_WALK_SPEED;
              p.vx = p.facing * speed;
              if (p.grounded) p.action = Math.abs(dx) > 280 ? "run" : "walk";
            }
          } else if (!planned && frozen) {
            p.vx = 0;
            p.targetX = null;
          }
          if (!planned && held?.phase !== "hold") {
            if (p.grounded) {
              const ground = groundProfileY(surfaces as TerrainClip[], cratersRef.current, p.x);
              if (!ground||(p.surfaceId!==null&&ground.imageId!==p.surfaceId&&ground.y>p.y+8)) {
                p.grounded = false;
                p.surfaceId = null;
                p.vy = 30;
                streamDebugLog("terrain fall guest", { x: p.x, fromY: p.y });
              } else {
                p.y = lerp(p.y, ground.y, 1 - Math.exp(-dt * 14));
                p.surfaceId = ground.imageId;
                p.terrainSlope = ground.slope;
                p.terrainLeftFootY=(groundProfileY(surfaces as TerrainClip[],cratersRef.current,p.x-14)?.y??ground.y)-ground.y;
                p.terrainRightFootY=(groundProfileY(surfaces as TerrainClip[],cratersRef.current,p.x+14)?.y??ground.y)-ground.y;
              }
            }
            if(p.grounded&&Math.abs(p.vx)>1){const direction=p.vx>0?1:-1,nextX=p.x+p.vx*dt,terrain=surfaces as TerrainClip[];if(!groundProfileY(terrain,cratersRef.current,nextX)){let landingX:number|undefined;for(let d=6;d<=120;d+=6){if(groundProfileY(terrain,cratersRef.current,nextX+direction*d)){landingX=nextX+direction*d;break;}}if(landingX!==undefined){p.grounded=false;p.surfaceId=null;p.vy=-520;streamDebugLog("terrain auto-jump guest",{gapWidth:Math.abs(landingX-nextX),popPoint:p.x});}else{p.vx=0;streamDebugLog("terrain stop at lip guest",{x:p.x});}}}
            p.x += p.vx * dt;
            if (!p.grounded) {
              const previousY = p.y;
              p.vy = Math.min(1200, p.vy + 1850 * dt);
              const nextY = p.y + p.vy * dt;
              const landing = groundProfileY(surfaces as TerrainClip[], cratersRef.current, p.x);
              if (landing && previousY <= landing.y && nextY >= landing.y) {
                p.y = landing.y;
                p.vy = 0;
                p.grounded = true;
                p.surfaceId = landing.imageId;
                p.terrainSlope = landing.slope;
                p.terrainLeftFootY=(groundProfileY(surfaces as TerrainClip[],cratersRef.current,p.x-14)?.y??landing.y)-landing.y;
                p.terrainRightFootY=(groundProfileY(surfaces as TerrainClip[],cratersRef.current,p.x+14)?.y??landing.y)-landing.y;
                p.action = p.targetX === null ? "idle" : p.action;
                streamDebugLog("terrain landing guest", { x: p.x, groundY: landing.y, slope: landing.slope });
              } else {
                p.y = nextY;
              }
            }
          }
          if (p.y > lowestGuestSurfaceBottom(snapshot) + GUEST_RESPAWN_BELOW_LOWEST_SURFACE) {
            const spawn = resolveGuestSpawn(snapshot);
            p.x = spawn.x;
            p.y = spawn.y;
            p.vx = 0;
            p.vy = 0;
            p.targetX = null;
            p.targetY = null;
            p.grounded = spawn.grounded;
            p.surfaceId = spawn.surfaceId;
            p.action = "idle";
            p.emote = undefined;
            p.actionStarted = now;
            p.spawnAt = now;
            camera.current.cameraX = spawn.x;
            camera.current.cameraY = spawn.y - 120;
          }
          if (!hostCam) {
            const t = 1 - Math.exp(-dt * 5.5);
            camera.current.cameraX = lerp(camera.current.cameraX, p.x, t);
            camera.current.cameraY = lerp(camera.current.cameraY, p.y - 120, t);
            camera.current.boardZoom = lerp(camera.current.boardZoom, 1.35, t * 0.1);
          }
        }
        if ((mode === "watch" || hostCam) && host) {
          camera.current = {
            cameraX: lerp(camera.current.cameraX, host.camera.cameraX, 0.22),
            cameraY: lerp(camera.current.cameraY, host.camera.cameraY, 0.22),
            boardZoom: lerp(camera.current.boardZoom, host.camera.boardZoom, 0.2),
          };
        }
        if (p && now - publishAt.current > 1000 / STREAM_FPS && host) {
          publishAt.current = now;
          const packet = guestFrameFromPhysics(p, guestId, nameRef.current, host.sessionId, now, ++guestSeq.current, hostGuestSkin.current, validSignDataUrl(signDataUrlRef.current) ? signDataUrlRef.current : undefined, signActiveRef.current);
          channelRef.current?.send({ type: "broadcast", event: "guest-state", payload: packet });
        }
        const baseCam = camera.current;
        const sf = baseCam.boardZoom * w / BOARD_W;
        const shake=bazookaShake(bazookaEventsRef.current);
        const cam={...baseCam,cameraX:baseCam.cameraX-shake.x/sf,cameraY:baseCam.cameraY-shake.y/sf};
        ctx.fillStyle = snapshot?.board.backgroundColor ?? "#f5ecd8";
        ctx.fillRect(0, 0, w, h);
        if (snapshot) {
          for (const clip of [...snapshot.clips].sort((a, b) => (a.layer ?? 1) - (b.layer ?? 1))) {
            const x = (clip.boardX - cam.cameraX) * sf + w / 2;
            const y = (clip.boardY - cam.cameraY) * sf + h / 2;
            const sw = clip.boardW * sf;
            const sh = clip.boardH * sf;
            const url = clip.type === "video" ? (clip.thumbnailUrl || clip.sourceUrl) : clip.sourceUrl;
            const img = imageCache.current.get(url);
            if (img?.complete&&img.naturalWidth>0&&clip.type==="image") drawCrateredImage(ctx,img,x,y,sw,sh,clip.boardW,clip.boardH,cratersRef.current.filter(crater=>crater.clipId===clip.id));
            else if (!drawImageSafe(ctx, img, x, y, sw, sh)) {
              drawPlaceholder(ctx, x, y, sw, sh);
              retryImage(url);
            }
            if (clip.type === "video" || clip.videoBadge) {
              ctx.save();
              ctx.fillStyle = "rgba(0,0,0,0.62)";
              ctx.fillRect(x + 8, y + 8, 58, 20);
              ctx.fillStyle = "#fff";
              ctx.font = "12px monospace";
              ctx.fillText("VIDEO", x + 15, y + 22);
              ctx.restore();
            }
          }
          for(const event of bazookaEventsRef.current)drawBazookaEffect(ctx,event,cam,sf,w,h,Date.now());
          for (const ann of snapshot.annotations) drawAnnotation(ctx, ann, cam, sf, w, h);
          if (snapshot.spawnDoor) drawDoor(ctx, snapshot.spawnDoor.x, snapshot.spawnDoor.y, cam, sf, w, h, p ? clamp(1 - (now - p.spawnAt) / 900, 0, 1) : 0);
          if (host) {
            const rows: StreamCharacterDebugRow[] = [];
            for (const ch of host.characters) {
              if (!ch.enabled) continue;
              const faceInfo = snapshot.characters.find((x) => x.id === ch.id);
              rows.push(hostDebugRow(ch, faceInfo?.faceAspect, !!faceInfo?.faceDataUrl));
              const entity = entityFor({ id: ch.id, isHost: true, name: ch.id === "c1" ? STREAM_OWNER_NAME : "Host 2", skin: ch.skin ?? "stick", physique: ch.physique, faceDataUrl: faceInfo?.faceDataUrl, faceAspect: faceInfo?.faceAspect });
              entity.setHostFrame(ch, hostClockOffset.current);
              entity.draw({ ctx, cam, sf, width: w, height: h, face: faceCache.current.get(ch.id) ?? null, renderTimeMs: Date.now() });
            }
            renderDebugRowsRef.current = rows;
          }
          if (weaponState.current?.armed && weaponState.current.shooter && weaponState.current.aim) {if(weaponState.current.kind==="bazooka")drawBazookaHeld(ctx,weaponState.current.shooter,weaponState.current.aim,cam,sf,w,h,0);else drawTommyGunHeld(ctx, weaponState.current.shooter, weaponState.current.aim, cam, sf, w, h, 0);}
          weaponShots.current = weaponShots.current.filter((shot) => Date.now() - shot.sentAt < 1700);
          for (const shot of weaponShots.current) drawWeaponProjectile(ctx, shot, cam, sf, w, h, Date.now());
          for (const [guestIdForEvent, event] of eliminations.current) {
            if (Date.now() - event.startTime > event.duration * 1000 + 900) eliminations.current.delete(guestIdForEvent);
            else drawEliminationSequence(ctx, event, cam, sf, w, h, Date.now(), hostClockOffset.current);
          }
          for (const [id, g] of remoteGuests.current) {
            if (id === guestId && p) continue;
            const event = eliminations.current.get(id);
            const choke = chokeStates.current.get(id);
            const renderFrame = choke?.phase === "hold"
              ? { ...g, position: choke.position, velocity: { x: 0, y: -20 }, actionType: "forceChoke" as const, actionProgress: choke.progress, actionStartTime: choke.sentAt - choke.progress * 1400, actionDuration: 1.4 }
              : choke?.phase === "drop"
                ? { ...g, position: choke.position, velocity: { x: 0, y: 540 }, actionType: "jump" as const, actionProgress: 0.85, actionStartTime: choke.sentAt - 900, actionDuration: 1.1 }
                : event ? eliminationFrameForGuest(g, event, Date.now(), hostClockOffset.current) : g;
            if (!renderFrame) {
              renderedGuests.current.delete(id);
              remoteGuests.current.delete(id);
              if (process.env.NODE_ENV !== "production") console.debug("[stream:despawn]", { where: "spectator-remote", guestId: id, event: event?.sequenceType });
              continue;
            }
            const old = renderedGuests.current.get(id);
            const error = old ? Math.hypot(old.position.x - renderFrame.position.x, old.position.y - renderFrame.position.y) : 0;
            const alpha = event ? 0.85 : error > 300 ? 1 : 0.35;
            const smooth = old ? { ...renderFrame, position: { x: lerp(old.position.x, renderFrame.position.x, alpha), y: lerp(old.position.y, renderFrame.position.y, alpha) } } : renderFrame;
            renderedGuests.current.set(id, smooth);
            renderDebugRowsRef.current = [...renderDebugRowsRef.current.filter((row) => row.id !== id), guestDebugRow(smooth, hostGuestSkin.current, !!faceCache.current.get(id))];
            const entity = entityFor({ id, isHost: false, name: smooth.name, skin: hostGuestSkin.current, physique: smooth.physique ?? "slim" });
            entity.setGuestFrame(smooth, remoteClockOffsets.current.get(id) ?? 0, hostGuestSkin.current);
            entity.draw({ ctx, cam, sf, width: w, height: h, face: faceCache.current.get(id) ?? null, sign: signCache.current.get(id) ?? null, alpha: id === guestId ? clamp((now - (p?.spawnAt ?? 0)) / 650, 0, 1) : 1, renderTimeMs: Date.now(), guestSkinOverride: hostGuestSkin.current });
          }
          if (p && mode === "guest") {
            const sessionId = host?.sessionId ?? latestHost.current?.sessionId ?? "local";
            const localFrame = guestFrameFromPhysics(p, guestId, nameRef.current, sessionId, now, guestSeq.current, hostGuestSkin.current, validSignDataUrl(signDataUrlRef.current) ? signDataUrlRef.current : undefined, signActiveRef.current);
            const event = eliminations.current.get(guestId);
            const choke = chokeStates.current.get(guestId);
            const renderFrame = choke?.phase === "hold"
              ? { ...localFrame, position: choke.position, velocity: { x: 0, y: -20 }, actionType: "forceChoke" as const, actionProgress: choke.progress, actionStartTime: choke.sentAt - choke.progress * 1400, actionDuration: 1.4 }
              : choke?.phase === "drop"
                ? { ...localFrame, position: choke.position, velocity: { x: 0, y: 540 }, actionType: "jump" as const, actionProgress: 0.85, actionStartTime: choke.sentAt - 900, actionDuration: 1.1 }
                : event ? eliminationFrameForGuest(localFrame, event, Date.now(), hostClockOffset.current) : localFrame;
            if (renderFrame) {
              renderDebugRowsRef.current = [...renderDebugRowsRef.current.filter((row) => row.id !== guestId), guestDebugRow(renderFrame, hostGuestSkin.current, !!faceCache.current.get(guestId))];
              const entity = entityFor({ id: guestId, isHost: false, name: renderFrame.name, skin: hostGuestSkin.current, physique: renderFrame.physique ?? "slim", faceDataUrl: face });
              entity.setGuestFrame(renderFrame, 0, hostGuestSkin.current);
              entity.draw({ ctx, cam, sf, width: w, height: h, face: faceCache.current.get(guestId) ?? null, sign: signCache.current.get(guestId) ?? null, alpha: clamp((now - p.spawnAt) / 650, 0, 1), renderTimeMs: Date.now(), guestSkinOverride: hostGuestSkin.current });
              if(guestBazookaArmedRef.current){const aim=guestBazookaAimRef.current??{x:p.x+p.facing*500,y:p.y-110};drawBazookaHeld(ctx,{x:p.x,y:p.y,facing:p.facing},aim,cam,sf,w,h,0);}
            } else {
              if (process.env.NODE_ENV !== "production") console.debug("[stream:despawn]", { where: "spectator-local", guestId, event: event?.sequenceType });
              void channelRef.current?.untrack();
              signDataUrlRef.current = undefined;
              signActiveRef.current = false;
              setSignActive(false);
              signCache.current.delete(guestId);
              physics.current = null;
              setMode("landing");
              setJoinError(`💥 KICKED by ${event?.hostName || "Host"}`);
            }
          }
          if (DEBUG_STREAM && now - renderDebugOverlayAt.current > 600) {
            renderDebugOverlayAt.current = now;
            setRenderDebugRows(renderDebugRowsRef.current);
          }
        }
      } catch (error) {
        streamDebugLog("render loop recovered", error);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [guestId, mode, hostCam, snapshot]);

  const clickCanvas=(e:React.MouseEvent<HTMLCanvasElement>)=>{const p=physics.current;if(!p||!snapshot||hostCam||(p.frozenUntil&&Date.now()<p.frozenUntil)||chokeStates.current.get(guestId)?.phase==="hold")return;const rect=e.currentTarget.getBoundingClientRect(),cam=camera.current,sf=cam.boardZoom*rect.width/BOARD_W,rawX=(e.clientX-rect.left-rect.width/2)/sf+cam.cameraX,rawY=(e.clientY-rect.top-rect.height/2)/sf+cam.cameraY;guestBazookaAimRef.current={x:rawX,y:rawY};if(guestBazookaArmedRef.current){fireGuestBazooka({x:rawX,y:rawY});return;}const allSurfaces=streamSurfaces(snapshot);const surfaces=allSurfaces.filter(s=>rawX>=s.boardX&&rawX<=s.boardX+s.boardW);const destination=surfaces.sort((a,b)=>Math.abs(a.boardY-rawY)-Math.abs(b.boardY-rawY))[0];const targetX=destination?clamp(rawX,destination.boardX+18,destination.boardX+destination.boardW-18):clamp(rawX,0,snapshot.board.width);const targetY=destination?.boardY??p.y;const verb=guestTargetVerb();if(verb){if(GUEST_AUTO_STOW_ACTIONS.has(verb)&&signActiveRef.current){signActiveRef.current=false;setSignActive(false);void refreshGuestPresence(false);}issueGuestTargetVerb(verb,targetX,targetY,allSurfaces,destination);return;}const dx=targetX-p.x;const wantsArc=p.grounded&&(rawY<p.y-90||Math.abs(dx)>520|| (!!destination&&p.y-destination.boardY>=60&&p.y-destination.boardY<=280));if(wantsArc){flipGuestTo(targetX,targetY);return;}clearGuestActionPlan(p);p.targetX=targetX;p.targetY=targetY;};
  useEffect(()=>{const isTyping=(target:EventTarget|null)=>target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement;const down=(e:KeyboardEvent)=>{if(mode!=="guest"||isTyping(e.target))return;const p=physics.current;if((p?.frozenUntil&&Date.now()<p.frozenUntil)||chokeStates.current.get(guestId)?.phase==="hold")return;const key=e.key.toLowerCase();guestHeldKeys.current.add(key);if(key==="e")emote();if(key==="v")setHostCam(v=>!v);if(key==="h"){const next=!signActiveRef.current;signActiveRef.current=next;setSignActive(next);void refreshGuestPresence(next);}if(key==="d"&&p&&GUEST_VERB_SET.has("dance"))startGuestStationaryAction(p,"dance");if(key==="p"&&p&&GUEST_VERB_SET.has("pullUps"))startGuestStationaryAction(p,"pullUps");if(key==="m"&&p&&GUEST_VERB_SET.has("mirrorCheck")){startGuestStationaryAction(p,"mirrorCheck");p.physique=p.physique==="jacked"?"slim":"jacked";void refreshGuestPresence();}if(key==="t"&&p&&GUEST_VERB_SET.has("sitAndWatch"))startGuestStationaryAction(p,"sitAndWatch");};const up=(e:KeyboardEvent)=>{guestHeldKeys.current.delete(e.key.toLowerCase());};addEventListener("keydown",down);addEventListener("keyup",up);return()=>{removeEventListener("keydown",down);removeEventListener("keyup",up);guestHeldKeys.current.clear();};},[mode]);
  useEffect(()=>{if(signOpen)requestAnimationFrame(clearSignCanvas);},[signOpen]);
  const signPoint=(e:React.PointerEvent<HTMLCanvasElement>)=>{const rect=e.currentTarget.getBoundingClientRect();return{x:(e.clientX-rect.left)*(e.currentTarget.width/rect.width),y:(e.clientY-rect.top)*(e.currentTarget.height/rect.height)};};
  const drawSignStroke=(e:React.PointerEvent<HTMLCanvasElement>,start=false)=>{const c=e.currentTarget,ctx=c.getContext("2d"),p=signPoint(e);if(!ctx)return;if(start){signDrawingRef.current=true;c.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(p.x,p.y);return;}if(!signDrawingRef.current)return;ctx.lineCap="round";ctx.lineJoin="round";ctx.lineWidth=signErase?18:5;ctx.strokeStyle=signErase?"#fffdf4":signColor;ctx.lineTo(p.x,p.y);ctx.stroke();};
  const signModal=signOpen?<div style={{position:"fixed",inset:0,zIndex:30,background:"rgba(0,0,0,.38)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace"}}><section style={{...card,width:360}}><h3 style={{marginTop:0}}>Make a sign</h3><canvas ref={signCanvasRef} width={300} height={200} onPointerDown={e=>drawSignStroke(e,true)} onPointerMove={drawSignStroke} onPointerUp={e=>{signDrawingRef.current=false;e.currentTarget.releasePointerCapture(e.pointerId);}} style={{width:"100%",height:220,border:"2px solid #2a2a2a",background:"#fffdf4",touchAction:"none",cursor:signErase?"cell":"crosshair"}}/><input maxLength={40} value={signText} onChange={e=>setSignText(e.target.value)} placeholder="Optional sign text" style={input}/><div style={{display:"flex",gap:6,marginTop:8}}>{["#27221f","#d82727","#285ca8","#2f8a3c"].map(c=><button key={c} onClick={()=>{setSignColor(c);setSignErase(false);}} style={{...button,marginTop:0,width:42,height:34,background:c,color:c}}>{c===signColor&&!signErase?"✓":""}</button>)}<button style={{...button,marginTop:0,width:80}} onClick={()=>setSignErase(v=>!v)}>{signErase?"Pen":"Eraser"}</button></div><button style={{...button,background:"#c8f135"}} onClick={()=>void bakeSign()}>Confirm</button><button style={button} onClick={()=>setSignOpen(false)}>Cancel</button></section></div>:null;

  if(mode==="join")return <main style={landing}><section style={card}><h2>Join as character</h2><input autoFocus maxLength={GUEST_NAME_MAX_LENGTH} value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={input}/><label style={{...button,display:"block",textAlign:"center",marginTop:10}}>Optional face<input hidden type="file" accept="image/*" onChange={async e=>{const f=e.target.files?.[0];if(f)setFace(await bakeFace(f));}}/></label>{face&&<img src={face} alt="Face preview" style={{width:48,height:56,display:"block",margin:"10px auto"}}/>}<p style={{fontSize:10,color:"#8b2b20"}}>{joinError}</p><button style={{...button,background:"#c8f135"}} onClick={beginGuest}>Spawn</button><button style={button} onClick={()=>setMode("landing")}>Cancel</button></section></main>;
  if(mode==="landing")return <main style={landing}><section style={card}><div style={{fontSize:11,color:live?"#228b22":"#8a6a00",fontWeight:700}}>{live?"LIVE":status==="ended"?"STREAM ENDED":status==="reconnecting"?"RECONNECTING":"OFFLINE"}</div><h1>{STREAM_OWNER_NAME}</h1><p>{live?"Choose how to enter the live board.":status==="reconnecting"?"reconnecting…":joinError||"No active stream right now."}</p><button disabled={!live||!snapshot} style={button} onClick={()=>setMode("watch")}>Watch</button><button disabled={!live||!snapshot} style={{...button,background:live?"#c8f135":"#ddd"}} onClick={()=>setMode("join")}>Join as character ({participants.filter(p=>p.role==="guest").length}/{MAX_GUESTS})</button></section></main>;
  const choose=(fn:()=>void)=>{fn();dismissWheel();};
  const toggleSign=()=>{if(!signDataUrlRef.current){setSignOpen(true);return;}const next=!signActiveRef.current;signActiveRef.current=next;setSignActive(next);void refreshGuestPresence(next);};
  const wheelItems=mode==="guest"?[
    {label:"Emote",icon:"☺",onSelect:()=>choose(emote)},
    {label:signActive?"Lower sign":"Sign",icon:"▱",onSelect:()=>choose(toggleSign)},
    {label:"Camera",icon:"◉",onSelect:()=>choose(()=>setHostCam(v=>!v))},
    {label:guestBazookaArmed?"Stow bazooka":"Bazooka",icon:"◁",onSelect:()=>choose(()=>{const next=!guestBazookaArmedRef.current;guestBazookaArmedRef.current=next;setGuestBazookaArmed(next);})},
    {label:"Menu",icon:"☰",onSelect:()=>setWheelMenuOpen(true)},
  ]:[{label:"Menu",icon:"☰",onSelect:()=>setWheelMenuOpen(true)}];
  const menuItems=[
    {label:nativeFullscreen||maximize?"Exit fullscreen":"Fullscreen",icon:"⛶",onSelect:()=>choose(()=>void toggleFullscreen())},
    ...(DEBUG_STREAM?[{label:"Debug",icon:"⌁",onSelect:()=>choose(()=>setDebugOpen(v=>!v))}]:[]),
    {label:"Leave",icon:"←",onSelect:()=>choose(()=>void leave())},
  ];
  return (
    <main ref={containerRef} style={{ position: "fixed", inset: 0, zIndex:maximize?2147483000:undefined, overflow: "hidden", background: "#f5ecd8" }}>
      <canvas ref={canvasRef} onClick={clickCanvas} onPointerMove={e=>{if(mode!=="guest"||hostCam)return;const rect=e.currentTarget.getBoundingClientRect(),sf=camera.current.boardZoom*rect.width/BOARD_W;guestBazookaAimRef.current={x:(e.clientX-rect.left-rect.width/2)/sf+camera.current.cameraX,y:(e.clientY-rect.top-rect.height/2)/sf+camera.current.cameraY};}} style={{ width: "100vw", height: "100vh", display: "block", cursor: mode === "guest" && !hostCam ? "crosshair" : "default" }} />
      {!maximize&&<div style={{position:"fixed",top:"max(12px, env(safe-area-inset-top))",left:"max(12px, env(safe-area-inset-left))",display:"flex",gap:8,fontFamily:"monospace"}}><span style={pill}>{mode==="guest"?name:`LIVE · ${STREAM_OWNER_NAME}`}</span><button type="button" aria-label="Fullscreen" style={{...pill,cursor:"pointer"}} onClick={()=>void toggleFullscreen()}>⛶</button></div>}
      {maximize?<button type="button" onClick={()=>void exitFullscreen()} style={{...pill,position:"fixed",top:10,right:10}}>✕</button>:<button type="button" aria-label="Open action wheel" onClick={()=>setWheelOpen(true)} style={wheelTriggerStyle}>✦</button>}
      <ActionWheel open={wheelOpen&&!maximize} items={wheelItems} onDismiss={dismissWheel} menuOpen={wheelMenuOpen} menuItems={menuItems}/>
      {DEBUG_STREAM&&debugOpen&&<aside data-stream-debug-overlay style={{position:"fixed",left:12,bottom:12,zIndex:10040,width:"min(760px, calc(100vw - 24px))",maxHeight:"40vh",overflowY:"auto",padding:10,border:"2px solid #2a2a2a",background:"rgba(255,253,245,.96)",fontFamily:"monospace",fontSize:10}}><button onClick={()=>setDebugOpen(false)} style={{float:"right",border:0,background:"transparent"}}>✕</button>renderer: {RENDERER_VERSION} · guest skin: {guestSkinLabel}{renderDebugRows.map(row=><div key={`${row.isHost?"h":"g"}-${row.id}`}>{row.id} {row.isHost?"host":"guest"} pub:{row.skinPublished??"∅"} res:{row.skinResolved} act:{row.actionType}@{row.actionProgress.toFixed(2)}</div>)}</aside>}
      {signModal}
    </main>
  );
}

const landing:React.CSSProperties={minHeight:"100vh",background:"#f5ecd8",color:"#2a2a2a",fontFamily:"monospace",display:"flex",alignItems:"center",justifyContent:"center",padding:24};
const card:React.CSSProperties={width:390,maxWidth:"100%",border:"2px solid #2a2a2a",background:"#fffdf5",boxShadow:"4px 4px 0 #2a2a2a",padding:18};
const button:React.CSSProperties={width:"100%",padding:"10px 12px",marginTop:8,border:"2px solid #2a2a2a",background:"#fffdf5",fontFamily:"monospace",fontWeight:700,cursor:"pointer"};
const input:React.CSSProperties={...button,boxSizing:"border-box"};
const pill:React.CSSProperties={background:"rgba(255,253,245,.92)",border:"1.5px solid #2a2a2a",boxShadow:"2px 2px 0 #2a2a2a",padding:"7px 9px",fontSize:11,fontWeight:700,pointerEvents:"auto"};
