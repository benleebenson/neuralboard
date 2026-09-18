export const STYLE_EXEMPLAR_TOKEN_BUDGET = 6_000;
export const MAX_STYLE_EXEMPLARS_PER_REQUEST = 50;

export type DistributionSummary = {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
};

export type BoardStyleSummary = {
  schemaVersion: 1;
  board: {
    id: string;
    title: string;
    modifiedAt: string;
    aspectRatio: string;
    durationSec: number;
  };
  pacing: {
    imageCount: number;
    secondsPerImage: DistributionSummary | null;
    byBoardThird: Array<{ section: "early" | "middle" | "late"; medianSec: number | null }>;
  };
  imagery: {
    queryCount: number;
    literalCount: number;
    metaphoricalCount: number;
    examples: Array<{ query: string; subject?: string; reason?: string; mode: "literal" | "metaphorical" }>;
  };
  topics: {
    count: number;
    imagesPerTopic: DistributionSummary | null;
    titles: string[];
    titleStyle: { medianWords: number | null; titleCaseFraction: number };
  };
  camera: {
    mode: string;
    panCount: number;
    focusCount: number;
    customZoomCount: number;
    broadPanCount?: number;
    wideBeatFraction?: number;
    typicalHoldSec: DistributionSummary | null;
    panFraction?: number;
    customZoomFraction?: number;
  };
  layout?: {
    distinctMediaCount: number;
    largestToMedianArea: number | null;
    clusterCount: number;
    whitespaceRatio: number | null;
    edgeAlignmentFraction: number | null;
    titleCenterpiece: { present: boolean; xFraction: number | null; yFraction: number | null };
  };
  characters: {
    enabledCount: number;
    actionCount: number;
    actions: Array<{ type: string; count: number }>;
    timelinePlacement: { early: number; middle: number; late: number };
  };
  annotations: {
    count: number;
    textCount: number;
    medianWords: number | null;
    medianCharacters: number | null;
    phrasing: { questionCount: number; exclamationCount: number; allCapsCount: number };
    examples: string[];
    perMedia?: number;
    byType?: Record<string, number>;
  };
  approximateTokens: number;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter((item): item is UnknownRecord => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function cleanText(value: unknown, maxLength = 160): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    min: round(sorted[0]),
    p25: round(percentile(sorted, 0.25)),
    median: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    max: round(sorted.at(-1)!),
  };
}

