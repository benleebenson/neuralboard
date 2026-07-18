"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { DEBUG_STREAM, STREAM_OWNER_NAME, STREAM_OWNER_USER_ID } from "@/app/board2/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { RENDERER_VERSION, drawEliminationSequence, drawSharedStreamCharacter, drawTommyGunHeld, drawWeaponProjectile, eliminationFrameForGuest, guestCharacterForRender, hostCharacterForRender } from "@/lib/play-character-renderer";
import { GUEST_EMOTES, GUEST_NAME_MAX_LENGTH, GUEST_VERBS, GuestCharacterFrame, MAX_GUESTS, MAX_GUEST_SIGN_DATA_URL_BYTES, STREAM_FPS, StreamAnnotation, StreamCamera, StreamCharacterDebugRow, StreamChokeMessage, StreamEliminationMessage, StreamFrameMessage, StreamKickMessage, StreamParticipantPresence, StreamShotFiredMessage, StreamSnapshotMessage, StreamWeaponHitMessage, StreamWeaponStateMessage, resolveStreamSkin, streamChannelName } from "@/lib/stream";

type Mode = "landing" | "watch" | "join" | "guest";
type GuestPhysics = { x: number; y: number; vx: number; vy: number; targetX: number | null; targetY: number | null; facing: 1 | -1; grounded: boolean; surfaceId: string | null; action: GuestCharacterFrame["actionType"]; actionStarted: number; emote?: string; spawnAt: number; frozenUntil?: number; eliminatedBy?: string; physique: "slim" | "jacked" };
const BOARD_W = 4000;
const GUEST_RESPAWN_BELOW_LOWEST_SURFACE = 650;
const GUEST_VERB_SET = new Set<string>(GUEST_VERBS);
const GUEST_DEFAULT_SKIN: "stick" | "styled" = "stick";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
type StreamSurface = StreamSnapshotMessage["clips"][number];

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

function guestActionDuration(action: GuestCharacterFrame["actionType"]): number {
  if (action === "flip") return 0.95;
  if (action === "jump") return 1.1;
  if (action === "grapple" || action === "zipline") return 1.3;
  if (action === "skateTo" || action === "wallClimb") return 1.5;
  if (action === "dance") return 2.5;
  if (action === "pullUps") return 2.6;
  if (action === "mirrorCheck") return 1.6;
  if (action === "sitAndWatch") return 3.0;
  if (action === "forceChoke") return 1.4;
  if (action === "emote") return 1.5;
  if (action === "eliminated") return 3.2;
  return action === "run" ? 0.75 : action === "walk" ? 0.9 : 2;
}

function guestFrameFromPhysics(p: GuestPhysics, guestId: string, name: string, sessionId: string, now: number, skin: "stick" | "styled", signDataUrl?: string, signActive = false): GuestCharacterFrame {
  const sentAt = Date.now();
  const duration = guestActionDuration(p.action);
  const progress = clamp((now - p.actionStarted) / Math.max(1, duration * 1000), 0, 1.4);
  return {
    kind: "guest-state",
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
    skin,
    physique: p.physique,
    signDataUrl,
    signActive: !!signDataUrl && signActive,
    emote: p.emote,
  };
}

function hostDebugRow(ch: StreamFrameMessage["characters"][number]): StreamCharacterDebugRow {
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
  };
}

function guestDebugRow(frame: GuestCharacterFrame, guestSkinOverride?: "stick" | "styled"): StreamCharacterDebugRow {
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
  };
}

