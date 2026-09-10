import crypto from "node:crypto";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, isAdmin } from "@/lib/auth";
import { PUBLIC_BOARD_UNAVAILABLE } from "@/lib/public-board";

export function publicBoardDeadline<T>(operation:PromiseLike<T>):Promise<T>{return Promise.race([Promise.resolve(operation),new Promise<T>((_,reject)=>setTimeout(()=>reject(new Error(PUBLIC_BOARD_UNAVAILABLE)),7_000))])}
export function publicBoardError(error:unknown){console.error("PUBLIC_BOARD_CLOUD_FAIL",error);if(error instanceof Error&&error.message.includes("PUBLIC_BOARD_RATE_LIMIT"))return NextResponse.json({error:"You’ve shared five posts this hour — please try again later."},{status:429});return NextResponse.json({error:PUBLIC_BOARD_UNAVAILABLE},{status:503})}
export function requestIp(request:Request){const forwarded=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();return forwarded||request.headers.get("x-real-ip")||"unknown"}
export function hashIp(ip:string){const secret=process.env.PUBLIC_BOARD_IP_HASH_SECRET||process.env.AUTH_SECRET;if(!secret)throw new Error("PUBLIC_BOARD_IP_HASH_SECRET is not configured");return crypto.createHmac("sha256",secret).update(ip).digest("hex")}
export async function requireOwner(){const session=await getServerSession(authOptions);return isAdmin(session?.user?.email)?session:null}
