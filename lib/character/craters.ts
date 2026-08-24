import type { StreamBazookaFireMessage, StreamCrater, StreamCamera } from "../stream";
import {
  explodeActionPoint,
  explodeDetonationTime,
  explodeSeed,
  isExplodeAction,
  type ExplodeTimelineAction,
} from "./explode.ts";

export type BazookaVisualEvent = StreamBazookaFireMessage & { fizzle?: boolean };

function random(seed: number) { let x=seed|0;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;}; }

function craterPath(ctx:CanvasRenderingContext2D,cx:number,cy:number,r:number,seed:number){const rng=random(seed),jitter=Math.min(6,r*.08);ctx.beginPath();for(let i=0;i<18;i++){const a=i/18*Math.PI*2,rr=r+(rng()*2-1)*jitter,x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.closePath();}

export function craterForImpact(clip:{id:string;boardX:number;boardY:number;boardW:number;boardH:number},target:{x:number;y:number},seed:number):StreamCrater{return{clipId:clip.id,cx:target.x-clip.boardX,cy:target.y-clip.boardY,r:Math.min(Math.min(clip.boardW,clip.boardH)*.25,60+(seed%31)),seed};}

type CraterSurface = { id: string; boardX: number; boardY: number; boardW: number; boardH: number };

/**
 * Adds timeline-derived explode craters through the exact bazooka crater data path. Rendering
 * remains owned by drawCrateredImage, including its destination-out cutout and scorch rim.
 */
export function explodeCratersAt(
  time: number,
  actionGroups: readonly (readonly ExplodeTimelineAction[])[],
  surfaces: readonly CraterSurface[],
  initialCraters: readonly StreamCrater[] = [],
): StreamCrater[] {
  const craters = [...initialCraters];
  const actions = actionGroups.flat().filter(isExplodeAction)
    .sort((a, b) => explodeDetonationTime(a) - explodeDetonationTime(b) || a.id.localeCompare(b.id));
  for (const action of actions) {
    if (explodeDetonationTime(action) > time + 1e-9) continue;
    const target = explodeActionPoint(action);
    const surface = surfaces
      .filter((candidate) => target.x >= candidate.boardX && target.x <= candidate.boardX + candidate.boardW)
      .sort((a, b) => Math.abs(a.boardY - target.y) - Math.abs(b.boardY - target.y))[0];
    if (!surface) continue;
    const crater = craterForImpact(surface, target, explodeSeed(action.id));
    if (craters.some((candidate) => candidate.clipId === crater.clipId && candidate.seed === crater.seed)) continue;
    const sameSurface = craters.filter((candidate) => candidate.clipId === surface.id);
    craters.splice(0, craters.length, ...craters.filter((candidate) => candidate.clipId !== surface.id), ...sameSurface.slice(-23), crater);
  }
  return craters;
}

export function bazookaShake(events:BazookaVisualEvent[],now=Date.now()){const event=events[events.length-1];if(!event||event.fizzle)return{x:0,y:0};const travel=Math.hypot(event.target.x-event.from.x,event.target.y-event.from.y)/1100,age=(now-event.startTime)/1000-travel,duration=.42;if(age<0||age>duration)return{x:0,y:0};const strength=Math.pow(1-age/duration,1.3)*22;return{x:Math.sin(event.seed+age*95)*strength,y:Math.cos(event.seed*.7+age*117)*strength};}

export function drawCrateredImage(ctx:CanvasRenderingContext2D,img:CanvasImageSource,x:number,y:number,w:number,h:number,boardW:number,boardH:number,craters:StreamCrater[]){
  if(!craters.length){ctx.drawImage(img,x,y,w,h);return;}
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.ceil(w));canvas.height=Math.max(1,Math.ceil(h));const c=canvas.getContext("2d");if(!c)return;
  c.drawImage(img,0,0,canvas.width,canvas.height);
  const scaled=craters.map(crater=>({crater,cx:crater.cx/boardW*canvas.width,cy:crater.cy/boardH*canvas.height,r:crater.r/Math.min(boardW,boardH)*Math.min(canvas.width,canvas.height)}));
  for(const {crater,cx,cy,r} of scaled){c.save();craterPath(c,cx,cy,r,crater.seed);c.globalCompositeOperation="destination-out";c.fill();c.restore();}
  const scorch=document.createElement("canvas");scorch.width=canvas.width;scorch.height=canvas.height;const s=scorch.getContext("2d");if(s){for(const {crater,cx,cy,r} of scaled){s.save();craterPath(s,cx,cy,r*1.05,crater.seed);s.strokeStyle="#2a2a2a";s.globalAlpha=.88;s.lineWidth=Math.max(2,r*.13);s.stroke();craterPath(s,cx,cy,r*1.18,crater.seed+17);s.strokeStyle="rgba(42,42,42,.28)";s.lineWidth=Math.max(3,r*.16);s.stroke();s.restore();}s.globalCompositeOperation="destination-in";s.drawImage(canvas,0,0);c.drawImage(scorch,0,0);}
  ctx.drawImage(canvas,x,y,w,h);
}

