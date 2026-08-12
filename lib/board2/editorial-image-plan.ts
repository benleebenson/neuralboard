export const EDITORIAL_IMAGE_PLAN_MODEL = "gpt-5-mini";
export const MAX_EDITORIAL_IMAGE_COUNT = 24;

export type EditorialImagePlanItem = {
  query: string;
  startTime: number;
  reason: string;
};

export type EditorialTranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type EditorialImagePromptInput = {
  transcript: string;
  segments: EditorialTranscriptSegment[];
  durationSec: number;
  secondsPerImage: number;
  targetCount: number;
};

export function editorialImageTargetCount(durationSec: number, secondsPerImage: number): number {
  return Math.min(
    MAX_EDITORIAL_IMAGE_COUNT,
    Math.max(1, Math.ceil(Math.max(0.1, durationSec) / Math.max(0.1, secondsPerImage))),
  );
}

export function buildEditorialImagePlanPrompt(input: EditorialImagePromptInput): {
  system: string;
  user: string;
} {
  const duration = input.durationSec.toFixed(2);
  const interval = input.secondsPerImage.toFixed(1);
  const timedTranscript = input.segments.length
    ? input.segments
        .map((segment) => `[${segment.start.toFixed(2)}s-${segment.end.toFixed(2)}s] ${segment.text.trim()}`)
        .join("\n")
    : `[0.00s-${duration}s] ${input.transcript.trim()}`;

  const system = `You are the editorial image director for a narrated video. Read the FULL narration and silently identify its arc, tone, turning points, and recurring motifs before choosing any visuals. Build a coherent sequence that tells the story and expresses its meaning; do not mechanically assign one literal search to each transcript slice.

Create exactly ${input.targetCount} image moments for a ${duration}-second video (an average pace of about one image every ${interval} seconds). You may cluster changes around important turns and hold a strong image longer when the story benefits.

For every image:
- Write a concrete, specific Google Images search query likely to find one strong REAL PHOTOGRAPH.
- Make the sequence feel intentionally edited: vary establishing scenes, human moments, revealing details, action, scale, and visual metaphor while maintaining continuity.
- Prefer visually searchable people, places, objects, actions, environments, documentary scenes, and editorial photography. Every query must describe something a camera could plausibly capture in one frame.
- For an abstract idea, choose a concrete visual metaphor that supports the surrounding narrative.
- Match the overall narrative arc, tone, setting, and time period. Do not invent unsupported named people, places, or events.
- Avoid text-heavy results: no quote cards, posters, memes, infographics, screenshots, book covers, logos, or images whose value depends on readable text.
- Avoid generic stock-photo cliches, near-duplicate subjects, and repeating the same composition. Never ask for a collage or an "abstract representation."
- Do not use vague inner-state queries such as "person thinking," "person realizing," "person feeling curious," or "dreamlike scene." Show the viewer observable evidence instead.
- Make each query specific enough to steer the search (normally 5-12 words), but write search terms rather than an AI-art prompt. Avoid words such as "concept," "symbolizes," "surreal," or "dreamlike" in the query.
- Quality examples:
  BAD "person reflecting thoughtfully" -> GOOD "woman checking wristwatch alone on late night train photo"
  BAD "abstract curiosity light bulb" -> GOOD "child opening natural history museum specimen drawer photograph"
  BAD "dream fragments collage" -> GOOD "long empty hotel corridor repeating doors photograph"
- Set startTime to the spoken moment when the image should first appear, never the end of that transcript segment. The first image must start at 0. Start times must be unique, increasing, at least 0.1 seconds apart, and between 0 and ${(input.durationSec - 0.1).toFixed(2)}.
- Give a concise one-line editorial reason that connects the image to the narrative meaning.

Return STRICT JSON ONLY: one JSON array with exactly this item shape and no wrapper object, prose, or Markdown fences:
[{"query":"concrete real-photo search query","startTime":0,"reason":"one-line editorial reason"}]`;

  const user = `FULL TRANSCRIPT (${duration}s total):
${input.transcript.trim()}

FULL TIMESTAMPED TRANSCRIPT:
${timedTranscript}

Plan exactly ${input.targetCount} editorial images. Return the JSON array only.`;

  return { system, user };
}

function parseJsonCandidate(text: string): unknown {
  const candidates = new Set<string>();
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  candidates.add(trimmed);

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  candidates.add(withoutFence);

  const arrayStart = withoutFence.indexOf("[");
  const arrayEnd = withoutFence.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.add(withoutFence.slice(arrayStart, arrayEnd + 1));
  }

  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.add(withoutFence.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }
  return null;
}

export function parseEditorialImagePlan(
  responseText: string,
  durationSec: number,
  maxItems = MAX_EDITORIAL_IMAGE_COUNT,
): EditorialImagePlanItem[] {
  const parsed = parseJsonCandidate(responseText);
  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as { images?: unknown; plan?: unknown }).images ?? (parsed as { plan?: unknown }).plan)
      : null;
  if (!Array.isArray(rawItems)) return [];

  const duration = Math.max(0.1, durationSec);
  const dedupedQueries = new Set<string>();
  const items: EditorialImagePlanItem[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as { query?: unknown; startTime?: unknown; reason?: unknown };
    const query = typeof item.query === "string" ? item.query.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const reason = typeof item.reason === "string" ? item.reason.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    const startTime = typeof item.startTime === "number" || typeof item.startTime === "string"
      ? Number(item.startTime)
      : Number.NaN;
    const queryKey = query.toLowerCase();
    if (query.length < 3 || !reason || !Number.isFinite(startTime) || dedupedQueries.has(queryKey)) continue;
    dedupedQueries.add(queryKey);
    items.push({
      query,
      startTime: Math.min(Math.max(0, startTime), Math.max(0, duration - 0.1)),
      reason,
    });
  }

  items.sort((a, b) => a.startTime - b.startTime);
  const uniqueTimes = items.filter((item, index, sorted) =>
    index === 0 || item.startTime - sorted[index - 1].startTime >= 0.05
  ).slice(0, Math.max(1, maxItems));
  if (uniqueTimes.length) uniqueTimes[0] = { ...uniqueTimes[0], startTime: 0 };
  return uniqueTimes;
}
