export type BoardBackedClipType = "image" | "video" | "customZoom";

export type BoardEntityRecord = {
  id: string;
  type: string;
  mediaId?: string;
  featured?: boolean;
  startTime?: number;
  duration?: number;
  boardX?: number;
  boardY?: number;
  boardW?: number;
  boardH?: number;
};

export function isBoardBackedClipType(type: string): type is BoardBackedClipType {
  return type === "image" || type === "video" || type === "customZoom";
}

export function boardEntityId(clip: Pick<BoardEntityRecord, "id" | "type" | "mediaId">): string {
  return isBoardBackedClipType(clip.type) ? clip.mediaId ?? clip.id : clip.id;
}

export function isCanonicalBoardEntity(clip: Pick<BoardEntityRecord, "id" | "type" | "mediaId">): boolean {
  return !isBoardBackedClipType(clip.type) || clip.id === boardEntityId(clip);
}

/** One DOM object per board entity. Focus regions come first so media remains above them. */
export function boardEntitiesForDisplay<T extends BoardEntityRecord>(clips: readonly T[]): T[] {
  const byEntity = new Map<string, T>();
  for (const clip of clips) {
    if (!isBoardBackedClipType(clip.type) || clip.boardX === undefined || clip.boardY === undefined || clip.boardW === undefined || clip.boardH === undefined) continue;
    const entityId = boardEntityId(clip);
    const previous = byEntity.get(entityId);
    if (!previous || clip.id === entityId) byEntity.set(entityId, clip);
  }
  return [...byEntity.values()].sort((a, b) => Number(a.type !== "customZoom") - Number(b.type !== "customZoom"));
}

/**
 * Canvas rendering needs the active timeline instance (not necessarily the canonical record),
 * particularly for videos whose appearances own independent playback elements.
 */
export function boardEntityRepresentativesAtTime<T extends BoardEntityRecord>(clips: readonly T[], time: number): T[] {
  const groups = new Map<string, T[]>();
  const passthrough: T[] = [];
  for (const clip of clips) {
    if (!isBoardBackedClipType(clip.type)) {
      passthrough.push(clip);
      continue;
    }
    const id = boardEntityId(clip);
    groups.set(id, [...(groups.get(id) ?? []), clip]);
  }
  const representatives = [...groups.entries()].map(([entityId, instances]) =>
    instances.find((clip) => clip.featured !== false && time >= (clip.startTime ?? 0) && time < (clip.startTime ?? 0) + (clip.duration ?? 0))
      ?? instances.find((clip) => clip.id === entityId)
      ?? instances[0]
  );
  return [...passthrough, ...representatives];
}

export function referencesBoardEntity(
  clip: Pick<BoardEntityRecord, "id" | "type" | "mediaId">,
  entityId: string,
): boolean {
  return isBoardBackedClipType(clip.type) && boardEntityId(clip) === entityId;
}
