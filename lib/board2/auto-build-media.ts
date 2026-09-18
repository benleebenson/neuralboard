export type PlannedAppearance = {
  query: string;
  characterName?: string;
  characterCallback?: boolean;
  reactionShot?: boolean;
};

const STOP_WORDS = new Set("a an and at by for from in of on photo photograph picture the to with wide close up editorial candid image".split(" "));

function subjectTokens(query: string): Set<string> {
  return new Set(query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

/** Resolve repeated visual subjects before search while retaining every narration appearance. */
export function planMediaReferences<T extends PlannedAppearance>(appearances: readonly T[]): number[] {
  const subjects: Array<{ queryKey: string; tokens: Set<string>; character: string; reaction: boolean }> = [];
  return appearances.map((appearance) => {
    const queryKey = appearance.query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokens = subjectTokens(appearance.query);
    const character = (appearance.characterName ?? "").trim().toLowerCase();
    const reaction = appearance.reactionShot === true;
    const match = subjects.findIndex((subject) => {
      if (queryKey && subject.queryKey === queryKey) return true;
      if (character && appearance.characterCallback && subject.character === character && !subject.reaction) return true;
      if (reaction !== subject.reaction) return false;
      const intersection = [...tokens].filter((token) => subject.tokens.has(token)).length;
      const union = new Set([...tokens, ...subject.tokens]).size;
      return union > 0 && intersection >= 2 && intersection / union >= 0.72;
    });
    if (match >= 0) return match;
    subjects.push({ queryKey, tokens, character, reaction });
    return subjects.length - 1;
  });
}

export function canonicalSourceKey(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|width|height|w|h|size)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return sourceUrl.trim();
  }
}

/** Catches byte-identical search results even when providers return different URLs. */
export async function imageContentFingerprint(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
