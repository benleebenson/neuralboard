export const CURATION_QUERY_COUNT = 10;

export function buildCurationExpansionPrompt(topic: string): { system: string; user: string } {
  return {
    system: `You are a visual research editor expanding one broad topic into ${CURATION_QUERY_COUNT} diverse image-search queries. Return strict JSON only: {"queries":[{"query":"...","category":"people|experiments|scenes|metaphors|current"}]}.

Cover all of these editorial angles:
- PEOPLE: key thinkers, creators, public figures, or historical people associated with the topic; ask for portraits or documentary photographs.
- EXPERIMENTS: iconic experiments, objects, artifacts, diagrams-as-physical-objects, scientific imagery, and recognizable setups.
- SCENES: common narratives, real situations, environments, and human moments the topic evokes.
- METAPHORS: concrete, photographable visual metaphors for abstract ideas. Never request generic abstract art.
- CURRENT: culturally salient, recent, or currently popular manifestations of the topic. Do not invent news or unsupported people.

Make every query visually concrete, varied, and useful to an image search engine. Prefer 4-10 words. Avoid near-duplicates, generic stock-photo phrasing, text-heavy graphics, collages, logos, and twenty variations of the same subject. Include at least two people queries, two experiment/object queries, two scene queries, one metaphor, and one current query.`,
    user: `Expand this topic for visual discovery: ${topic.trim().slice(0, 160)}`,
  };
}

export function parseCurationQueries(value: unknown): Array<{ query: string; category: string }> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { queries?: unknown }).queries)) return [];
  const seen = new Set<string>();
  return (value as { queries: unknown[] }).queries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { query?: unknown; category?: unknown };
    const query = typeof row.query === "string" ? row.query.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const key = query.toLowerCase();
    if (query.length < 3 || seen.has(key)) return [];
    seen.add(key);
    return [{ query, category: typeof row.category === "string" ? row.category.slice(0, 30) : "other" }];
  }).slice(0, CURATION_QUERY_COUNT);
}

export function interleaveQueryResults<T>(groups: T[][]): T[] {
  const result: T[] = [];
  const length = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < length; index++) {
    for (const group of groups) if (group[index] !== undefined) result.push(group[index]);
  }
  return result;
}