export default function StreamPage() {
  const canvasRef=useRef<HTMLCanvasElement>(null), signCanvasRef=useRef<HTMLCanvasElement>(null), channelRef=useRef<RealtimeChannel|null>(null), imageCache=useRef(new Map<string,HTMLImageElement>()), faceCache=useRef(new Map<string,HTMLImageElement>()), signCache=useRef(new Map<string,HTMLImageElement>());
  const latestHost=useRef<StreamFrameMessage|null>(null), hostPresent=useRef(false), snapshotRef=useRef<StreamSnapshotMessage|null>(null), snapshotRequestedAt=useRef(0), lastDebugFrameAt=useRef(0), imageRetried=useRef(new Set<string>()), reconnectAttempt=useRef(0), remoteGuests=useRef(new Map<string,GuestCharacterFrame>()), renderedGuests=useRef(new Map<string,GuestCharacterFrame>()), remoteClockOffsets=useRef(new Map<string,number>()), hostClockOffset=useRef(0), hostGuestSkin=useRef<"stick"|"styled">(GUEST_DEFAULT_SKIN), eliminations=useRef(new Map<string,StreamEliminationMessage>()), chokeStates=useRef(new Map<string,StreamChokeMessage>()), weaponState=useRef<StreamWeaponStateMessage|null>(null), weaponShots=useRef<StreamShotFiredMessage[]>([]), weaponHits=useRef(new Map<string,StreamWeaponHitMessage>()), physics=useRef<GuestPhysics|null>(null), camera=useRef<StreamCamera>({cameraX:2000,cameraY:1500,boardZoom:1}), publishAt=useRef(0), emoteIndex=useRef(0), guestHeldKeys=useRef(new Set<string>());
  const signDataUrlRef=useRef<string|undefined>(undefined), signActiveRef=useRef(false), signDrawingRef=useRef(false);
  const [snapshot,setSnapshot]=useState<StreamSnapshotMessage|null>(null),[live,setLive]=useState(false),[mode,setMode]=useState<Mode>("landing"),[status,setStatus]=useState("connecting"),[subscribeStatus,setSubscribeStatus]=useState("PENDING"),[participants,setParticipants]=useState<StreamParticipantPresence[]>([]),[name,setName]=useState(""),[face,setFace]=useState<string>(),[joinError,setJoinError]=useState(""),[hostCam,setHostCam]=useState(false),[signOpen,setSignOpen]=useState(false),[signText,setSignText]=useState(""),[signColor,setSignColor]=useState("#27221f"),[signErase,setSignErase]=useState(false),[signActive,setSignActive]=useState(false),[guestSkinLabel,setGuestSkinLabel]=useState<"stick"|"styled">(GUEST_DEFAULT_SKIN);
  const guestId=`guest-${useId().replace(/:/g,"-")}`, nameRef=useRef("");
  const renderDebugRowsRef=useRef<StreamCharacterDebugRow[]>([]), renderDebugOverlayAt=useRef(0);
  const [renderDebugRows,setRenderDebugRows]=useState<StreamCharacterDebugRow[]>([]);
  const loadSnapshot=useCallback(async()=>{try{const res=await fetch(`/api/stream/snapshot?streamId=${encodeURIComponent(STREAM_OWNER_USER_ID)}`,{cache:"no-store"});const data=await res.json();streamDebugLog("snapshot endpoint",{status:res.status,live:!!data.live,hasSnapshot:!!data.snapshot,updatedAt:data.updatedAt});if(data.live&&data.snapshot){snapshotRef.current=data.snapshot;setLive(true);setSnapshot(data.snapshot);setStatus("live");}else if(!latestHost.current&&!hostPresent.current){setLive(false);setStatus("offline");}}catch(error){streamDebugLog("snapshot endpoint failed",error);if(!latestHost.current&&!hostPresent.current)setStatus("reconnecting");}},[]);
  const cacheSignImage=(id:string,dataUrl?:string)=>{if(!validSignDataUrl(dataUrl))return;const current=signCache.current.get(id);if(current?.src===dataUrl)return;const img=new Image();img.src=dataUrl;signCache.current.set(id,img);};
  const refreshGuestPresence=async(active=signActiveRef.current,dataUrl=signDataUrlRef.current)=>{if(mode!=="guest")return;const presence={role:"guest",isHost:false,guestId,name:nameRef.current,faceDataUrl:face,skin:hostGuestSkin.current,physique:physics.current?.physique??"slim",signDataUrl:validSignDataUrl(dataUrl)?dataUrl:undefined,signActive:!!dataUrl&&active,joinedAt:Date.now()} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channelRef.current?.track(presence);};
  const clearSignCanvas=()=>{const c=signCanvasRef.current,ctx=c?.getContext("2d");if(!c||!ctx)return;ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle="#fffdf4";ctx.fillRect(0,0,c.width,c.height);};
  const bakeSign=async()=>{const source=signCanvasRef.current;if(!source)return;const out=document.createElement("canvas");out.width=256;out.height=171;const ctx=out.getContext("2d")!;ctx.fillStyle="#fffdf4";ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(source,0,0,out.width,out.height);const text=signText.trim().slice(0,40);if(text){ctx.fillStyle=signColor;ctx.font="700 27px Caveat, cursive, monospace";ctx.textAlign="center";ctx.textBaseline="middle";const words=text.split(/\s+/),lines:string[]=[];let line="";for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>218&&line){lines.push(line);line=word;}else line=test;}if(line)lines.push(line);const start=out.height/2-(lines.length-1)*17;lines.slice(0,4).forEach((ln,i)=>ctx.fillText(ln,out.width/2,start+i*34));}const dataUrl=out.toDataURL("image/png");if(dataUrl.length>MAX_GUEST_SIGN_DATA_URL_BYTES){setJoinError("That sign is too large. Try fewer strokes.");return;}signDataUrlRef.current=dataUrl;signActiveRef.current=true;setSignActive(true);cacheSignImage(guestId,dataUrl);setSignOpen(false);await refreshGuestPresence(true,dataUrl);};

  useEffect(()=>{const initial=window.setTimeout(()=>void loadSnapshot(),0);const supabase=getBrowserSupabase();const channelName=streamChannelName(STREAM_OWNER_USER_ID);if(!supabase){streamDebugLog("realtime not configured",{channel:channelName});window.setTimeout(()=>setStatus("realtime-not-configured"),0);return()=>window.clearTimeout(initial);}const key=`client-${guestId}`;streamDebugLog("join channel",{channel:channelName,key});const channel=supabase.channel(channelName,{config:{broadcast:{self:false},presence:{key}}});channelRef.current=channel;
    const requestSnapshot=()=>{const now=Date.now();if(now-snapshotRequestedAt.current<1000)return;snapshotRequestedAt.current=now;streamDebugLog("snapshot request",{channel:channelName,requestedAt:now});void channel.send({type:"broadcast",event:"snapshot-request",payload:{streamId:STREAM_OWNER_USER_ID,sentAt:now}});};
    channel.on("broadcast",{event:"snapshot"},({payload})=>{streamDebugLog("snapshot broadcast",{sessionId:(payload as StreamSnapshotMessage).sessionId,clips:(payload as StreamSnapshotMessage).clips?.length});snapshotRef.current=payload as StreamSnapshotMessage;setSnapshot(snapshotRef.current);setLive(true);setStatus("live");})
      .on("broadcast",{event:"frame"},({payload})=>{const frame=payload as StreamFrameMessage;if(frame.guestSkin){hostGuestSkin.current=frame.guestSkin;setGuestSkinLabel(frame.guestSkin);}const measured=Date.now()-frame.sentAt;hostClockOffset.current=hostClockOffset.current?hostClockOffset.current*.88+measured*.12:measured;if(DEBUG_STREAM&&Date.now()-lastDebugFrameAt.current>2000){lastDebugFrameAt.current=Date.now();streamDebugLog("frame broadcast",{sentAt:frame.sentAt,clockOffset:Math.round(hostClockOffset.current),renderer:RENDERER_VERSION,guestSkin:hostGuestSkin.current,characters:frame.characters?.filter(ch=>ch.enabled).map(ch=>ch.id)});}latestHost.current=frame;setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();})
      .on("broadcast",{event:"guest-state"},({payload})=>{const f=payload as GuestCharacterFrame;if(f.sessionId===latestHost.current?.sessionId||!latestHost.current){if(validSignDataUrl(f.signDataUrl))cacheSignImage(f.guestId,f.signDataUrl);const measured=Date.now()-f.sentAt;const prev=remoteClockOffsets.current.get(f.guestId)??measured;remoteClockOffsets.current.set(f.guestId,prev*.85+measured*.15);remoteGuests.current.set(f.guestId,{...f,receivedAt:Date.now()});}})
      .on("broadcast",{event:"elimination"},({payload})=>{const event=payload as StreamEliminationMessage;eliminations.current.set(event.targetGuestId,event);streamDebugLog("elimination received",{target:event.targetGuestId,start:event.startTime,duration:event.duration});const p=physics.current;if(event.targetGuestId===guestId&&p){p.action="eliminated";p.actionStarted=performance.now();p.frozenUntil=event.startTime+event.duration*1000+250;p.eliminatedBy=event.hostName;p.targetX=null;p.targetY=null;p.vx=0;p.vy=0;}})
      .on("broadcast",{event:"weapon_state"},({payload})=>{weaponState.current=payload as StreamWeaponStateMessage;streamDebugLog("weapon_state received",{armed:weaponState.current.armed,skin:latestHost.current?.characters?.[0]?.skin});})
      .on("broadcast",{event:"shot_fired"},({payload})=>{streamDebugLog("shot_fired received",(payload as StreamShotFiredMessage).shotId);weaponShots.current=[...weaponShots.current,payload as StreamShotFiredMessage].slice(-80);})
      .on("broadcast",{event:"hit"},({payload})=>{const hit=payload as StreamWeaponHitMessage;weaponHits.current.set(hit.guestId,hit);if(hit.guestId===guestId&&physics.current){physics.current.vx+=hit.dir.x*140;physics.current.vy-=120;physics.current.action="jump";physics.current.actionStarted=performance.now();}})
      .on("broadcast",{event:"choke_state"},({payload})=>{const msg=payload as StreamChokeMessage;if(msg.phase==="end")chokeStates.current.delete(msg.targetGuestId);else chokeStates.current.set(msg.targetGuestId,msg);const p=physics.current;if(msg.targetGuestId===guestId&&p){if(msg.phase==="hold"){p.x=msg.position.x;p.y=msg.position.y;p.vx=0;p.vy=0;p.targetX=null;p.targetY=null;p.grounded=false;p.action="forceChoke";p.actionStarted=performance.now();}else if(msg.phase==="drop"){p.x=msg.position.x;p.y=msg.position.y;p.vx=0;p.vy=420;p.grounded=false;p.action="jump";p.actionStarted=performance.now();}}})
      .on("broadcast",{event:"remove-sign"},({payload})=>{const msg=payload as {guestId?:string};if(msg.guestId===guestId){signDataUrlRef.current=undefined;signActiveRef.current=false;setSignActive(false);signCache.current.delete(guestId);void refreshGuestPresence(false,undefined);}})
      .on("broadcast",{event:"kick"},({payload})=>{const kick=payload as StreamKickMessage;if(kick.guestId===guestId){eliminations.current.delete(guestId);chokeStates.current.delete(guestId);remoteGuests.current.delete(guestId);renderedGuests.current.delete(guestId);signDataUrlRef.current=undefined;signActiveRef.current=false;setSignActive(false);signCache.current.delete(guestId);channel.untrack();physics.current=null;setMode("landing");setJoinError(kick.reason==="elimination_tommygun"?`💥 KICKED by ${kick.hostName||"Host"}`:"You were removed by the host.");}})
      .on("broadcast",{event:"session-end"},()=>{streamDebugLog("session end");hostPresent.current=false;latestHost.current=null;snapshotRef.current=null;setSnapshot(null);setLive(false);setStatus("ended");physics.current=null;setMode("landing");})
      .on("presence",{event:"sync"},()=>{const rows=Object.values(channel.presenceState()).flat() as unknown as StreamParticipantPresence[];streamDebugLog("presence sync",rows);const hostRow=rows.find(p=>p.role==="host");if(hostRow?.guestSkin){hostGuestSkin.current=hostRow.guestSkin;setGuestSkinLabel(hostRow.guestSkin);}hostPresent.current=rows.some(p=>p.role==="host");setParticipants(rows);if(hostPresent.current){setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();}for(const p of rows){if(p.guestId){const stale=eliminations.current.get(p.guestId);if(stale&&p.joinedAt>stale.sentAt){streamDebugLog("clear stale elimination on rejoin",{guestId:p.guestId,joinedAt:p.joinedAt,eliminationSentAt:stale.sentAt});eliminations.current.delete(p.guestId);remoteGuests.current.delete(p.guestId);renderedGuests.current.delete(p.guestId);}if(p.faceDataUrl&&!faceCache.current.has(p.guestId)){const img=new Image();img.src=p.faceDataUrl;faceCache.current.set(p.guestId,img);}if(validSignDataUrl(p.signDataUrl))cacheSignImage(p.guestId,p.signDataUrl);}}})
      .subscribe(async s=>{setSubscribeStatus(s);streamDebugLog("subscribe status",s);if(s==="SUBSCRIBED"){reconnectAttempt.current=0;const presence={role:"viewer",isHost:false,joinedAt:Date.now()} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channel.track(presence);requestSnapshot();window.setTimeout(()=>{if(!snapshotRef.current)requestSnapshot();},1200);void loadSnapshot();}else if(s==="CHANNEL_ERROR"||s==="TIMED_OUT"||s==="CLOSED"){setStatus("reconnecting");const delay=Math.min(8000,1000*2**reconnectAttempt.current++);window.setTimeout(()=>{streamDebugLog("reconnect retry",{delay});void loadSnapshot();requestSnapshot();},delay);}});return()=>{window.clearTimeout(initial);hostPresent.current=false;supabase.removeChannel(channel);channelRef.current=null;};},[guestId,loadSnapshot]);

  useEffect(()=>{if(!snapshot)return;const load=(cache:Map<string,HTMLImageElement>,url:string)=>{if(!url||cache.has(url))return;const img=new Image();img.crossOrigin="anonymous";img.onerror=()=>streamDebugLog("image load failed",{url:url.slice(0,48)});img.src=url;cache.set(url,img);};for(const clip of snapshot.clips){const url=clip.type==="video"?(clip.thumbnailUrl||clip.sourceUrl):clip.sourceUrl;load(imageCache.current,url);}for(const ch of snapshot.characters)if(ch.faceDataUrl&&!faceCache.current.has(ch.id)){const img=new Image();img.src=ch.faceDataUrl;faceCache.current.set(ch.id,img);}},[snapshot]);

  const beginGuest=async()=>{const safe=cleanName(name);if(!safe){setJoinError("Enter a short, appropriate name.");return;}const guests=participants.filter(p=>p.role==="guest");if(guests.length>=MAX_GUESTS){setJoinError("This room is full.");return;}if(!snapshot)return;nameRef.current=safe;if(face&&!faceCache.current.has(guestId)){const img=new Image();img.src=face;faceCache.current.set(guestId,img);}if(signDataUrlRef.current)cacheSignImage(guestId,signDataUrlRef.current);const spawn=resolveGuestSpawn(snapshot);physics.current={x:spawn.x,y:spawn.y,vx:0,vy:0,targetX:null,targetY:null,facing:1,grounded:spawn.grounded,surfaceId:spawn.surfaceId,action:"idle",actionStarted:performance.now(),spawnAt:performance.now(),physique:"slim"};camera.current={cameraX:spawn.x,cameraY:spawn.y-120,boardZoom:1.35};const joinedAt=Date.now();const presence={role:"guest",isHost:false,guestId,name:safe,faceDataUrl:face,skin:hostGuestSkin.current,physique:"slim",signDataUrl:validSignDataUrl(signDataUrlRef.current)?signDataUrlRef.current:undefined,signActive:!!signDataUrlRef.current&&signActiveRef.current,joinedAt} satisfies StreamParticipantPresence;streamDebugLog("presence track send",presence);await channelRef.current?.track(presence);setMode("guest");setJoinError("");};
  const emote=()=>{const p=physics.current;if(!p||!GUEST_VERB_SET.has("emote"))return;p.emote=GUEST_EMOTES[emoteIndex.current++%GUEST_EMOTES.length];p.action="emote";p.actionStarted=performance.now();};
  const flipGuestTo=(targetX?:number,targetY?:number)=>{const p=physics.current;if(!p||!p.grounded)return;const dx=targetX!==undefined?targetX-p.x:p.facing*520;p.facing=dx>=0?1:-1;p.vx=clamp(Math.abs(dx)*1.35,420,760)*p.facing;p.vy=-clamp(targetY!==undefined?680+Math.max(0,p.y-targetY)*.55:760,700,900);p.grounded=false;p.surfaceId=null;p.targetX=targetX??p.x+p.facing*520;p.targetY=targetY??p.y;p.action="flip";p.actionStarted=performance.now();};
  const guestTargetVerb=(): GuestCharacterFrame["actionType"]|null=>{const keys=guestHeldKeys.current;if(keys.has("g"))return"grapple";if(keys.has("s"))return"skateTo";if(keys.has("c"))return"wallClimb";if(keys.has("z"))return"zipline";return null;};
  const issueGuestTargetVerb=(action:GuestCharacterFrame["actionType"],targetX:number,targetY:number)=>{const p=physics.current;if(!p)return;const dx=targetX-p.x;const height=Math.max(0,p.y-targetY);p.facing=dx>=0?1:-1;p.targetX=null;p.targetY=null;p.action=action;p.actionStarted=performance.now();p.vx=clamp(Math.abs(dx)*1.2,360,780)*p.facing;p.vy=action==="grapple"||action==="zipline"?-clamp(620+height*.35,620,860):action==="wallClimb"?-clamp(520+height*.3,520,760):action==="skateTo"?-360:p.vy;p.grounded=false;p.surfaceId=null;};
  const leave=async()=>{await channelRef.current?.track({role:"viewer",joinedAt:Date.now()} satisfies StreamParticipantPresence);physics.current=null;setMode("landing");};

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
          }
          const target = p.targetX;
          const frozen = (p.frozenUntil !== undefined && Date.now() < p.frozenUntil) || held?.phase === "hold";
          if (p.action === "emote" && now - p.actionStarted > 1500) {
            p.action = "idle";
            p.emote = undefined;
          }
          if (p.action === "dance" && now - p.actionStarted > 2500) p.action = "idle";
          if (["pullUps","mirrorCheck","sitAndWatch","grapple","skateTo","wallClimb","zipline"].includes(p.action) && now - p.actionStarted > guestActionDuration(p.action) * 1000) p.action = "idle";
          if (p.action === "flip" && now - p.actionStarted > 950 && p.grounded) p.action = "idle";
          if (target !== null && !frozen) {
            const dx = target - p.x;
            if (Math.abs(dx) < 14) {
              p.vx = 0;
              p.targetX = null;
              if (p.grounded) p.action = "idle";
            } else {
              p.facing = dx > 0 ? 1 : -1;
              p.vx = p.facing * (Math.abs(dx) > 280 ? 620 : 330);
              if (p.grounded) p.action = Math.abs(dx) > 280 ? "run" : "walk";
            }
          } else if (frozen) {
            p.vx = 0;
            p.targetX = null;
          }
          if (held?.phase !== "hold") {
            if (p.grounded) {
              const support = surfaces.find((s) => s.id === p.surfaceId);
              if (!support || p.x < support.boardX || p.x > support.boardX + support.boardW) {
                p.grounded = false;
                p.surfaceId = null;
                p.vy = 30;
              }
            }
            p.x += p.vx * dt;
            if (!p.grounded) {
              const previousY = p.y;
              p.vy = Math.min(1200, p.vy + 1850 * dt);
              const nextY = p.y + p.vy * dt;
              const landing = surfaces
                .filter((s) => p.x >= s.boardX + 10 && p.x <= s.boardX + s.boardW - 10 && previousY <= s.boardY && nextY >= s.boardY)
                .sort((a, b) => a.boardY - b.boardY)[0];
              if (landing) {
                p.y = landing.boardY;
                p.vy = 0;
                p.grounded = true;
                p.surfaceId = landing.id;
                p.action = p.targetX === null ? "idle" : p.action;
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
          const packet = guestFrameFromPhysics(p, guestId, nameRef.current, host.sessionId, now, hostGuestSkin.current, validSignDataUrl(signDataUrlRef.current) ? signDataUrlRef.current : undefined, signActiveRef.current);
          channelRef.current?.send({ type: "broadcast", event: "guest-state", payload: packet });
        }
        const cam = camera.current;
        const sf = cam.boardZoom * w / BOARD_W;
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
            if (!drawImageSafe(ctx, img, x, y, sw, sh)) {
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
          for (const ann of snapshot.annotations) drawAnnotation(ctx, ann, cam, sf, w, h);
          if (snapshot.spawnDoor) drawDoor(ctx, snapshot.spawnDoor.x, snapshot.spawnDoor.y, cam, sf, w, h, p ? clamp(1 - (now - p.spawnAt) / 900, 0, 1) : 0);
          if (host) {
            const rows: StreamCharacterDebugRow[] = [];
            for (const ch of host.characters) {
              if (!ch.enabled) continue;
              const faceInfo = snapshot.characters.find((x) => x.id === ch.id);
              rows.push(hostDebugRow(ch));
              drawSharedStreamCharacter(ctx, hostCharacterForRender(ch, faceInfo?.faceAspect, hostClockOffset.current), faceCache.current.get(ch.id) ?? null, null, cam, sf, w, h, 1, Date.now());
            }
            renderDebugRowsRef.current = rows;
          }
          if (weaponState.current?.armed) drawTommyGunHeld(ctx, weaponState.current.shooter, weaponState.current.aim, cam, sf, w, h, 0);
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
            renderDebugRowsRef.current = [...renderDebugRowsRef.current.filter((row) => row.id !== id), guestDebugRow(smooth, hostGuestSkin.current)];
            drawSharedStreamCharacter(ctx, guestCharacterForRender(smooth, remoteClockOffsets.current.get(id) ?? 0, { guestSkinOverride: hostGuestSkin.current }), faceCache.current.get(id) ?? null, signCache.current.get(id) ?? null, cam, sf, w, h, id === guestId ? clamp((now - (p?.spawnAt ?? 0)) / 650, 0, 1) : 1, Date.now());
          }
          if (p && mode === "guest") {
            const sessionId = host?.sessionId ?? latestHost.current?.sessionId ?? "local";
            const localFrame = guestFrameFromPhysics(p, guestId, nameRef.current, sessionId, now, hostGuestSkin.current, validSignDataUrl(signDataUrlRef.current) ? signDataUrlRef.current : undefined, signActiveRef.current);
            const event = eliminations.current.get(guestId);
            const choke = chokeStates.current.get(guestId);
            const renderFrame = choke?.phase === "hold"
              ? { ...localFrame, position: choke.position, velocity: { x: 0, y: -20 }, actionType: "forceChoke" as const, actionProgress: choke.progress, actionStartTime: choke.sentAt - choke.progress * 1400, actionDuration: 1.4 }
              : choke?.phase === "drop"
                ? { ...localFrame, position: choke.position, velocity: { x: 0, y: 540 }, actionType: "jump" as const, actionProgress: 0.85, actionStartTime: choke.sentAt - 900, actionDuration: 1.1 }
                : event ? eliminationFrameForGuest(localFrame, event, Date.now(), hostClockOffset.current) : localFrame;
            if (renderFrame) {
              renderDebugRowsRef.current = [...renderDebugRowsRef.current.filter((row) => row.id !== guestId), guestDebugRow(renderFrame, hostGuestSkin.current)];
              drawSharedStreamCharacter(ctx, guestCharacterForRender(renderFrame, 0, { guestSkinOverride: hostGuestSkin.current }), faceCache.current.get(guestId) ?? null, signCache.current.get(guestId) ?? null, cam, sf, w, h, clamp((now - p.spawnAt) / 650, 0, 1), Date.now());
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

  const clickCanvas=(e:React.MouseEvent<HTMLCanvasElement>)=>{const p=physics.current;if(!p||!snapshot||hostCam||(p.frozenUntil&&Date.now()<p.frozenUntil)||chokeStates.current.get(guestId)?.phase==="hold")return;const rect=e.currentTarget.getBoundingClientRect(),cam=camera.current,sf=cam.boardZoom*rect.width/BOARD_W,rawX=(e.clientX-rect.left-rect.width/2)/sf+cam.cameraX,rawY=(e.clientY-rect.top-rect.height/2)/sf+cam.cameraY;const surfaces=streamSurfaces(snapshot).filter(s=>rawX>=s.boardX&&rawX<=s.boardX+s.boardW);const destination=surfaces.sort((a,b)=>Math.abs(a.boardY-rawY)-Math.abs(b.boardY-rawY))[0];const targetX=destination?clamp(rawX,destination.boardX+18,destination.boardX+destination.boardW-18):clamp(rawX,0,snapshot.board.width);const targetY=destination?.boardY??p.y;const verb=guestTargetVerb();if(verb){issueGuestTargetVerb(verb,targetX,targetY);return;}const dx=targetX-p.x;const wantsArc=p.grounded&&(rawY<p.y-90||Math.abs(dx)>520|| (!!destination&&p.y-destination.boardY>=60&&p.y-destination.boardY<=280));if(wantsArc){flipGuestTo(targetX,targetY);return;}p.targetX=targetX;p.targetY=targetY;};
  useEffect(()=>{const isTyping=(target:EventTarget|null)=>target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement;const down=(e:KeyboardEvent)=>{if(mode!=="guest"||isTyping(e.target))return;const p=physics.current;if((p?.frozenUntil&&Date.now()<p.frozenUntil)||chokeStates.current.get(guestId)?.phase==="hold")return;const key=e.key.toLowerCase();guestHeldKeys.current.add(key);if(key==="e")emote();if(key==="v")setHostCam(v=>!v);if(key==="h"){const next=!signActiveRef.current;signActiveRef.current=next;setSignActive(next);void refreshGuestPresence(next);}if(key==="d"&&p&&GUEST_VERB_SET.has("dance")){p.action="dance";p.actionStarted=performance.now();p.vx=0;p.targetX=null;}if(key==="p"&&p&&GUEST_VERB_SET.has("pullUps")){p.action="pullUps";p.actionStarted=performance.now();p.vx=0;p.targetX=null;}if(key==="m"&&p&&GUEST_VERB_SET.has("mirrorCheck")){p.action="mirrorCheck";p.actionStarted=performance.now();p.vx=0;p.targetX=null;p.physique=p.physique==="jacked"?"slim":"jacked";void refreshGuestPresence();}if(key==="t"&&p&&GUEST_VERB_SET.has("sitAndWatch")){p.action="sitAndWatch";p.actionStarted=performance.now();p.vx=0;p.targetX=null;}};const up=(e:KeyboardEvent)=>{guestHeldKeys.current.delete(e.key.toLowerCase());};addEventListener("keydown",down);addEventListener("keyup",up);return()=>{removeEventListener("keydown",down);removeEventListener("keyup",up);guestHeldKeys.current.clear();};},[mode]);
  useEffect(()=>{if(signOpen)requestAnimationFrame(clearSignCanvas);},[signOpen]);
  const signPoint=(e:React.PointerEvent<HTMLCanvasElement>)=>{const rect=e.currentTarget.getBoundingClientRect();return{x:(e.clientX-rect.left)*(e.currentTarget.width/rect.width),y:(e.clientY-rect.top)*(e.currentTarget.height/rect.height)};};
  const drawSignStroke=(e:React.PointerEvent<HTMLCanvasElement>,start=false)=>{const c=e.currentTarget,ctx=c.getContext("2d"),p=signPoint(e);if(!ctx)return;if(start){signDrawingRef.current=true;c.setPointerCapture(e.pointerId);ctx.beginPath();ctx.moveTo(p.x,p.y);return;}if(!signDrawingRef.current)return;ctx.lineCap="round";ctx.lineJoin="round";ctx.lineWidth=signErase?18:5;ctx.strokeStyle=signErase?"#fffdf4":signColor;ctx.lineTo(p.x,p.y);ctx.stroke();};
  const signModal=signOpen?<div style={{position:"fixed",inset:0,zIndex:30,background:"rgba(0,0,0,.38)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace"}}><section style={{...card,width:360}}><h3 style={{marginTop:0}}>Make a sign</h3><canvas ref={signCanvasRef} width={300} height={200} onPointerDown={e=>drawSignStroke(e,true)} onPointerMove={drawSignStroke} onPointerUp={e=>{signDrawingRef.current=false;e.currentTarget.releasePointerCapture(e.pointerId);}} style={{width:"100%",height:220,border:"2px solid #2a2a2a",background:"#fffdf4",touchAction:"none",cursor:signErase?"cell":"crosshair"}}/><input maxLength={40} value={signText} onChange={e=>setSignText(e.target.value)} placeholder="Optional sign text" style={input}/><div style={{display:"flex",gap:6,marginTop:8}}>{["#27221f","#d82727","#285ca8","#2f8a3c"].map(c=><button key={c} onClick={()=>{setSignColor(c);setSignErase(false);}} style={{...button,marginTop:0,width:42,height:34,background:c,color:c}}>{c===signColor&&!signErase?"✓":""}</button>)}<button style={{...button,marginTop:0,width:80}} onClick={()=>setSignErase(v=>!v)}>{signErase?"Pen":"Eraser"}</button></div><button style={{...button,background:"#c8f135"}} onClick={()=>void bakeSign()}>Confirm</button><button style={button} onClick={()=>setSignOpen(false)}>Cancel</button></section></div>:null;

  if(mode==="join")return <main style={landing}><section style={card}><h2>Join as character</h2><input autoFocus maxLength={GUEST_NAME_MAX_LENGTH} value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={input}/><label style={{...button,display:"block",textAlign:"center",marginTop:10}}>Optional face<input hidden type="file" accept="image/*" onChange={async e=>{const f=e.target.files?.[0];if(f)setFace(await bakeFace(f));}}/></label>{face&&<img src={face} alt="Face preview" style={{width:48,height:56,display:"block",margin:"10px auto"}}/>}<p style={{fontSize:10,color:"#8b2b20"}}>{joinError}</p><button style={{...button,background:"#c8f135"}} onClick={beginGuest}>Spawn</button><button style={button} onClick={()=>setMode("landing")}>Cancel</button></section></main>;
  if(mode==="landing")return <main style={landing}><section style={card}><div style={{fontSize:11,color:live?"#228b22":"#8a6a00",fontWeight:700}}>{live?"LIVE":status==="ended"?"STREAM ENDED":status==="reconnecting"?"RECONNECTING":"OFFLINE"}</div><h1>{STREAM_OWNER_NAME}</h1><p>{live?"Choose how to enter the live board.":status==="reconnecting"?"reconnecting…":joinError||"No active stream right now."}</p>{DEBUG_STREAM&&<div style={{fontSize:10,lineHeight:1.45,color:"#6a6a6a",background:"#f5ecd8",border:"1px solid rgba(42,42,42,.22)",padding:7,marginBottom:10}}>channel: {streamChannelName(STREAM_OWNER_USER_ID)} | subscribe: {subscribeStatus} | presence: {participants.length}</div>}<button disabled={!live||!snapshot} style={button} onClick={()=>setMode("watch")}>Watch</button><button disabled={!live||!snapshot} style={{...button,background:live?"#c8f135":"#ddd"}} onClick={()=>setMode("join")}>Join as character ({participants.filter(p=>p.role==="guest").length}/{MAX_GUESTS})</button></section></main>;
  return <main style={{position:"fixed",inset:0,overflow:"hidden",background:"#f5ecd8"}}><canvas ref={canvasRef} onClick={clickCanvas} style={{width:"100vw",height:"100vh",display:"block",cursor:mode==="guest"&&!hostCam?"crosshair":"default"}}/><div style={{position:"fixed",top:12,left:12,display:"flex",gap:8,fontFamily:"monospace",alignItems:"flex-start",flexWrap:"wrap",maxWidth:"calc(100vw - 24px)"}}><span style={pill}>{mode==="guest"?name:`LIVE · ${STREAM_OWNER_NAME}`}</span>{DEBUG_STREAM&&<span style={{...pill,maxWidth:620,lineHeight:1.35}}>renderer: {RENDERER_VERSION} · guest skin: {guestSkinLabel}{renderDebugRows.map((row)=><span key={`${row.isHost?"h":"g"}-${row.id}`} style={{display:"block"}}>{row.id} {row.isHost?"host":"guest"} pub:{row.skinPublished??"∅"} res:{row.skinResolved} src:{row.skinSource} act:{row.actionType}@{row.actionProgress.toFixed(2)} phys:{row.physique}{row.travelDx!==undefined?` dx:${Math.round(row.travelDx)}`:""}{row.rotationDirection?` rot:${row.rotationDirection}`:""}</span>)}</span>}{mode==="guest"&&<><span style={pill}>Click move · long/high clicks auto-flip · G grapple · S skate · C climb · Z zip · D dance · P pull · M mirror · T sit · E emote · H sign</span><button style={pill} onClick={()=>setHostCam(v=>!v)}>{hostCam?"Host cam":"Follow me"} · V</button><button style={pill} onClick={emote}>Emote · E</button><button style={pill} onClick={()=>setSignOpen(true)}>✍️ Sign</button><button style={pill} onClick={()=>{const next=!signActiveRef.current;signActiveRef.current=next;setSignActive(next);void refreshGuestPresence(next);}}>{signActive?"Lower sign":"Hold sign"} · H</button><button style={pill} onClick={leave}>Leave</button></>}</div>{signModal}</main>;
}

const landing:React.CSSProperties={minHeight:"100vh",background:"#f5ecd8",color:"#2a2a2a",fontFamily:"monospace",display:"flex",alignItems:"center",justifyContent:"center",padding:24};
const card:React.CSSProperties={width:390,maxWidth:"100%",border:"2px solid #2a2a2a",background:"#fffdf5",boxShadow:"4px 4px 0 #2a2a2a",padding:18};
const button:React.CSSProperties={width:"100%",padding:"10px 12px",marginTop:8,border:"2px solid #2a2a2a",background:"#fffdf5",fontFamily:"monospace",fontWeight:700,cursor:"pointer"};
const input:React.CSSProperties={...button,boxSizing:"border-box"};
const pill:React.CSSProperties={background:"rgba(255,253,245,.92)",border:"1.5px solid #2a2a2a",boxShadow:"2px 2px 0 #2a2a2a",padding:"7px 9px",fontSize:11,fontWeight:700,pointerEvents:"auto"};
