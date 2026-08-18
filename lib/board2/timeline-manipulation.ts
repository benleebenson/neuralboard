export const MIN_TIMELINE_BLOCK_DURATION = 0.1;

export type TimelineManipulationBlock = {
  id: string;
  type: string;
  startTime: number;
  duration: number;
  layer?: number;
  sourceOffsetSec?: number;
  featured?: boolean;
};

export type TimelineManipulationDrag = {
  kind: "move" | "resize-left" | "resize-right";
  blockId: string;
  originalStartTime: number;
  originalDuration: number;
  originalLayer: number;
  originalSourceOffsetSec?: number;
};

type TimelineManipulationOptions = {
  deltaSeconds: number;
  targetLayer: number;
  playhead: number;
  snapThresholdSeconds: number;
  minimumDuration?: number;
};

const BOUNDARY_EPSILON = 0.000_001;

function magneticSnap(
  value: number,
  candidates: readonly number[],
  threshold: number,
): number {
  let result = value;
  let bestDistance = Math.max(0, threshold);
  for (const candidate of candidates) {
    const distance = Math.abs(value - candidate);
    if (distance < bestDistance) {
      result = candidate;
      bestDistance = distance;
    }
  }
  return result;
}

export function timelineLayerOverlap(
  blocks: readonly TimelineManipulationBlock[],
  startTime: number,
  duration: number,
  excludeId: string,
  layer: number,
): boolean {
  return blocks.some((block) =>
    block.featured !== false &&
    block.id !== excludeId &&
    block.type !== "narration" &&
    (block.layer ?? 1) === layer &&
    startTime < block.startTime + block.duration &&
    startTime + duration > block.startTime
  );
}

function snapTargets(
  blocks: readonly TimelineManipulationBlock[],
  excludeId: string,
  playhead?: number,
): number[] {
  return [
    0,
    ...(playhead === undefined ? [] : [playhead]),
    ...blocks.flatMap((block) => block.id === excludeId
      || block.featured === false
      ? []
      : [block.startTime, block.startTime + block.duration]),
  ];
}

function nextResizeBoundary(
  blocks: readonly TimelineManipulationBlock[],
  drag: TimelineManipulationDrag,
): number {
  const originalEnd = drag.originalStartTime + drag.originalDuration;
  return blocks
    .filter((block) =>
      block.featured !== false &&
      block.id !== drag.blockId &&
      block.type !== "narration" &&
      (block.layer ?? 1) === drag.originalLayer &&
      block.startTime >= originalEnd - BOUNDARY_EPSILON
    )
    .reduce((boundary, block) => Math.min(boundary, block.startTime), Infinity);
}

function previousResizeBoundary(
  blocks: readonly TimelineManipulationBlock[],
  drag: TimelineManipulationDrag,
): number {
  return blocks
    .filter((block) =>
      block.featured !== false &&
      block.id !== drag.blockId &&
      block.type !== "narration" &&
      (block.layer ?? 1) === drag.originalLayer &&
      block.startTime + block.duration <= drag.originalStartTime + BOUNDARY_EPSILON
    )
    .reduce((boundary, block) => Math.max(boundary, block.startTime + block.duration), 0);
}

/**
 * Applies one pointer-move update from an immutable drag-start snapshot.
 * `deltaSeconds` deliberately does not depend on the timeline's current scroll position:
 * resizing a rightmost block can change scrollWidth and clamp scrollLeft mid-gesture.
 */
export function applyTimelineBlockDrag<T extends TimelineManipulationBlock>(
  blocks: readonly T[],
  drag: TimelineManipulationDrag,
  options: TimelineManipulationOptions,
): T[] {
  const deltaSeconds = Number.isFinite(options.deltaSeconds) ? options.deltaSeconds : 0;
  const minimumDuration = Math.max(0.001, options.minimumDuration ?? MIN_TIMELINE_BLOCK_DURATION);
  const originalEnd = drag.originalStartTime + drag.originalDuration;
  // Existing blocks may snap to other clip edges and t=0, but never to the playhead. The
  // playhead is an insertion cursor; letting it participate in move snapping forces a newly
  // inserted block back to its original start during the first pixels of a drag.
  const targets = snapTargets(
    blocks,
    drag.blockId,
    drag.kind === "move" ? undefined : options.playhead,
  );

  return blocks.map((block) => {
    if (block.id !== drag.blockId) return block;

    if (drag.kind === "move") {
      const rawStart = Math.max(0, drag.originalStartTime + deltaSeconds);
      const snappedLeft = magneticSnap(rawStart, targets, options.snapThresholdSeconds);
      const snappedRight = magneticSnap(rawStart + drag.originalDuration, targets, options.snapThresholdSeconds);
      const leftSnapped = snappedLeft !== rawStart;
      const rightSnapped = snappedRight !== rawStart + drag.originalDuration;
      const startTime = Math.max(0, leftSnapped
        ? snappedLeft
        : rightSnapped
          ? snappedRight - drag.originalDuration
          : rawStart);

      if (block.type === "narration") return { ...block, startTime };
      if (!timelineLayerOverlap(blocks, startTime, drag.originalDuration, drag.blockId, options.targetLayer)) {
        return { ...block, startTime, layer: options.targetLayer };
      }
      if (options.targetLayer !== drag.originalLayer &&
          !timelineLayerOverlap(blocks, startTime, drag.originalDuration, drag.blockId, drag.originalLayer)) {
        return { ...block, startTime, layer: drag.originalLayer };
      }
      return block;
    }

    if (drag.kind === "resize-right") {
      const rawEnd = Math.max(drag.originalStartTime + minimumDuration, originalEnd + deltaSeconds);
      const snappedEnd = magneticSnap(rawEnd, targets, options.snapThresholdSeconds);
      const endTime = block.type === "narration"
        ? snappedEnd
        : Math.min(snappedEnd, nextResizeBoundary(blocks, drag));
      return {
        ...block,
        duration: Math.max(minimumDuration, endTime - drag.originalStartTime),
      };
    }

    const rawStart = Math.min(
      originalEnd - minimumDuration,
      Math.max(0, drag.originalStartTime + deltaSeconds),
    );
    const snappedStart = magneticSnap(rawStart, targets, options.snapThresholdSeconds);
    const boundedStart = Math.min(originalEnd - minimumDuration, Math.max(0, snappedStart));
    const startTime = block.type === "narration"
      ? boundedStart
      : Math.max(boundedStart, previousResizeBoundary(blocks, drag));
    return {
      ...block,
      startTime,
      duration: Math.max(minimumDuration, originalEnd - startTime),
      ...(block.type === "narration"
        ? { sourceOffsetSec: (drag.originalSourceOffsetSec ?? 0) + (startTime - drag.originalStartTime) }
        : {}),
    };
  });
}
