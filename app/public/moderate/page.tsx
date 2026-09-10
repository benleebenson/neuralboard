import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/public-board-server";
import ModerationClient from "./ModerationClient";

export const dynamic="force-dynamic";
export default async function PublicBoardModerationPage(){if(!await requireOwner())redirect("/public");return <ModerationClient/>}
