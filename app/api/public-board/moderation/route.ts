import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { publicBoardDeadline, publicBoardError, requireOwner } from "@/lib/public-board-server";

export async function GET(request:Request){
  if(!await requireOwner())return NextResponse.json({error:"Forbidden"},{status:403});
  try{const countOnly=new URL(request.url).searchParams.get("count")==="1";if(countOnly){const {count,error}=await publicBoardDeadline(getSupabase().from("public_board_posts").select("*",{count:"exact",head:true}).eq("status","pending"));if(error)throw error;return NextResponse.json({count:count??0})}const {data,error}=await publicBoardDeadline(getSupabase().from("public_board_posts").select("*").order("created_at",{ascending:false}));if(error)throw error;return NextResponse.json(data??[])}catch(error){return publicBoardError(error)}
}

export async function PATCH(request:Request){
  if(!await requireOwner())return NextResponse.json({error:"Forbidden"},{status:403});const body=await request.json().catch(()=>null);const ids=Array.isArray(body?.ids)?body.ids.filter((id:unknown)=>typeof id==="string").slice(0,100):[];const action=body?.action;
  if(!ids.length||!["approve","reject","remove"].includes(action))return NextResponse.json({error:"Invalid moderation action"},{status:400});
  try{const supabase=getSupabase();if(action==="approve"){const {error}=await publicBoardDeadline(supabase.from("public_board_posts").update({status:"approved",approved_at:new Date().toISOString()}).in("id",ids).eq("status","pending"));if(error)throw error;return NextResponse.json({ok:true})}
    const rows=await publicBoardDeadline(supabase.from("public_board_posts").select("image_storage_path").in("id",ids));if(rows.error)throw rows.error;const deletion=await publicBoardDeadline(supabase.from("public_board_posts").delete().in("id",ids));if(deletion.error)throw deletion.error;const paths=(rows.data??[]).map(row=>row.image_storage_path).filter((path):path is string=>!!path);if(paths.length){const removed=await publicBoardDeadline(supabase.storage.from("public-board-images").remove(paths));if(removed.error)throw removed.error}return NextResponse.json({ok:true});
  }catch(error){return publicBoardError(error)}
}
