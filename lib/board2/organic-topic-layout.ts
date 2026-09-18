export type LayoutRect = { x: number; y: number; width: number; height: number };

export type OrganicLayoutImage = {
  id: string;
  width: number;
  height: number;
  startTime: number;
  importance?: "anchor" | "support";
};

export type OrganicLayoutTopic = {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  images: OrganicLayoutImage[];
};

export type OrganicPlacedImage = OrganicLayoutImage & LayoutRect & {
  topicId: string;
  sizeVariation: number;
};

export type OrganicPlacedTopic = {
  id: string;
  title: string;
  startTime: number;
  endTime: number;
  region: LayoutRect;
  label: LayoutRect;
  images: OrganicPlacedImage[];
  bounds: LayoutRect;
};

type OrganicLayoutOptions = {
  boardWidth: number;
  boardHeight: number;
  seed: number;
  topics: OrganicLayoutTopic[];
  occupied?: LayoutRect[];
  sizeRatio?: number;
  clusterGapRatio?: number;
};

const OUTER_MARGIN_X = 140;
const OUTER_MARGIN_Y = 140;
const IMAGE_GAP = 18;

export function titleCenterpieceRect(boardWidth: number, boardHeight: number): LayoutRect {
  return { x: boardWidth * 0.31, y: boardHeight * 0.42, width: boardWidth * 0.38, height: boardHeight * 0.16 };
}

export function organicBoardSizeForImageCount(
  imageCount: number,
  baseWidth = 4000,
  baseHeight = 3000,
): { width: number; height: number } {
  // The original 4000×3000 board comfortably holds about 24 editorial images. Grow both axes
  // by the square root of density so image size and inter-cluster breathing room stay stable.
  const scale = Math.max(1, Math.sqrt(Math.max(1, imageCount) / 24));
  const roundUp = (value: number) => Math.ceil(value / 500) * 500;
  return { width: roundUp(baseWidth * scale), height: roundUp(baseHeight * scale) };
}

export function stableOrganicLayoutSeed(value: string): number {
  // FNV-1a: quick, stable across browsers, and sufficient for visual layout seeding.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function organicLayoutRectsOverlap(a: LayoutRect, b: LayoutRect, padding = 0): boolean {
  return !(
    a.x + a.width + padding <= b.x ||
    a.x >= b.x + b.width + padding ||
    a.y + a.height + padding <= b.y ||
    a.y >= b.y + b.height + padding
  );
}

function boundingRect(rects: LayoutRect[]): LayoutRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function candidateFits(candidate: LayoutRect, region: LayoutRect, occupied: LayoutRect[]): boolean {
  return candidate.x >= region.x && candidate.y >= region.y &&
    candidate.x + candidate.width <= region.x + region.width &&
    candidate.y + candidate.height <= region.y + region.height &&
    !occupied.some((rect) => organicLayoutRectsOverlap(candidate, rect, IMAGE_GAP));
}

function findOrganicPosition(
  region: LayoutRect,
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  random: () => number,
  occupied: LayoutRect[],
): LayoutRect | null {
  for (let attempt = 0; attempt < 220; attempt++) {
    const localAttempt = attempt % 110;
    const aroundAnchor = attempt < 110;
    const radius = Math.min(region.width, region.height) * (0.04 + localAttempt / 109 * 0.34);
    const angle = random() * Math.PI * 2;
    const centerX = aroundAnchor
      ? anchorX + Math.cos(angle) * radius * random()
      : region.x + width / 2 + random() * Math.max(0, region.width - width);
    const centerY = aroundAnchor
      ? anchorY + Math.sin(angle) * radius * random()
      : region.y + height / 2 + random() * Math.max(0, region.height - height);
    const candidate = {
      x: clampNumber(centerX - width / 2, region.x, region.x + region.width - width),
      y: clampNumber(centerY - height / 2, region.y, region.y + region.height - height),
      width,
      height,
    };
    if (candidateFits(candidate, region, occupied)) return candidate;
  }
  return null;
}