export function drawBazookaEffect(ctx:CanvasRenderingContext2D,event:BazookaVisualEvent,cam:StreamCamera,sf:number,W:number,H:number,now=Date.now()){
  const age=(now-event.startTime)/1000;if(age<0||age>1.25)return;const sx=(event.from.x-cam.cameraX)*sf+W/2,sy=(event.from.y-cam.cameraY)*sf+H/2,tx=(event.target.x-cam.cameraX)*sf+W/2,ty=(event.target.y-cam.cameraY)*sf+H/2;const distance=Math.hypot(event.target.x-event.from.x,event.target.y-event.from.y),travel=distance/1100,p=Math.min(1,age/Math.max(.001,travel)),x=sx+(tx-sx)*p,y=sy+(ty-sy)*p;ctx.save();if(p<1){const rng=random(event.seed);if(age<.2){const dx=(tx-sx)/Math.max(1,Math.hypot(tx-sx,ty-sy)),dy=(ty-sy)/Math.max(1,Math.hypot(tx-sx,ty-sy));for(let i=0;i<3;i++){ctx.globalAlpha=.38-age*1.5;ctx.fillStyle="#d8d2c8";ctx.beginPath();ctx.arc(sx-dx*(18+i*10)*sf+(rng()-.5)*8,sy-dy*(18+i*10)*sf+(rng()-.5)*8,(10+i*4)*sf,0,Math.PI*2);ctx.fill();}}for(let i=0;i<4;i++){const q=Math.max(0,p-i*.055),px=sx+(tx-sx)*q,py=sy+(ty-sy)*q;ctx.globalAlpha=.3+i*.08;ctx.fillStyle="#d8d2c8";ctx.beginPath();ctx.arc(px+(rng()-.5)*8,py+(rng()-.5)*8,(8+i*3)*sf,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;ctx.fillStyle="#55606a";ctx.beginPath();ctx.arc(x,y,7*sf,0,Math.PI*2);ctx.fill();}else{const e=Math.min(1,(age-travel)/.25),rng=random(event.seed);if(event.fizzle){ctx.globalAlpha=(1-e)*.55;ctx.fillStyle="#d8d2c8";for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(tx+(rng()-.5)*18*sf,ty+(rng()-.5)*18*sf,(7+i*4+e*12)*sf,0,Math.PI*2);ctx.fill();}}else{ctx.globalAlpha=1-e;ctx.fillStyle="#fff45f";ctx.beginPath();ctx.arc(tx,ty,(22+e*35)*sf,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#2a2a2a";ctx.lineWidth=Math.max(2,4*sf);ctx.beginPath();ctx.arc(tx,ty,(15+e*95)*sf,0,Math.PI*2);ctx.stroke();for(let i=0;i<8;i++){const a=rng()*Math.PI*2,d=e*(35+rng()*80)*sf;ctx.fillStyle="#2a2a2a";ctx.fillRect(tx+Math.cos(a)*d,ty+Math.sin(a)*d,5*sf,5*sf);}}}ctx.restore();
}
