import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { publicBoardDeadline, publicBoardError, requireOwner } from "@/lib/public-board-server";

export async function GET(_request:Request,context:RouteContext<"/api/public-board/image/[id]">){
  const {id}=await context.params;
  try{const owner=await requireOwner();if(!owner)return NextResponse.json({error:"Image not found"},{status:404});const query=getSupabase().from("public_board_posts").select("image_storage_path,status").eq("id",id).eq("type","image");const {data,error}=await publicBoardDeadline(query.maybeSingle());if(error)throw error;if(!data?.image_storage_path)return NextResponse.json({error:"Image not found"},{status:404});const signed=await publicBoardDeadline(getSupabase().storage.from("public-board-images").createSignedUrl(data.image_storage_path,60));if(signed.error)throw signed.error;return NextResponse.redirect(signed.data.signedUrl,{status:307,headers:{"Cache-Control":"private, no-store"}})}catch(error){return publicBoardError(error)}
}