export function layoutOrganicTopicClusters(options: OrganicLayoutOptions): OrganicPlacedTopic[] {
  const topics = options.topics.filter((topic) => topic.images.length > 0);
  if (!topics.length) return [];
  const random = seededRandom(options.seed);
  const title = titleCenterpieceRect(options.boardWidth, options.boardHeight);
  const occupied = [...(options.occupied ?? []), title];
  const count = topics.length;
  const orbit = count === 1 ? 0 : clampNumber(options.clusterGapRatio ?? 0.34, 0.25, 0.4);
  const regionWidth = count === 1 ? options.boardWidth - 2 * OUTER_MARGIN_X :
    Math.min(options.boardWidth * 0.42, options.boardWidth * 1.1 / Math.sqrt(count));
  const regionHeight = count === 1 ? options.boardHeight - 2 * OUTER_MARGIN_Y :
    Math.min(options.boardHeight * 0.43, options.boardHeight * 1.08 / Math.sqrt(count));

  return topics.map((topic, topicIndex): OrganicPlacedTopic => {
    const angle = -Math.PI / 2 + topicIndex * Math.PI * 2 / count + (random() - 0.5) * 0.17;
    const centerX = options.boardWidth * (0.5 + Math.cos(angle) * orbit);
    const centerY = options.boardHeight * (0.5 + Math.sin(angle) * orbit);
    const region: LayoutRect = {
      x: clampNumber(centerX - regionWidth / 2, OUTER_MARGIN_X, options.boardWidth - OUTER_MARGIN_X - regionWidth),
      y: clampNumber(centerY - regionHeight / 2, OUTER_MARGIN_Y, options.boardHeight - OUTER_MARGIN_Y - regionHeight),
      width: regionWidth,
      height: regionHeight,
    };
    const contentRegion: LayoutRect = {
      x: region.x + 18,
      y: region.y + 18,
      width: region.width - 36,
      height: region.height - 36,
    };
    const imageCount = topic.images.length;
    const placedImages: OrganicPlacedImage[] = [];

    topic.images
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
      .forEach((image, imageIndex) => {
        const spiralAngle = imageIndex * 2.39996 + random() * 0.6;
        const spiralRadius = Math.sqrt((imageIndex + 0.5) / imageCount) * 0.46;
        const anchorX = centerX + Math.cos(spiralAngle) * contentRegion.width * spiralRadius;
        const anchorY = centerY + Math.sin(spiralAngle) * contentRegion.height * spiralRadius;
        const anchor = image.importance === "anchor" || (!image.importance && imageIndex % 7 === 0);
        const sizeVariation = anchor
          ? clampNumber(options.sizeRatio ?? 2.7, 2, 3.8) * (0.65 + random() * 0.15)
          : 0.64 + random() * 0.55;
        const safeWidth = Math.max(1, image.width);
        const safeHeight = Math.max(1, image.height);
        const nominal = Math.sqrt(contentRegion.width * contentRegion.height / imageCount) * 0.59;
        const baseScale = Math.min(1, nominal / Math.sqrt(safeWidth * safeHeight));
        let width = Math.max(72, safeWidth * baseScale * sizeVariation);
        let height = Math.max(54, safeHeight * baseScale * sizeVariation);
        const regionFit = Math.min(1, contentRegion.width / width, contentRegion.height / height);
        width *= regionFit;
        height *= regionFit;

        let position: LayoutRect | null = null;
        for (let shrink = 0; shrink < 18 && !position; shrink++) {
          position = findOrganicPosition(contentRegion, anchorX, anchorY, width, height, random, occupied);
          if (!position) {
            width *= 0.91;
            height *= 0.91;
          }
        }
        if (!position) {
          // The normal seeded scatter has ample room because the board grows with image count.
          // This deterministic lattice is a final safety net for pre-populated board regions.
          width = Math.min(width, 64);
          height = Math.min(height, 48);
          const step = IMAGE_GAP + 8;
          for (let y = contentRegion.y; y <= contentRegion.y + contentRegion.height - height && !position; y += step) {
            for (let x = contentRegion.x; x <= contentRegion.x + contentRegion.width - width; x += step) {
              const candidate = { x: x + random() * 3, y: y + random() * 3, width, height };
              if (candidateFits(candidate, contentRegion, occupied)) {
                position = candidate;
                break;
              }
            }
          }
        }
        if (!position) {
          throw new Error(`Could not place topic image ${image.id} without overlap`);
        }
        const rounded = {
          x: Math.round(position.x),
          y: Math.round(position.y),
          width: Math.max(1, Math.round(position.width)),
          height: Math.max(1, Math.round(position.height)),
        };
        occupied.push(rounded);
        placedImages.push({ ...image, ...rounded, topicId: topic.id, sizeVariation });
      });

    const imageBounds = boundingRect(placedImages);
    const labelHeight = clampNumber(region.height * 0.08, 58, 92);
    const estimatedTitleWidth = topic.title.length * labelHeight * 0.52 + 50;
    const labelWidth = clampNumber(estimatedTitleWidth, Math.min(200, region.width), region.width - 32);
    let label: LayoutRect | null = null;
    const boardRegion = { x: OUTER_MARGIN_X, y: OUTER_MARGIN_Y,
      width: options.boardWidth - 2 * OUTER_MARGIN_X, height: options.boardHeight - 2 * OUTER_MARGIN_Y };
    for (let attempt = 0; attempt < 180 && !label; attempt++) {
      const angle = -Math.PI / 2 + ((attempt * 0.61803398875) % 1) * Math.PI * 2;
      const radiusX = imageBounds.width * (0.4 + attempt / 180 * 0.2) + labelWidth * 0.55;
      const radiusY = imageBounds.height * (0.4 + attempt / 180 * 0.2) + labelHeight * 0.65;
      const candidate = {
        x: clampNumber(imageBounds.x + imageBounds.width / 2 + Math.cos(angle) * radiusX - labelWidth / 2,
          boardRegion.x, boardRegion.x + boardRegion.width - labelWidth),
        y: clampNumber(imageBounds.y + imageBounds.height / 2 + Math.sin(angle) * radiusY - labelHeight / 2,
          boardRegion.y, boardRegion.y + boardRegion.height - labelHeight),
        width: labelWidth, height: labelHeight,
      };
      if (candidateFits(candidate, boardRegion, occupied)) label = candidate;
    }
    if (!label) {
      label = findOrganicPosition(boardRegion, imageBounds.x + imageBounds.width / 2,
        imageBounds.y + imageBounds.height / 2, labelWidth, labelHeight, random, occupied)
        ?? { x: region.x, y: region.y, width: labelWidth, height: labelHeight };
    }
    occupied.push(label);
    return {
      id: topic.id,
      title: topic.title,
      startTime: topic.startTime,
      endTime: topic.endTime,
      region,
      label,
      images: placedImages,
      bounds: boundingRect([label, ...placedImages]),
    };
  });
}
