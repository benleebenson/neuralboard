export type LayoutRect = { x: number; y: number; width: number; height: number };

export type OrganicLayoutImage = {
  id: string;
  width: number;
  height: number;
  startTime: number;
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
};

const OUTER_MARGIN_X = 140;
const OUTER_MARGIN_Y = 140;
const CLUSTER_GAP_X = 160;
const CLUSTER_GAP_Y = 190;
const IMAGE_GAP = 24;

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
  const occupied = [...(options.occupied ?? [])];
  const columns = topics.length === 1
    ? 1
    : Math.min(4, Math.ceil(Math.sqrt(topics.length * options.boardWidth / options.boardHeight)));
  const rows = Math.ceil(topics.length / columns);
  const cellWidth = (options.boardWidth - OUTER_MARGIN_X * 2 - CLUSTER_GAP_X * (columns - 1)) / columns;
  const cellHeight = (options.boardHeight - OUTER_MARGIN_Y * 2 - CLUSTER_GAP_Y * (rows - 1)) / rows;

  return topics.map((topic, topicIndex): OrganicPlacedTopic => {
    const column = topicIndex % columns;
    const row = Math.floor(topicIndex / columns);
    const region: LayoutRect = {
      x: OUTER_MARGIN_X + column * (cellWidth + CLUSTER_GAP_X),
      y: OUTER_MARGIN_Y + row * (cellHeight + CLUSTER_GAP_Y),
      width: cellWidth,
      height: cellHeight,
    };
    const titleZoneHeight = clampNumber(cellHeight * 0.16, 76, 116);
    const contentRegion: LayoutRect = {
      x: region.x + 24,
      y: region.y + titleZoneHeight,
      width: region.width - 48,
      height: region.height - titleZoneHeight - 28,
    };
    const imageCount = topic.images.length;
    const slotColumns = Math.max(1, Math.min(imageCount, Math.ceil(Math.sqrt(imageCount * contentRegion.width / contentRegion.height))));
    const slotRows = Math.ceil(imageCount / slotColumns);
    const slotWidth = contentRegion.width / slotColumns;
    const slotHeight = contentRegion.height / slotRows;
    const placedImages: OrganicPlacedImage[] = [];

    topic.images
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
      .forEach((image, imageIndex) => {
        const slotColumn = imageIndex % slotColumns;
        const slotRow = Math.floor(imageIndex / slotColumns);
        const anchorX = contentRegion.x + (slotColumn + 0.5) * slotWidth + (random() - 0.5) * slotWidth * 0.24;
        const anchorY = contentRegion.y + (slotRow + 0.5) * slotHeight + (random() - 0.5) * slotHeight * 0.22;
        const sizeVariation = 0.8 + random() * 0.4;
        const safeWidth = Math.max(1, image.width);
        const safeHeight = Math.max(1, image.height);
        const baseScale = Math.min(1, slotWidth * 0.76 / safeWidth, slotHeight * 0.72 / safeHeight);
        let width = Math.max(72, safeWidth * baseScale * sizeVariation);
        let height = Math.max(54, safeHeight * baseScale * sizeVariation);
        const regionFit = Math.min(1, contentRegion.width / width, contentRegion.height / height);
        width *= regionFit;
        height *= regionFit;

        let position: LayoutRect | null = null;
        for (let shrink = 0; shrink < 12 && !position; shrink++) {
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
              const candidate = { x, y, width, height };
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
    const labelHeight = clampNumber(titleZoneHeight - 18, 58, 92);
    const estimatedTitleWidth = topic.title.length * labelHeight * 0.52 + 50;
    const labelWidth = clampNumber(estimatedTitleWidth, Math.min(260, region.width), region.width - 32);
    const label: LayoutRect = {
      x: clampNumber(imageBounds.x + imageBounds.width / 2 - labelWidth / 2, region.x + 16, region.x + region.width - labelWidth - 16),
      y: region.y + Math.max(0, (titleZoneHeight - labelHeight - 12) / 2),
      width: labelWidth,
      height: labelHeight,
    };
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
