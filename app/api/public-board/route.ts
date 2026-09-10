import { NextResponse } from "next/server";
import sharp from "sharp";
import { getSupabase } from "@/lib/supabase";
import { hashIp, publicBoardDeadline, publicBoardError, requestIp } from "@/lib/public-board-server";

export async function GET(){
  try{const {data,error}=await publicBoardDeadline(getSupabase().from("public_board_posts").select("id,type,text,name,status,created_at,approved_at").eq("status","approved").order("approved_at",{ascending:true}));if(error)throw error;return NextResponse.json(data??[],{headers:{"Cache-Control":"public, max-age=15, stale-while-revalidate=45"}})}catch(error){return publicBoardError(error)}
}

export async function POST(request:Request){
  try{
    const form=await request.formData();const text=String(form.get("text")??"").trim();const name=String(form.get("name")??"").trim().slice(0,60)||null;const incoming=form.get("image");
    if(text.length>280)return NextResponse.json({error:"Keep your idea to 280 characters or fewer."},{status:400});
    if(!text&&!(incoming instanceof File&&incoming.size>0))return NextResponse.json({error:"Add an idea or choose an image."},{status:400});
    const ipHash=hashIp(requestIp(request));const supabase=getSupabase();let path:string|null=null;
    if(incoming instanceof File&&incoming.size>0){
      if(!incoming.type.startsWith("image/"))return NextResponse.json({error:"Only image files are accepted."},{status:400});
      if(incoming.size>4*1024*1024)return NextResponse.json({error:"Image must be smaller than 4 MB."},{status:413});
      let jpeg:Buffer;try{jpeg=await sharp(Buffer.from(await incoming.arrayBuffer()),{limitInputPixels:40_000_000}).rotate().resize({width:1600,height:1600,fit:"inside",withoutEnlargement:true}).jpeg({quality:82,mozjpeg:true}).toBuffer()}catch{return NextResponse.json({error:"That file could not be read as an image."},{status:400})}
      const id=crypto.randomUUID();path=`${id}.jpg`;const upload=await publicBoardDeadline(supabase.storage.from("public-board-images").upload(path,jpeg,{contentType:"image/jpeg",upsert:false}));if(upload.error)throw upload.error;
    }
    const inserted=await publicBoardDeadline(supabase.from("public_board_posts").insert({type:path?"image":"text",text:text||null,image_storage_path:path,name,status:"pending",ip_hash:ipHash}).select("id,status").single());
    if(inserted.error){if(path)await supabase.storage.from("public-board-images").remove([path]);throw inserted.error}
    return NextResponse.json({id:inserted.data.id,status:"pending",message:"Thanks — your post will appear once it’s approved."},{status:201});
  }catch(error){return publicBoardError(error)}
}
