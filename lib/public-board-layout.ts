import type { PublicBoardPost } from "./public-board.ts";
import { organicLayoutRectsOverlap, stableOrganicLayoutSeed, type LayoutRect } from "./board2/organic-topic-layout.ts";

export type PlacedPublicPost=PublicBoardPost&LayoutRect&{rotation:number};
function randomFor(value:string){let state=stableOrganicLayoutSeed(value);return()=>{state+=0x6d2b79f5;let n=state;n=Math.imul(n^n>>>15,n|1);n^=n+Math.imul(n^n>>>7,n|61);return((n^n>>>14)>>>0)/4294967296}}
export function layoutPublicBoard(posts:PublicBoardPost[]):{posts:PlacedPublicPost[];width:number;height:number}{
  const placed:PlacedPublicPost[]=[];const occupied:LayoutRect[]=[];
  for(const post of [...posts].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))){const random=randomFor(post.id);const width=post.type==="image"?320:280;const height=post.type==="image"?300:190;let rect:LayoutRect|null=null;
    for(let attempt=0;attempt<1200&&!rect;attempt++){const angle=attempt*2.399963+random()*.45;const radius=80+Math.sqrt(attempt)*105;const candidate={x:1600+Math.cos(angle)*radius-width/2,y:1200+Math.sin(angle)*radius-height/2,width,height};if(!occupied.some(other=>organicLayoutRectsOverlap(candidate,other,38)))rect=candidate}
    const safe=rect??{x:1600,y:1200+occupied.length*(height+50),width,height};occupied.push(safe);placed.push({...post,...safe,rotation:(random()-.5)*5});
  }
  const maxX=Math.max(3200,...placed.map(p=>p.x+p.width+300));const maxY=Math.max(2400,...placed.map(p=>p.y+p.height+300));const minX=Math.min(0,...placed.map(p=>p.x-300));const minY=Math.min(0,...placed.map(p=>p.y-300));return{posts:placed.map(p=>({...p,x:p.x-minX,y:p.y-minY})),width:maxX-minX,height:maxY-minY};
}
