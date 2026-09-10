import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { cloudDeadline, cloudError, ownedProject, projectOwner } from "@/lib/project-api";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
export async function POST(request: Request, context: RouteContext<"/api/projects/[id]/images">) {
  const owner = await projectOwner(); if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId } = await context.params;
  try {
    const project = await ownedProject(projectId, owner); if (project.error) throw project.error;
    if (!project.data) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const form = await request.formData(); const image = form.get("image");
    if (!(image instanceof File) || !IMAGE_TYPES.has(image.type)) return NextResponse.json({ error: "Choose a JPEG, PNG, WebP, GIF, HEIC, or HEIF image" }, { status: 400 });
    if (image.size > 4 * 1024 * 1024) return NextResponse.json({ error: "Image exceeds the 4 MB upload limit" }, { status: 413 });
    const imageId = crypto.randomUUID(); const extension = image.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "image";
    const storagePath = `${projectId}/${imageId}.${extension}`; const supabase = getSupabase();
    const upload = await cloudDeadline(supabase.storage.from("project-images").upload(storagePath, image, { contentType: image.type, upsert: false }));
    if (upload.error) throw upload.error;
    const inserted = await cloudDeadline(supabase.from("project_images").insert({ id: imageId, project_id: projectId, storage_path: storagePath, caption: String(form.get("caption") ?? "").slice(0, 500) }).select("*").single());
    if (inserted.error) { await supabase.storage.from("project-images").remove([storagePath]); throw inserted.error; }
    return NextResponse.json(inserted.data, { status: 201 });
  } catch (error) { return cloudError(error); }
}
