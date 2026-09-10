export const PUBLIC_BOARD_UNAVAILABLE = "Public board unavailable — the Supabase project may be paused";
export const PUBLIC_BOARD_TIMEOUT_MS = 8_000;
export type PublicBoardPost = { id:string; type:"text"|"image"; text:string|null; name:string|null; status:"pending"|"approved"|"rejected"; created_at:string; approved_at:string|null; image_storage_path?:string|null; ip_hash?:string };

export async function publicBoardFetch(input:RequestInfo|URL,init:RequestInit={}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),PUBLIC_BOARD_TIMEOUT_MS);
  try{const response=await fetch(input,{...init,signal:controller.signal});if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(body?.error||(response.status>=500?PUBLIC_BOARD_UNAVAILABLE:`Request failed (${response.status})`))}return response}
  catch(error){if((error as DOMException)?.name==="AbortError"||error instanceof TypeError)throw new Error(PUBLIC_BOARD_UNAVAILABLE);throw error}
  finally{clearTimeout(timeout)}
}
