import type { CharacterSkin, GuestCharacterFrame, SpawnDoor, StreamCamera, StreamEliminationMessage } from "../stream";
import { STREAM_CHARACTER_GEOMETRY, characterConstructionParams } from "./geometry";

export { STREAM_CHARACTER_GEOMETRY };
export const streamCharacterConstructionParams = characterConstructionParams;

export type PlayCharacterState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  surfaceId: string | null;
  stride: number;
  spin: number;
  airborneAt?: number;
  spawnX: number;
  spawnY: number;
  action: "none" | "dance" | "emote" | "pullups" | "mirror" | "forceChoke";
  actionUntil: number;
  landedAt: number;
  grappleX: number | null;
  grappleY: number | null;
  grappleLength: number;
};

export type PlayHairStyle = "crop" | "spikes" | "curls" | "none";
export type PlayOutfitStyle = "tee" | "varsity" | "adventure";

export const PLAY_GRAVITY = 1850;
export const PLAY_JUMP_SPEED = 720;
export const PLAY_MAX_FALL_SPEED = 1350;
export const PLAY_CHARACTER_HEIGHT = 168;
export const PLAY_RESPAWN_BELOW_LOWEST_SURFACE = 650;

const PLAY_RUN_SPEED_FOR_RENDER = 760;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function drawPlaySpawnDoor(
  ctx: CanvasRenderingContext2D,
  state: PlayCharacterState,
  cam: { cameraX: number; cameraY: number; boardZoom: number },
  sf: number,
  W: number,
  H: number
) {
  const x = (state.spawnX - cam.cameraX) * sf + W / 2;
  const y = (state.spawnY - cam.cameraY) * sf + H / 2;
  const dw = 72 * sf;
  const dh = 126 * sf;
  ctx.save();
  ctx.fillStyle = "#f4b942";
  ctx.strokeStyle = "#2b2520";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.beginPath();
  ctx.roundRect(x - dw / 2, y - dh, dw, dh, [dw * 0.5, dw * 0.5, 4 * sf, 4 * sf]);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff8df";
  ctx.beginPath();
  ctx.arc(x + dw * 0.23, y - dh * 0.45, 4.5 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `700 ${Math.max(8, 11 * sf)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("START", x, y - dh - 10 * sf);
  ctx.restore();
}

export function drawPlacedSpawnDoor(ctx: CanvasRenderingContext2D, door: SpawnDoor, cam: { cameraX: number; cameraY: number; boardZoom: number }, sf: number, W: number, H: number) {
  const x = (door.x - cam.cameraX) * sf + W / 2, y = (door.y - cam.cameraY) * sf + H / 2;
  const dw = 90 * sf, dh = 150 * sf;
  ctx.save(); ctx.fillStyle = "#f4b942"; ctx.strokeStyle = "#2b2520"; ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.beginPath(); ctx.roundRect(x - dw / 2, y - dh, dw, dh, [dw * .5, dw * .5, 4, 4]); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + dw * .23, y - dh * .45, 4.5 * sf, 0, Math.PI * 2); ctx.fillStyle = "#fff8df"; ctx.fill(); ctx.stroke(); ctx.restore();
}

// Stream/render adapter exports live in this shared renderer module so /board2 and /stream cannot drift.
export const RENDERER_VERSION = "board2-authoritative-character-entity-2026-07-18-f";

const ELIMINATION_LAUNCH_AT = 0.58;
const ELIMINATION_DESPAWN_AT = 1.04;
export const STREAM_PROJECTILE_SPEED = 1400;

export function projectilePoint(origin: { x: number; y: number }, dir: { x: number; y: number }, startMs: number, nowMs: number, speed = STREAM_PROJECTILE_SPEED) {
  const age = Math.max(0, (nowMs - startMs) / 1000);
  return { x: origin.x + dir.x * speed * age, y: origin.y + dir.y * speed * age };
}

export function drawWeaponProjectile(
  ctx: CanvasRenderingContext2D,
  shot: { origin: { x: number; y: number }; dir: { x: number; y: number }; sentAt: number; seed: number },
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  nowMs = Date.now(),
) {
  const head = projectilePoint(shot.origin, shot.dir, shot.sentAt, nowMs);
  const tail = projectilePoint(shot.origin, shot.dir, shot.sentAt - 85, nowMs);
  const sx = (head.x - cam.cameraX) * sf + W / 2;
  const sy = (head.y - cam.cameraY) * sf + H / 2;
  const tx = (tail.x - cam.cameraX) * sf + W / 2;
  const ty = (tail.y - cam.cameraY) * sf + H / 2;
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([10 * sf, 7 * sf]);
  ctx.strokeStyle = "#f4b942";
  ctx.lineWidth = Math.max(2, 4 * sf);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff45f";
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(3, 5 * sf), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawTommyGunHeld(
  ctx: CanvasRenderingContext2D,
  shooter: { x: number; y: number; facing: 1 | -1 },
  aimBoard: { x: number; y: number },
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  recoilPx = 0,
) {
  const sx = (shooter.x - cam.cameraX) * sf + W / 2;
  const sy = (shooter.y - cam.cameraY) * sf + H / 2;
  const ax = (aimBoard.x - cam.cameraX) * sf + W / 2;
  const ay = (aimBoard.y - cam.cameraY) * sf + H / 2;
  const rawDx = ax - sx;
  const dir = Math.abs(rawDx) < Math.tan((8 * Math.PI) / 180) * Math.abs(ay - (sy - 104 * sf))
    ? shooter.facing
    : rawDx >= 0 ? 1 : -1;
  const localAim = Math.atan2(ay - (sy - 104 * sf), Math.abs(rawDx));
  const aimUxLocal = Math.cos(localAim);
  const aimUy = Math.sin(localAim);
  const aimUx = aimUxLocal * dir;
  const perpX = -aimUy;
  const perpY = aimUx;
  const chest = { x: sx, y: sy - 108 * sf };
  const recoil = recoilPx * sf;
  const rearGrip = {
    x: chest.x + aimUx * 34 * sf - aimUx * recoil,
    y: chest.y + aimUy * 34 * sf - aimUy * recoil,
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#27221f";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.translate(rearGrip.x - aimUx * 18 * sf - perpX * 1.5 * sf, rearGrip.y - aimUy * 18 * sf - perpY * 1.5 * sf);
  ctx.rotate(localAim);
  ctx.scale(dir, 1);
  ctx.fillStyle = "#595f66";
  ctx.beginPath();
  ctx.roundRect(0, -9 * sf, 58 * sf, 18 * sf, 4 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(56 * sf, -3 * sf, 30 * sf, 6 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(82 * sf, -9 * sf);
  ctx.lineTo(89 * sf, -9 * sf);
  ctx.stroke();
  ctx.fillStyle = "#8B5A2B";
  ctx.beginPath();
  ctx.moveTo(-1 * sf, 1 * sf);
  ctx.lineTo(-38 * sf, 18 * sf);
  ctx.lineTo(-43 * sf, 9 * sf);
  ctx.lineTo(-8 * sf, -6 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(17 * sf, 9 * sf, 10 * sf, 26 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(36 * sf, 7 * sf, 9 * sf, 24 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#6d7379";
  ctx.beginPath();
  ctx.arc(31 * sf, 20 * sf, 16 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawBazookaHeld(ctx:CanvasRenderingContext2D,shooter:{x:number;y:number;facing:1|-1},aimBoard:{x:number;y:number},cam:StreamCamera,sf:number,W:number,H:number,recoilPx=0,pickupProgress=1){
  const sx=(shooter.x-cam.cameraX)*sf+W/2,sy=(shooter.y-cam.cameraY)*sf+H/2,ax=(aimBoard.x-cam.cameraX)*sf+W/2,ay=(aimBoard.y-cam.cameraY)*sf+H/2,rawDx=ax-sx;
  const dir=Math.abs(rawDx)<Math.tan(8*Math.PI/180)*Math.abs(ay-(sy-118*sf))?shooter.facing:rawDx>=0?1:-1;
  const aim=Math.atan2(ay-(sy-118*sf),Math.abs(rawDx)),pickup=clamp(pickupProgress,0,1),lift=pickup*pickup*(3-2*pickup),rotation=aim*dir*lift;
  const ux=Math.cos(rotation)*dir,uy=Math.sin(rotation)*dir,downX=-Math.sin(rotation),downY=Math.cos(rotation);
  const heldCenter={x:sx+Math.cos(aim)*dir*(10-recoilPx)*sf,y:sy-118*sf+Math.sin(aim)*(10-recoilPx)*sf},groundCenter={x:sx+dir*34*sf,y:sy-17*sf};
  const tubeCenter={x:groundCenter.x+(heldCenter.x-groundCenter.x)*lift,y:groundCenter.y+(heldCenter.y-groundCenter.y)*lift};
  const point=(along:number,down:number)=>({x:tubeCenter.x+ux*along*sf+downX*down*sf,y:tubeCenter.y+uy*along*sf+downY*down*sf});
  const rearGrip=point(3,19),frontGrip=point(39,10),shoulderTrigger={x:sx+dir*14*sf,y:sy-118*sf},shoulderSupport={x:sx-dir*14*sf,y:sy-116*sf};
  const solveArm=(shoulder:{x:number;y:number},hand:{x:number;y:number},bend:1|-1)=>{const upper=44*sf,fore=42*sf,dx=hand.x-shoulder.x,dy=hand.y-shoulder.y,rawD=Math.max(.001,Math.hypot(dx,dy)),d=clamp(rawD,8*sf,upper+fore-.01),vx=dx/rawD,vy=dy/rawD,along=(upper*upper-fore*fore+d*d)/(2*d),height=Math.sqrt(Math.max(0,upper*upper-along*along)),base={x:shoulder.x+vx*along,y:shoulder.y+vy*along};return{x:base.x+(-vy)*height*bend,y:base.y+vx*height*bend};};
  const armTo=(shoulder:{x:number;y:number},hand:{x:number;y:number},bend:1|-1)=>{const elbow=solveArm(shoulder,hand,bend);ctx.beginPath();ctx.moveTo(shoulder.x,shoulder.y);ctx.lineTo(elbow.x,elbow.y);ctx.lineTo(hand.x,hand.y);ctx.stroke();};
  ctx.save();ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#171817";ctx.lineWidth=Math.max(1.5,3*sf);
  armTo(shoulderSupport,frontGrip,dir>0?1:-1);armTo(shoulderTrigger,rearGrip,dir>0?-1:1);
  ctx.save();ctx.translate(tubeCenter.x,tubeCenter.y);ctx.rotate(rotation);ctx.scale(dir,1);
  ctx.fillStyle="#252924";ctx.beginPath();ctx.moveTo(-84*sf,-17*sf);ctx.lineTo(-70*sf,-13*sf);ctx.lineTo(-70*sf,13*sf);ctx.lineTo(-84*sf,17*sf);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.fillStyle="#647052";ctx.beginPath();ctx.roundRect(-72*sf,-13*sf,164*sf,26*sf,6*sf);ctx.fill();ctx.stroke();
  ctx.fillStyle="#7e8966";ctx.beginPath();ctx.roundRect(-57*sf,-9*sf,57*sf,8*sf,3*sf);ctx.fill();
  ctx.fillStyle="#46503d";ctx.beginPath();ctx.roundRect(-67*sf,-13*sf,14*sf,26*sf,3*sf);ctx.fill();ctx.stroke();ctx.beginPath();ctx.roundRect(16*sf,-13*sf,13*sf,26*sf,3*sf);ctx.fill();ctx.stroke();ctx.beginPath();ctx.roundRect(82*sf,-15*sf,14*sf,30*sf,4*sf);ctx.fill();ctx.stroke();
  ctx.fillStyle="#292d28";ctx.beginPath();ctx.roundRect(-88*sf,-18*sf,8*sf,36*sf,4*sf);ctx.fill();ctx.stroke();ctx.beginPath();ctx.roundRect(93*sf,-17*sf,8*sf,34*sf,4*sf);ctx.fill();ctx.stroke();
  ctx.fillStyle="#394135";ctx.beginPath();ctx.roundRect(-2*sf,11*sf,13*sf,29*sf,3*sf);ctx.fill();ctx.stroke();ctx.beginPath();ctx.roundRect(31*sf,9*sf,12*sf,19*sf,3*sf);ctx.fill();ctx.stroke();
  ctx.strokeStyle="#ee7d16";ctx.lineWidth=Math.max(2,4*sf);ctx.beginPath();ctx.moveTo(8*sf,14*sf);ctx.lineTo(17*sf,24*sf);ctx.lineTo(25*sf,13*sf);ctx.stroke();
  ctx.strokeStyle="#171817";ctx.lineWidth=Math.max(1.5,3*sf);ctx.fillStyle="#252924";for(const sightX of [-18,4]){ctx.beginPath();ctx.roundRect(sightX*sf,-20*sf,8*sf,8*sf,2*sf);ctx.fill();ctx.stroke();}
  ctx.restore();
  ctx.fillStyle="#171817";for(const hand of [frontGrip,rearGrip]){ctx.beginPath();ctx.arc(hand.x,hand.y,7*sf,0,Math.PI*2);ctx.fill();ctx.stroke();}
  ctx.restore();
}

export function eliminationFrameForGuest(
  frame: GuestCharacterFrame,
  event: StreamEliminationMessage,
  renderTimeMs = Date.now(),
  clockOffsetMs = 0,
): GuestCharacterFrame | null {
  const hostNow = renderTimeMs - clockOffsetMs;
  const t = clamp((hostNow - event.startTime) / Math.max(1, event.duration * 1000), 0, 1.2);
  if (t >= ELIMINATION_DESPAWN_AT) return null;
  const dir: 1 | -1 = event.target.x >= event.shooter.x ? 1 : -1;
  const hitShake =
    Math.sin(t * Math.PI * 54 + event.seed) *
    (t < ELIMINATION_LAUNCH_AT ? Math.max(0, 1 - Math.abs(t - 0.35) * 2.4) : 0);
  let position = {
    x: event.target.x + dir * hitShake * 18,
    y: event.target.y - Math.abs(hitShake) * 10,
  };
  let velocity = { x: dir * 80, y: -30 };
  if (t >= ELIMINATION_LAUNCH_AT) {
    const u = clamp((t - ELIMINATION_LAUNCH_AT) / (ELIMINATION_DESPAWN_AT - ELIMINATION_LAUNCH_AT), 0, 1.15);
    const horizontal = 520 * u + 5200 * u * u;
    const lift = -Math.sin(clamp(u, 0, 1) * Math.PI) * 660;
    const fall = 260 * u * u;
    position = {
      x: event.target.x + dir * horizontal,
      y: event.target.y + lift + fall,
    };
    velocity = {
      x: dir * (650 + 3200 * u),
      y: -820 + 2100 * u,
    };
  }
  return {
    ...frame,
    actionType: "eliminated",
    actionStartTime: event.startTime,
    actionDuration: event.duration,
    actionProgress: t,
    facing: dir > 0 ? -1 : 1,
    position,
    velocity,
    receivedAt: renderTimeMs,
  };
}

export function drawEliminationSequence(
  ctx: CanvasRenderingContext2D,
  event: StreamEliminationMessage,
  cam: StreamCamera,
  sf: number,
  W: number,
  H: number,
  renderTimeMs = Date.now(),
  clockOffsetMs = 0,
) {
  const hostNow = renderTimeMs - clockOffsetMs;
  const t = clamp((hostNow - event.startTime) / Math.max(1, event.duration * 1000), 0, 1.1);
  const sx = (event.shooter.x - cam.cameraX) * sf + W / 2;
  const sy = (event.shooter.y - cam.cameraY) * sf + H / 2;
  const tx = (event.target.x - cam.cameraX) * sf + W / 2;
  const ty = (event.target.y - cam.cameraY) * sf + H / 2;
  const dir = event.shooter.facing;
  const aim = Math.atan2((ty - 92 * sf) - (sy - 104 * sf), tx - sx);
  const recoil = Math.sin(t * Math.PI * 36 + event.seed) * (t > 0.14 && t < 0.58 ? 3 * sf : 0);
  const aimUx = Math.cos(aim);
  const aimUy = Math.sin(aim);
  const perpX = -aimUy;
  const perpY = aimUx;
  const chest = { x: sx, y: sy - 108 * sf };
  const rearGrip = {
    x: chest.x + aimUx * 34 * sf - aimUx * Math.abs(recoil),
    y: chest.y + aimUy * 34 * sf - aimUy * Math.abs(recoil),
  };
  const frontGrip = {
    x: rearGrip.x + aimUx * 52 * sf,
    y: rearGrip.y + aimUy * 52 * sf,
  };
  const shoulderTrigger = { x: sx + dir * 14 * sf, y: sy - 118 * sf };
  const shoulderSupport = { x: sx - dir * 14 * sf, y: sy - 116 * sf };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#27221f";
  ctx.lineWidth = Math.max(1.5, 3 * sf);
  ctx.fillStyle = "#fff3dc";
  ctx.beginPath();
  ctx.moveTo(sx - 16 * sf, sy - 122 * sf);
  ctx.lineTo(sx + 18 * sf, sy - 120 * sf);
  ctx.lineTo(sx + 10 * sf, sy - 54 * sf);
  ctx.lineTo(sx - 10 * sf, sy - 54 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 12 * sf, sy - 54 * sf);
  ctx.lineTo(sx - 24 * sf, sy - 5 * sf);
  ctx.moveTo(sx + 12 * sf, sy - 54 * sf);
  ctx.lineTo(sx + 24 * sf, sy - 5 * sf);
  ctx.stroke();
  const solveArm = (shoulder: { x: number; y: number }, hand: { x: number; y: number }, bend: 1 | -1) => {
    const upper = 44 * sf;
    const fore = 42 * sf;
    const dx = hand.x - shoulder.x;
    const dy = hand.y - shoulder.y;
    const rawD = Math.max(0.001, Math.hypot(dx, dy));
    const d = clamp(rawD, 8 * sf, upper + fore - 0.01);
    const ux = dx / rawD;
    const uy = dy / rawD;
    const along = (upper * upper - fore * fore + d * d) / (2 * d);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const base = { x: shoulder.x + ux * along, y: shoulder.y + uy * along };
    return { x: base.x + (-uy) * height * bend, y: base.y + ux * height * bend };
  };
  const armTo = (shoulder: { x: number; y: number }, hand: { x: number; y: number }, bend: 1 | -1) => {
    const elbow = solveArm(shoulder, hand, bend);
    ctx.beginPath();
    ctx.moveTo(shoulder.x, shoulder.y);
    ctx.lineTo(elbow.x, elbow.y);
    ctx.lineTo(hand.x, hand.y);
    ctx.stroke();
    ctx.fillStyle = "#f6d4b4";
    ctx.beginPath();
    ctx.arc(hand.x, hand.y, 7 * sf, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };
  armTo(shoulderSupport, frontGrip, dir > 0 ? 1 : -1);
  armTo(shoulderTrigger, rearGrip, dir > 0 ? -1 : 1);
  ctx.translate(rearGrip.x - aimUx * 18 * sf - perpX * 1.5 * sf, rearGrip.y - aimUy * 18 * sf - perpY * 1.5 * sf);
  ctx.rotate(aim);
  ctx.fillStyle = "#595f66";
  ctx.beginPath();
  ctx.roundRect(0, -9 * sf, 58 * sf, 18 * sf, 4 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(56 * sf, -3 * sf);
  ctx.lineTo(86 * sf, -3 * sf);
  ctx.lineTo(86 * sf, 3 * sf);
  ctx.lineTo(56 * sf, 3 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(82 * sf, -9 * sf);
  ctx.lineTo(89 * sf, -9 * sf);
  ctx.stroke();
  ctx.fillStyle = "#8B5A2B";
  ctx.beginPath();
  ctx.moveTo(-1 * sf, 1 * sf);
  ctx.lineTo(-38 * sf, 18 * sf);
  ctx.lineTo(-43 * sf, 9 * sf);
  ctx.lineTo(-8 * sf, -6 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(17 * sf, 9 * sf, 10 * sf, 26 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(36 * sf, 7 * sf, 9 * sf, 24 * sf, 3 * sf);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#6d7379";
  ctx.beginPath();
  ctx.arc(31 * sf, 20 * sf, 16 * sf, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (t > 0.14 && t < 0.58) {
    for (let i = 0; i < 3; i += 1) {
      const casingT = (t * 16 + i * 0.31 + event.seed * 0.001) % 1;
      ctx.beginPath();
      ctx.moveTo((35 - casingT * 18) * sf, (-13 - i * 4 - casingT * 9) * sf);
      ctx.lineTo((39 - casingT * 18) * sf, (-15 - i * 4 - casingT * 9) * sf);
      ctx.stroke();
    }
  }
  ctx.restore();

  [0.18, 0.33, 0.48].forEach((start, index) => {
    const shotT = clamp((t - start) / 0.14, 0, 1);
    if (shotT <= 0 || shotT >= 1) return;
    const muzzleX = rearGrip.x + Math.cos(aim) * 116 * sf;
    const muzzleY = rearGrip.y + Math.sin(aim) * 116 * sf;
    const targetX = tx + Math.sin(event.seed + index) * 14 * sf;
    const targetY = ty - (96 + index * 8) * sf;
    const ex = lerp(muzzleX, targetX, shotT);
    const ey = lerp(muzzleY, targetY, shotT);
    ctx.save();
    ctx.strokeStyle = ["#9be7ff", "#f4b942", "#ff5e87"][index];
    ctx.setLineDash([8 * sf, 5 * sf]);
    ctx.lineWidth = Math.max(2, 4 * sf);
    ctx.beginPath();
    ctx.moveTo(muzzleX, muzzleY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    const burst = (1 - Math.abs(shotT - 0.78)) * 16 * sf;
    if (shotT > 0.62) {
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const a = (i / 10) * Math.PI * 2;
        const r = i % 2 ? burst * 0.45 : burst;
        const px = targetX + Math.cos(a) * r;
        const py = targetY + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (shotT < 0.22) {
      ctx.fillStyle = "#fff45f";
      ctx.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        const r = (i % 2 ? 10 : 21) * sf * (1 - shotT);
        const px = muzzleX + Math.cos(a) * r;
        const py = muzzleY + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  });
  if (t >= ELIMINATION_LAUNCH_AT) {
    const u = clamp((t - ELIMINATION_LAUNCH_AT) / (ELIMINATION_DESPAWN_AT - ELIMINATION_LAUNCH_AT), 0, 1.15);
    const trailDir = event.target.x >= event.shooter.x ? 1 : -1;
    ctx.save();
    ctx.strokeStyle = "rgba(39,34,31,0.62)";
    ctx.fillStyle = "rgba(255,244,95,0.9)";
    ctx.lineWidth = Math.max(1, 2 * sf);
    for (let i = 0; i < 5; i += 1) {
      const px = tx + trailDir * (90 + i * 58 + u * 260) * sf;
      const py = ty - (120 + Math.sin(u * Math.PI + i) * 80 - i * 14) * sf;
      ctx.beginPath();
      for (let j = 0; j < 5; j += 1) {
        const a = (j / 5) * Math.PI * 2 - Math.PI / 2;
        const r = (j % 2 ? 5 : 12) * sf * (1 - Math.min(0.75, u * 0.5));
        const x = px + Math.cos(a) * r;
        const y = py + Math.sin(a) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
