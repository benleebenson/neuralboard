import assert from "node:assert/strict";
import test from "node:test";
import { layoutPublicBoard } from "./public-board-layout.ts";

function posts(count){return Array.from({length:count},(_,index)=>({id:`post-${index}`,type:index%3?"text":"image",text:`Idea ${index}`,name:null,status:"approved",created_at:new Date(1_700_000_000_000+index*1000).toISOString(),approved_at:null}))}
test("public board placement is deterministic and collision-free",()=>{const first=layoutPublicBoard(posts(120));const second=layoutPublicBoard(posts(120));assert.deepEqual(first,second);for(let i=0;i<first.posts.length;i++){for(let j=i+1;j<first.posts.length;j++){const a=first.posts[i],b=first.posts[j];assert.ok(a.x+a.width+30<=b.x||a.x>=b.x+b.width+30||a.y+a.height+30<=b.y||a.y>=b.y+b.height+30,`${a.id} overlaps ${b.id}`)}}});