export function estimateStyleSummaryTokens(value: unknown): number {
  // JSON punctuation tokenizes efficiently; four UTF-16 characters per token is a conservative
  // approximation for the short English fields in these summaries.
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function imageTimelineItems(manifest: UnknownRecord): UnknownRecord[] {
  const timeline = record(manifest.timeline);
  const board = record(manifest.board);
  const blocks = records(timeline.blocks);
  const mediaById = new Map(records(board.media).map((item) => [String(item.id ?? ""), item]));
  if (blocks.length || mediaById.size) {
    return blocks.flatMap((block) => {
      const type = cleanText(block.type, 30);
      if ((type !== "image" && type !== "video") || block.featured === false) return [];
      const media = mediaById.get(String(block.mediaId ?? block.id ?? "")) ?? {};
      return [{ ...media, ...block }];
    });
  }
  return records(board.clips ?? manifest.clips).filter((clip) =>
    (clip.type === "image" || clip.type === "video") && clip.featured !== false && clip.revealOnly !== true
  );
}

function cameraBlocks(manifest: UnknownRecord): UnknownRecord[] {
  const cameraInputs = record(record(manifest.camera).inputs);
  const timelineBlocks = records(record(manifest.timeline).blocks);
  const legacyClips = records(record(manifest.board).clips ?? manifest.clips);
  const source = timelineBlocks.length ? timelineBlocks : legacyClips;
  const explicitlySaved = [
    ...records(cameraInputs.panBlocks),
    ...records(cameraInputs.characterZoomBlocks),
  ];
  const candidates = explicitlySaved.length ? explicitlySaved : source;
  const seen = new Set<string>();
  return candidates.filter((block, index) => {
    if (!["pan", "characterFocus", "characterZoom", "customZoom"].includes(String(block.type ?? ""))) return false;
    const key = String(block.id ?? `${block.type}:${block.startTime}:${index}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metaphorical(reason: string, query: string): boolean {
  return /\b(metaphor|symbol|embod|echo|mirrors?|contrast|visuali[sz]|makes? .+ tangible|stands? for|suggests?|evokes?|abstract)\b/i.test(`${reason} ${query}`);
}

function timelineThird(startTime: number, durationSec: number): "early" | "middle" | "late" {
  const fraction = durationSec > 0 ? startTime / durationSec : 0;
  return fraction < 1 / 3 ? "early" : fraction < 2 / 3 ? "middle" : "late";
}

function isTitleCase(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => !/[a-z]/.test(word[0] ?? "") || word[0] === word[0]?.toUpperCase());
}

export function extractBoardStyleSummary(manifestValue: unknown): BoardStyleSummary {
  const manifest = record(manifestValue);
  const meta = record(manifest.meta);
  const durationSec = Math.max(0, finiteNumber(meta.duration ?? meta.totalDurationSec ?? manifest.duration));
  const images = imageTimelineItems(manifest).slice().sort((a, b) => finiteNumber(a.startTime) - finiteNumber(b.startTime));
  const imagePacingSamples = images.map((image, index) => {
    const start = Math.max(0, finiteNumber(image.startTime));
    const nextStart = index < images.length - 1 ? finiteNumber(images[index + 1].startTime, start) : null;
    return nextStart !== null && nextStart > start
      ? nextStart - start
      : Math.max(0, finiteNumber(image.duration));
  });
  const pacingSamples = imagePacingSamples.filter((value) => value > 0);
  const pacingByThird = (["early", "middle", "late"] as const).map((section) => {
    const values = images.flatMap((image, index) => {
      if (timelineThird(finiteNumber(image.startTime), durationSec) !== section) return [];
      return imagePacingSamples[index] > 0 ? [imagePacingSamples[index]] : [];
    });
    return { section, medianSec: summarizeDistribution(values)?.median ?? null };
  });

  const imageryExamples = images.flatMap((image) => {
    const query = cleanText(image.searchQuery ?? record(image.provenance).searchQuery, 140);
    const reason = cleanText(image.imagePlanReason ?? image.reason ?? record(image.provenance).reason, 180);
    const subject = cleanText(image.name ?? image.subject, 100);
    if (!query && !subject) return [];
    return [{ query: query || subject, ...(subject && subject !== query ? { subject } : {}), ...(reason ? { reason } : {}), mode: metaphorical(reason, query) ? "metaphorical" as const : "literal" as const }];
  }).slice(0, 8);

  const topicsById = new Map<string, { title: string; count: number }>();
  for (const image of images) {
    const id = cleanText(image.autoTopicId, 80);
    const title = cleanText(image.autoTopicTitle, 80);
    if (!id && !title) continue;
    const key = id || title.toLowerCase();
    const current = topicsById.get(key) ?? { title: title || "Untitled topic", count: 0 };
    current.count += 1;
    if (title) current.title = title;
    topicsById.set(key, current);
  }
  const topicValues = [...topicsById.values()];
  const topicTitles = topicValues.map((topic) => topic.title).slice(0, 8);
  const titleWordCounts = topicTitles.map((title) => title.split(/\s+/).filter(Boolean).length);

  const blocks = cameraBlocks(manifest);
  const keyframes = records(record(manifest.camera).keyframes);
  const broadPanCount = Math.floor(keyframes.filter((keyframe) => keyframe.broadPan === true).length / 2);
  const holdValues = images.flatMap((image) => {
    const duration = Math.max(0, finiteNumber(image.duration));
    const holdFraction = Math.min(1, Math.max(0, finiteNumber(image.holdFraction, 0.7)));
    return duration > 0 ? [duration * holdFraction] : [];
  });

  const characterRecords = Object.values(record(manifest.characters)).map(record);
  const legacyCharacters = records(manifest.characters);
  const characters = characterRecords.length ? characterRecords : legacyCharacters;
  const actions = characters.flatMap((character) => records(character.actions));
  const actionCounts = new Map<string, number>();
  const characterPlacement = { early: 0, middle: 0, late: 0 };
  for (const action of actions) {
    const type = cleanText(action.type, 50) || "unknown";
    actionCounts.set(type, (actionCounts.get(type) ?? 0) + 1);
    characterPlacement[timelineThird(finiteNumber(action.startTime), durationSec)] += 1;
  }

  const annotations = records(manifest.annotations);
  const textAnnotations = annotations.map((annotation) => cleanText(annotation.text, 120)).filter(Boolean);
  const wordCounts = textAnnotations.map((text) => text.split(/\s+/).filter(Boolean).length);
  const characterCounts = textAnnotations.map((text) => text.length);
  const board = record(manifest.board);
  const dimensions = record(board.dimensions);
  const boardWidth = finiteNumber(dimensions.width);
  const boardHeight = finiteNumber(dimensions.height);
  const uniqueMedia = records(board.media).length ? records(board.media) : images;
  const rects = uniqueMedia.flatMap((media) => {
    const x = finiteNumber(media.boardX, NaN);
    const y = finiteNumber(media.boardY, NaN);
    const width = finiteNumber(media.boardW, NaN);
    const height = finiteNumber(media.boardH, NaN);
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
      ? [{ x, y, width, height, topic: cleanText(media.autoTopicId, 80) }] : [];
  });
  const areas = rects.map((rect) => rect.width * rect.height);
  const areaDistribution = summarizeDistribution(areas);
  const explicitClusters = new Set(rects.map((rect) => rect.topic).filter(Boolean));
  const centers = rects.map((rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }));
  const distance = (left: number, right: number) => Math.hypot(centers[left].x - centers[right].x, centers[left].y - centers[right].y);
  const nearest = centers.map((_, index) => Math.min(...centers.flatMap((__, other) => index === other ? [] : [distance(index, other)])));
  const spatialThreshold = (summarizeDistribution(nearest)?.median ?? 0) * 1.8;
  const visited = new Set<number>();
  let spatialClusters = 0;
  for (let index = 0; index < centers.length; index++) {
    if (visited.has(index)) continue;
    spatialClusters++;
    const queue = [index];
    visited.add(index);
    for (const current of queue) {
      for (let other = 0; other < centers.length; other++) {
        if (!visited.has(other) && distance(current, other) <= spatialThreshold) {
          visited.add(other);
          queue.push(other);
        }
      }
    }
  }
  const alignedPairs = rects.flatMap((left, index) => rects.slice(index + 1).map((right) =>
    [left.x, left.x + left.width].some((edge) => [right.x, right.x + right.width].some((other) => Math.abs(edge - other) < 12)) ||
    [left.y, left.y + left.height].some((edge) => [right.y, right.y + right.height].some((other) => Math.abs(edge - other) < 12))
  ));
  const centeredTitles = annotations.filter((annotation) => annotation.type === "text" &&
    boardWidth > 0 && boardHeight > 0 &&
    Math.abs((finiteNumber(annotation.boardX) + finiteNumber(annotation.boardW) / 2) / boardWidth - 0.5) < 0.22 &&
    Math.abs((finiteNumber(annotation.boardY) + finiteNumber(annotation.boardH) / 2) / boardHeight - 0.5) < 0.2);
  const centerpiece = centeredTitles.sort((a, b) => finiteNumber(b.fontSize) - finiteNumber(a.fontSize))[0];
  const annotationTypes = Object.fromEntries([...new Set(annotations.map((annotation) => cleanText(annotation.type, 30)))].map((type) =>
    [type, annotations.filter((annotation) => annotation.type === type).length]));

  const summaryWithoutTokens: Omit<BoardStyleSummary, "approximateTokens"> = {
    schemaVersion: 1,
    board: {
      id: cleanText(meta.id ?? meta.projectId ?? manifest.name, 100),
      title: cleanText(meta.title ?? manifest.name, 100) || "Untitled board",
      modifiedAt: cleanText(meta.modifiedAt ?? manifest.savedAt, 40),
      aspectRatio: cleanText(meta.aspectRatio ?? manifest.canvasAspect, 20) || "unknown",
      durationSec: round(durationSec),
    },
    pacing: {
      imageCount: images.length,
      secondsPerImage: summarizeDistribution(pacingSamples),
      byBoardThird: pacingByThird,
    },
    imagery: {
      queryCount: images.filter((image) => !!cleanText(image.searchQuery ?? record(image.provenance).searchQuery)).length,
      literalCount: imageryExamples.filter((item) => item.mode === "literal").length,
      metaphoricalCount: imageryExamples.filter((item) => item.mode === "metaphorical").length,
      examples: imageryExamples,
    },
    topics: {
      count: topicValues.length,
      imagesPerTopic: summarizeDistribution(topicValues.map((topic) => topic.count)),
      titles: topicTitles,
      titleStyle: {
        medianWords: summarizeDistribution(titleWordCounts)?.median ?? null,
        titleCaseFraction: topicTitles.length ? round(topicTitles.filter(isTitleCase).length / topicTitles.length) : 0,
      },
    },
    camera: {
      mode: cleanText(record(manifest.camera).mode ?? manifest.cameraMode, 30) || "unknown",
      panCount: blocks.filter((block) => block.type === "pan").length,
      focusCount: blocks.filter((block) => block.type === "characterFocus" || block.type === "characterZoom").length,
      customZoomCount: blocks.filter((block) => block.type === "customZoom").length,
      broadPanCount,
      wideBeatFraction: images.length ? round(broadPanCount / images.length) : 0,
      typicalHoldSec: summarizeDistribution(holdValues),
      panFraction: blocks.length ? round(blocks.filter((block) => block.type === "pan").length / blocks.length) : 0,
      customZoomFraction: blocks.length ? round(blocks.filter((block) => block.type === "customZoom").length / blocks.length) : 0,
    },
    layout: {
      distinctMediaCount: uniqueMedia.length,
      largestToMedianArea: areaDistribution?.median ? round(areaDistribution.max / areaDistribution.median) : null,
      clusterCount: explicitClusters.size || spatialClusters || topicValues.length,
      whitespaceRatio: boardWidth > 0 && boardHeight > 0 ? round(Math.max(0, 1 - areas.reduce((sum, area) => sum + area, 0) / (boardWidth * boardHeight))) : null,
      edgeAlignmentFraction: alignedPairs.length ? round(alignedPairs.filter(Boolean).length / alignedPairs.length) : null,
      titleCenterpiece: {
        present: !!centerpiece,
        xFraction: centerpiece ? round((finiteNumber(centerpiece.boardX) + finiteNumber(centerpiece.boardW) / 2) / boardWidth) : null,
        yFraction: centerpiece ? round((finiteNumber(centerpiece.boardY) + finiteNumber(centerpiece.boardH) / 2) / boardHeight) : null,
      },
    },
    characters: {
      enabledCount: characters.filter((character) => character.enabled !== false).length,
      actionCount: actions.length,
      actions: [...actionCounts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)).slice(0, 10),
      timelinePlacement: characterPlacement,
    },
    annotations: {
      count: annotations.length,
      textCount: textAnnotations.length,
      medianWords: summarizeDistribution(wordCounts)?.median ?? null,
      medianCharacters: summarizeDistribution(characterCounts)?.median ?? null,
      phrasing: {
        questionCount: textAnnotations.filter((text) => text.includes("?")).length,
        exclamationCount: textAnnotations.filter((text) => text.includes("!")).length,
        allCapsCount: textAnnotations.filter((text) => /[A-Z]/.test(text) && text === text.toUpperCase()).length,
      },
      examples: textAnnotations.slice(0, 6),
      perMedia: uniqueMedia.length ? round(annotations.length / uniqueMedia.length) : 0,
      byType: annotationTypes,
    },
  };
  const approximateTokens = estimateStyleSummaryTokens(summaryWithoutTokens);
  return { ...summaryWithoutTokens, approximateTokens };
}

export function selectStyleExemplars(
  summaries: readonly BoardStyleSummary[],
  tokenBudget = STYLE_EXEMPLAR_TOKEN_BUDGET,
): { selected: BoardStyleSummary[]; approximateTokens: number } {
  const sorted = summaries.slice(0, MAX_STYLE_EXEMPLARS_PER_REQUEST).sort((a, b) =>
    b.board.modifiedAt.localeCompare(a.board.modifiedAt) || b.board.durationSec - a.board.durationSec
  );
  const selected: BoardStyleSummary[] = [];
  let approximateTokens = 0;
  for (const summary of sorted) {
    const tokens = Math.max(1, summary.approximateTokens || 0, estimateStyleSummaryTokens(summary));
    if (selected.length && approximateTokens + tokens > tokenBudget) continue;
    if (!selected.length && tokens > tokenBudget) continue;
    selected.push(summary);
    approximateTokens += tokens;
  }
  return { selected, approximateTokens };
}

export function stylePacingSeconds(summaries: readonly BoardStyleSummary[], fallback: number): number {
  const medians = summaries.flatMap((summary) => summary.pacing.secondsPerImage?.median ? [summary.pacing.secondsPerImage.median] : []);
  return Math.min(12, Math.max(3, summarizeDistribution(medians)?.median ?? fallback));
}

export function describeAppliedStyle(summaries: readonly BoardStyleSummary[], pacingSec: number): string | null {
  if (!summaries.length) return null;
  const literal = summaries.reduce((sum, summary) => sum + summary.imagery.literalCount, 0);
  const metaphoricalCount = summaries.reduce((sum, summary) => sum + summary.imagery.metaphoricalCount, 0);
  const imagery = metaphoricalCount > literal * 0.6 ? "concrete-metaphor image choices" : "concrete documentary image choices";
  const sizeRatios = summaries.flatMap((summary) => summary.layout?.largestToMedianArea ? [summary.layout.largestToMedianArea] : []);
  const hierarchy = summarizeDistribution(sizeRatios)?.median;
  return `Matched your ~${round(pacingSec)}s pacing, ${imagery}${hierarchy ? `, and ~${round(hierarchy)}× image-area hierarchy` : ""}.`;
}
