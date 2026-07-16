"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { STREAM_OWNER_NAME, STREAM_OWNER_USER_ID } from "@/app/board2/config";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { drawSharedStreamCharacter, guestCharacterForRender, hostCharacterForRender } from "@/lib/stream-character-renderer";
import { GUEST_EMOTES, GUEST_NAME_MAX_LENGTH, GuestCharacterFrame, MAX_GUESTS, StreamAnnotation, StreamCamera, StreamCharacterFrame, StreamFrameMessage, StreamParticipantPresence, StreamSnapshotMessage, streamChannelName } from "@/lib/stream";

type Mode = "landing" | "watch" | "join" | "guest";
type GuestPhysics = { x: number; y: number; vx: number; vy: number; targetX: number | null; targetY: number | null; facing: 1 | -1; grounded: boolean; surfaceId: string | null; action: GuestCharacterFrame["actionType"]; actionStarted: number; emote?: string; spawnAt: number };
const BOARD_W = 4000, BOARD_H = 3000;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

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

export default function StreamPage() {
  const canvasRef=useRef<HTMLCanvasElement>(null), channelRef=useRef<RealtimeChannel|null>(null), imageCache=useRef(new Map<string,HTMLImageElement>()), faceCache=useRef(new Map<string,HTMLImageElement>());
  const latestHost=useRef<StreamFrameMessage|null>(null), hostPresent=useRef(false), snapshotRef=useRef<StreamSnapshotMessage|null>(null), snapshotRequestedAt=useRef(0), remoteGuests=useRef(new Map<string,GuestCharacterFrame>()), renderedGuests=useRef(new Map<string,GuestCharacterFrame>()), physics=useRef<GuestPhysics|null>(null), camera=useRef<StreamCamera>({cameraX:2000,cameraY:1500,boardZoom:1}), publishAt=useRef(0), emoteIndex=useRef(0);
  const [snapshot,setSnapshot]=useState<StreamSnapshotMessage|null>(null),[live,setLive]=useState(false),[mode,setMode]=useState<Mode>("landing"),[status,setStatus]=useState("connecting"),[participants,setParticipants]=useState<StreamParticipantPresence[]>([]),[name,setName]=useState(""),[face,setFace]=useState<string>(),[joinError,setJoinError]=useState(""),[hostCam,setHostCam]=useState(false);
  const guestId=`guest-${useId().replace(/:/g,"-")}`, nameRef=useRef("");
  const loadSnapshot=useCallback(async()=>{try{const res=await fetch(`/api/stream/snapshot?streamId=${encodeURIComponent(STREAM_OWNER_USER_ID)}`,{cache:"no-store"});const data=await res.json();if(data.live&&data.snapshot){snapshotRef.current=data.snapshot;setLive(true);setSnapshot(data.snapshot);setStatus("live");}else if(!latestHost.current&&!hostPresent.current){setLive(false);setStatus("offline");}}catch{if(!latestHost.current&&!hostPresent.current)setStatus("reconnecting");}},[]);

  useEffect(()=>{const initial=window.setTimeout(()=>void loadSnapshot(),0);const supabase=getBrowserSupabase();if(!supabase){window.setTimeout(()=>setStatus("realtime-not-configured"),0);return()=>window.clearTimeout(initial);}const key=`client-${guestId}`;const channel=supabase.channel(streamChannelName(STREAM_OWNER_USER_ID),{config:{broadcast:{self:false},presence:{key}}});channelRef.current=channel;
    const requestSnapshot=()=>{const now=Date.now();if(now-snapshotRequestedAt.current<1000)return;snapshotRequestedAt.current=now;void channel.send({type:"broadcast",event:"snapshot-request",payload:{streamId:STREAM_OWNER_USER_ID,sentAt:now}});};
    channel.on("broadcast",{event:"snapshot"},({payload})=>{snapshotRef.current=payload as StreamSnapshotMessage;setSnapshot(snapshotRef.current);setLive(true);setStatus("live");})
      .on("broadcast",{event:"frame"},({payload})=>{latestHost.current=payload as StreamFrameMessage;setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();})
      .on("broadcast",{event:"guest-state"},({payload})=>{const f=payload as GuestCharacterFrame;if(f.sessionId===latestHost.current?.sessionId||!latestHost.current)remoteGuests.current.set(f.guestId,f);})
      .on("broadcast",{event:"kick"},({payload})=>{if((payload as {guestId:string}).guestId===guestId){channel.untrack();physics.current=null;setMode("landing");setJoinError("You were removed by the host.");}})
      .on("broadcast",{event:"session-end"},()=>{hostPresent.current=false;latestHost.current=null;snapshotRef.current=null;setSnapshot(null);setLive(false);setStatus("ended");physics.current=null;setMode("landing");})
      .on("presence",{event:"sync"},()=>{const rows=Object.values(channel.presenceState()).flat() as unknown as StreamParticipantPresence[];hostPresent.current=rows.some(p=>p.role==="host");setParticipants(rows);if(hostPresent.current){setLive(true);setStatus("live");if(!snapshotRef.current)void requestSnapshot();}for(const p of rows)if(p.guestId&&p.faceDataUrl&&!faceCache.current.has(p.guestId)){const img=new Image();img.src=p.faceDataUrl;faceCache.current.set(p.guestId,img);}})
      .subscribe(async s=>{if(s==="SUBSCRIBED"){await channel.track({role:"viewer",joinedAt:Date.now()} satisfies StreamParticipantPresence);requestSnapshot();window.setTimeout(()=>{if(!snapshotRef.current)requestSnapshot();},1200);void loadSnapshot();}else if(s==="CHANNEL_ERROR"||s==="TIMED_OUT")setStatus("reconnecting");});return()=>{window.clearTimeout(initial);hostPresent.current=false;supabase.removeChannel(channel);channelRef.current=null;};},[guestId,loadSnapshot]);

  useEffect(()=>{if(!snapshot)return;for(const clip of snapshot.clips){const url=clip.type==="video"?(clip.thumbnailUrl||clip.sourceUrl):clip.sourceUrl;if(url&&!imageCache.current.has(url)){const img=new Image();img.crossOrigin="anonymous";img.src=url;imageCache.current.set(url,img);}}for(const ch of snapshot.characters)if(ch.faceDataUrl&&!faceCache.current.has(ch.id)){const img=new Image();img.src=ch.faceDataUrl;faceCache.current.set(ch.id,img);}},[snapshot]);

  const beginGuest=async()=>{const safe=cleanName(name);if(!safe){setJoinError("Enter a short, appropriate name.");return;}const guests=participants.filter(p=>p.role==="guest");if(guests.length>=MAX_GUESTS){setJoinError("This room is full.");return;}if(!snapshot)return;nameRef.current=safe;const surfaces=snapshot.clips.filter(c=>c.type==="image"||c.type==="video");const x=snapshot.spawnDoor?.x??snapshot.board.width/2;let y=snapshot.spawnDoor?.y??snapshot.board.height/2;const support=surfaces.filter(s=>x>=s.boardX&&x<=s.boardX+s.boardW).sort((a,b)=>Math.abs(a.boardY-y)-Math.abs(b.boardY-y))[0];if(support)y=support.boardY;physics.current={x,y,vx:0,vy:0,targetX:null,targetY:null,facing:1,grounded:!!support,surfaceId:support?.id??null,action:"idle",actionStarted:performance.now(),spawnAt:performance.now()};await channelRef.current?.track({role:"guest",guestId,name:safe,faceDataUrl:face,joinedAt:Date.now()} satisfies StreamParticipantPresence);setMode("guest");setJoinError("");};
  const emote=()=>{const p=physics.current;if(!p)return;p.emote=GUEST_EMOTES[emoteIndex.current++%GUEST_EMOTES.length];p.action="emote";p.actionStarted=performance.now();};
  const leave=async()=>{await channelRef.current?.track({role:"viewer",joinedAt:Date.now()} satisfies StreamParticipantPresence);physics.current=null;setMode("landing");};

  useEffect(()=>{if(mode!=="watch"&&mode!=="guest")return;let raf=0,last=performance.now();const frame=(now:number)=>{const dt=Math.min(.05,(now-last)/1000);last=now;const canvas=canvasRef.current,ctx=canvas?.getContext("2d");if(!canvas||!ctx){raf=requestAnimationFrame(frame);return;}const dpr=Math.min(2,devicePixelRatio||1),w=Math.floor(innerWidth*dpr),h=Math.floor(innerHeight*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}const host=latestHost.current;
      const p=physics.current;if(p&&snapshot){const surfaces=snapshot.clips;const target=p.targetX;if(p.action==="emote"&&now-p.actionStarted>1500){p.action="idle";p.emote=undefined;}if(target!==null){const dx=target-p.x;if(Math.abs(dx)<14){p.vx=0;p.targetX=null;if(p.grounded)p.action="idle";}else{p.facing=dx>0?1:-1;p.vx=p.facing*(Math.abs(dx)>280?620:330);p.action=Math.abs(dx)>280?"run":"walk";}}
        if(p.grounded){const s=surfaces.find(s=>s.id===p.surfaceId);if(!s||p.x<s.boardX||p.x>s.boardX+s.boardW){p.grounded=false;p.surfaceId=null;p.vy=30;}}p.x+=p.vx*dt;if(!p.grounded){const py=p.y;p.vy=Math.min(1200,p.vy+1850*dt);const ny=p.y+p.vy*dt;const land=surfaces.filter(s=>p.x>=s.boardX+10&&p.x<=s.boardX+s.boardW-10&&py<=s.boardY&&ny>=s.boardY).sort((a,b)=>a.boardY-b.boardY)[0];if(land){p.y=land.boardY;p.vy=0;p.grounded=true;p.surfaceId=land.id;p.action=p.targetX===null?"idle":p.action;}else p.y=ny;}
        if(!hostCam){const t=1-Math.exp(-dt*5.5);camera.current.cameraX=lerp(camera.current.cameraX,p.x,t);camera.current.cameraY=lerp(camera.current.cameraY,p.y-120,t);camera.current.boardZoom=lerp(camera.current.boardZoom,1.35,t*.1);}}
      if((mode==="watch"||hostCam)&&host){camera.current={cameraX:lerp(camera.current.cameraX,host.camera.cameraX,.22),cameraY:lerp(camera.current.cameraY,host.camera.cameraY,.22),boardZoom:lerp(camera.current.boardZoom,host.camera.boardZoom,.2)};}
      if(p&&now-publishAt.current>1000/15&&host){publishAt.current=now;const packet:GuestCharacterFrame={kind:"guest-state",streamId:STREAM_OWNER_USER_ID,sessionId:host.sessionId,sentAt:Date.now(),guestId,name:nameRef.current,position:{x:p.x,y:p.y},facing:p.facing,actionType:p.action,actionProgress:(now-p.actionStarted)/1000,emote:p.emote};channelRef.current?.send({type:"broadcast",event:"guest-state",payload:packet});remoteGuests.current.set(packet.guestId,packet);}
      const cam=camera.current,sf=cam.boardZoom*w/BOARD_W;ctx.fillStyle=snapshot?.board.backgroundColor??"#f5ecd8";ctx.fillRect(0,0,w,h);if(snapshot){for(const clip of [...snapshot.clips].sort((a,b)=>(a.layer??1)-(b.layer??1))){const x=(clip.boardX-cam.cameraX)*sf+w/2,y=(clip.boardY-cam.cameraY)*sf+h/2,im=imageCache.current.get(clip.type==="video"?(clip.thumbnailUrl||clip.sourceUrl):clip.sourceUrl);if(im?.complete)ctx.drawImage(im,x,y,clip.boardW*sf,clip.boardH*sf);else{ctx.fillStyle="#e5dcc7";ctx.fillRect(x,y,clip.boardW*sf,clip.boardH*sf);}}for(const a of snapshot.annotations)drawAnnotation(ctx,a,cam,sf,w,h);if(snapshot.spawnDoor)drawDoor(ctx,snapshot.spawnDoor.x,snapshot.spawnDoor.y,cam,sf,w,h,p?clamp(1-(now-p.spawnAt)/900,0,1):0);if(host)for(const ch of host.characters)drawSharedStreamCharacter(ctx,hostCharacterForRender(ch,snapshot.characters.find(x=>x.id===ch.id)?.faceAspect),faceCache.current.get(ch.id)??null,cam,sf,w,h);for(const [id,g] of remoteGuests.current){const old=renderedGuests.current.get(id),smooth=old?{...g,position:{x:lerp(old.position.x,g.position.x,.35),y:lerp(old.position.y,g.position.y,.35)}}:g;renderedGuests.current.set(id,smooth);drawSharedStreamCharacter(ctx,guestCharacterForRender(smooth),faceCache.current.get(id)??null,cam,sf,w,h,id===guestId?clamp((now-(p?.spawnAt??0))/650,0,1):1);}}
      raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);return()=>cancelAnimationFrame(raf);},[guestId,mode,hostCam,snapshot]);

  const clickCanvas=(e:React.MouseEvent<HTMLCanvasElement>)=>{const p=physics.current;if(!p||!snapshot||hostCam)return;const rect=e.currentTarget.getBoundingClientRect(),cam=camera.current,sf=cam.boardZoom*rect.width/BOARD_W,rawX=(e.clientX-rect.left-rect.width/2)/sf+cam.cameraX,rawY=(e.clientY-rect.top-rect.height/2)/sf+cam.cameraY;const surfaces=snapshot.clips.filter(s=>rawX>=s.boardX&&rawX<=s.boardX+s.boardW);const destination=surfaces.sort((a,b)=>Math.abs(a.boardY-rawY)-Math.abs(b.boardY-rawY))[0];if(destination&&p.grounded&&p.y-destination.boardY>=60&&p.y-destination.boardY<=250){p.vy=-clamp(680+(p.y-destination.boardY)*.5,680,810);p.grounded=false;p.surfaceId=null;p.action="jump";p.actionStarted=performance.now();}p.targetX=destination?clamp(rawX,destination.boardX+18,destination.boardX+destination.boardW-18):clamp(rawX,0,snapshot.board.width);p.targetY=destination?.boardY??p.y;};
  useEffect(()=>{const k=(e:KeyboardEvent)=>{if(mode!=="guest"||e.target instanceof HTMLInputElement)return;if(e.key.toLowerCase()==="e")emote();if(e.key.toLowerCase()==="v")setHostCam(v=>!v);};addEventListener("keydown",k);return()=>removeEventListener("keydown",k);},[mode]);

  if(mode==="join")return <main style={landing}><section style={card}><h2>Join as character</h2><input autoFocus maxLength={GUEST_NAME_MAX_LENGTH} value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" style={input}/><label style={{...button,display:"block",textAlign:"center",marginTop:10}}>Optional face<input hidden type="file" accept="image/*" onChange={async e=>{const f=e.target.files?.[0];if(f)setFace(await bakeFace(f));}}/></label>{face&&<img src={face} alt="Face preview" style={{width:48,height:56,display:"block",margin:"10px auto"}}/>}<p style={{fontSize:10,color:"#8b2b20"}}>{joinError}</p><button style={{...button,background:"#c8f135"}} onClick={beginGuest}>Spawn</button><button style={button} onClick={()=>setMode("landing")}>Cancel</button></section></main>;
  if(mode==="landing")return <main style={landing}><section style={card}><div style={{fontSize:11,color:live?"#228b22":"#8a6a00",fontWeight:700}}>{live?"LIVE":status==="ended"?"STREAM ENDED":"OFFLINE"}</div><h1>{STREAM_OWNER_NAME}</h1><p>{live?"Choose how to enter the live board.":joinError||"No active stream right now."}</p><button disabled={!live||!snapshot} style={button} onClick={()=>setMode("watch")}>Watch</button><button disabled={!live||!snapshot} style={{...button,background:live?"#c8f135":"#ddd"}} onClick={()=>setMode("join")}>Join as character ({participants.filter(p=>p.role==="guest").length}/{MAX_GUESTS})</button></section></main>;
  return <main style={{position:"fixed",inset:0,overflow:"hidden",background:"#f5ecd8"}}><canvas ref={canvasRef} onClick={clickCanvas} style={{width:"100vw",height:"100vh",display:"block",cursor:mode==="guest"&&!hostCam?"crosshair":"default"}}/><div style={{position:"fixed",top:12,left:12,display:"flex",gap:8,fontFamily:"monospace"}}><span style={pill}>{mode==="guest"?name:`LIVE · ${STREAM_OWNER_NAME}`}</span>{mode==="guest"&&<><button style={pill} onClick={()=>setHostCam(v=>!v)}>{hostCam?"Host cam":"Follow me"} · V</button><button style={pill} onClick={emote}>Emote · E</button><button style={pill} onClick={leave}>Leave</button></>}</div></main>;
}

const landing:React.CSSProperties={minHeight:"100vh",background:"#f5ecd8",color:"#2a2a2a",fontFamily:"monospace",display:"flex",alignItems:"center",justifyContent:"center",padding:24};
const card:React.CSSProperties={width:390,maxWidth:"100%",border:"2px solid #2a2a2a",background:"#fffdf5",boxShadow:"4px 4px 0 #2a2a2a",padding:18};
const button:React.CSSProperties={width:"100%",padding:"10px 12px",marginTop:8,border:"2px solid #2a2a2a",background:"#fffdf5",fontFamily:"monospace",fontWeight:700,cursor:"pointer"};
const input:React.CSSProperties={...button,boxSizing:"border-box"};
const pill:React.CSSProperties={background:"rgba(255,253,245,.92)",border:"1.5px solid #2a2a2a",boxShadow:"2px 2px 0 #2a2a2a",padding:"7px 9px",fontSize:11,fontWeight:700,pointerEvents:"auto"};
