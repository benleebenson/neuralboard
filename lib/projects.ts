export const CLOUD_UNAVAILABLE = "Cloud storage unavailable — the Supabase project may be paused";
export const CLOUD_TIMEOUT_MS = 10_000;

export type CloudClip = {
  id: string; project_id: string; title: string; start_time: number; end_time: number;
  transcript: string; reason: string; approved: boolean; audio_storage_path: string; created_at: string;
};
export type ProjectImage = { id: string; project_id: string; storage_path: string; uploaded_at: string; caption: string };
export type CloudProject = {
  id: string; name: string; source_audio_name: string | null; source_audio_type: string | null;
  source_audio_size: number | null; source_audio_duration: number | null; created_at: string; updated_at: string;
  clips?: CloudClip[]; project_images?: ProjectImage[];
};

export async function cloudFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || (response.status >= 500 ? CLOUD_UNAVAILABLE : `Request failed (${response.status})`));
    }
    return response;
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError" || error instanceof TypeError) throw new Error(CLOUD_UNAVAILABLE);
    throw error;
  } finally { window.clearTimeout(timeout); }
}
