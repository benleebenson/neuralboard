import { organicLayoutRectsOverlap, type LayoutRect } from "./organic-topic-layout.ts";

// Where an imported board lands. The imported set moves as one block (its own arrangement,
// overlaps included, is kept exactly), so only its bounding box is placed: at the free spot that
// keeps the board most compact. Candidate spots sit flush (plus gap) against a side of an existing
// item, aligned with that item or with the content's edge, so the search is O(items²) even on
// boards with hundreds of zoom boxes.

export type ImportPlacementOptions = {
  /** Size of the imported set's bounding box, already scaled. */
  group: { width: number; height: number };
  /** Everything already on the board. */
  occupied: readonly LayoutRect[];
  /** Clear space kept between the imported block and existing items. */
  gap: number;
  /**
   * The board's current size. With `canGrow` the block may extend past it to the right and down
   * (the board then grows to fit); without, it must fit inside.
   */
  board: { width: number; height: number };
  canGrow: boolean;
};

export function importContentBounds(rects: readonly LayoutRect[]): LayoutRect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Top-left corner for the imported block, or null when it can't go anywhere without overlapping
 * (only possible when the board can't grow). An empty board puts it at the gap from the corner.
 */
export function findImportPlacement({ group, occupied, gap, board, canGrow }: ImportPlacementOptions): { x: number; y: number } | null {
  const fits = (x: number, y: number) =>
    x >= 0 && y >= 0 && (canGrow || (x + group.width <= board.width && y + group.height <= board.height));
  const content = importContentBounds(occupied);
  if (!content) return fits(gap, gap) ? { x: gap, y: gap } : null;

  const right = content.x + content.width;
  const bottom = content.y + content.height;
  const spots: Array<{ x: number; y: number }> = [
    // Right of and below everything: always free, and the only spots when the board is packed.
    { x: right + gap, y: content.y },
    { x: content.x, y: bottom + gap },
  ];
  for (const rect of occupied) {
    const after = { x: rect.x + rect.width + gap, y: rect.y + rect.height + gap };
    const before = { x: rect.x - gap - group.width, y: rect.y - gap - group.height };
    spots.push(
      { x: after.x, y: rect.y }, { x: after.x, y: content.y }, { x: after.x, y: bottom - group.height },
      { x: before.x, y: rect.y }, { x: before.x, y: content.y },
      { x: rect.x, y: after.y }, { x: content.x, y: after.y }, { x: right - group.width, y: after.y },
      { x: rect.x, y: before.y }, { x: content.x, y: before.y },
    );
  }

  const scored = spots
    .map((spot) => ({ x: Math.round(spot.x), y: Math.round(spot.y) }))
    .filter((spot) => fits(spot.x, spot.y))
    .map((spot) => {
      const unionWidth = Math.max(right, spot.x + group.width) - Math.min(content.x, spot.x);
      const unionHeight = Math.max(bottom, spot.y + group.height) - Math.min(content.y, spot.y);
      // Smallest combined footprint first; the distance term breaks ties toward the content's
      // top-right, so an import reads as "next to" what's there.
      return { ...spot, score: unionWidth * unionHeight + Math.hypot(spot.x - right, spot.y - content.y) };
    })
    .sort((a, b) => a.score - b.score);
  for (const spot of scored) {
    const rect = { x: spot.x, y: spot.y, width: group.width, height: group.height };
    if (!occupied.some((other) => organicLayoutRectsOverlap(rect, other, gap))) return { x: spot.x, y: spot.y };
  }
  return null;
}
