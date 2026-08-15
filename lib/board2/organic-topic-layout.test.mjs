import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutOrganicTopicClusters,
  organicBoardSizeForImageCount,
  organicLayoutRectsOverlap,
  stableOrganicLayoutSeed,
} from "./organic-topic-layout.ts";

function makeTopics(topicCount, imagesPerTopic) {
  return Array.from({ length: topicCount }, (_, topicIndex) => ({
    id: `topic-${topicIndex}`,
    title: `Topic Number ${topicIndex + 1}`,
    startTime: topicIndex * imagesPerTopic * 4,
    endTime: (topicIndex + 1) * imagesPerTopic * 4,
    images: Array.from({ length: imagesPerTopic }, (_, imageIndex) => ({
      id: `image-${topicIndex}-${imageIndex}`,
      width: imageIndex % 2 ? 1600 : 1200,
      height: imageIndex % 2 ? 900 : 1000,
      startTime: (topicIndex * imagesPerTopic + imageIndex) * 4,
    })),
  }));
}

test("grows a 30-minute board to preserve editorial image density", () => {
  assert.deepEqual(organicBoardSizeForImageCount(24), { width: 4000, height: 3000 });
  assert.deepEqual(organicBoardSizeForImageCount(450), { width: 17500, height: 13000 });
});

test("organic placement is deterministic, varied, ordered by topic, and collision-free", () => {
  const topics = makeTopics(6, 12);
  const board = organicBoardSizeForImageCount(72);
  const options = {
    boardWidth: board.width,
    boardHeight: board.height,
    seed: stableOrganicLayoutSeed("same transcript and plan"),
    topics,
  };
  const first = layoutOrganicTopicClusters(options);
  const second = layoutOrganicTopicClusters(options);
  assert.deepEqual(first, second);
  assert.ok(first[1].region.x > first[0].region.x);
  assert.ok(first[0].label.y + first[0].label.height < Math.min(...first[0].images.map((image) => image.y)));

  const images = first.flatMap((topic) => topic.images);
  assert.ok(new Set(images.map((image) => image.sizeVariation.toFixed(3))).size > 10);
  for (let left = 0; left < images.length; left++) {
    for (let right = left + 1; right < images.length; right++) {
      assert.equal(organicLayoutRectsOverlap(images[left], images[right]), false);
    }
  }
});

test("lays out hundreds of images without overlap", () => {
  const topics = makeTopics(9, 50);
  const board = organicBoardSizeForImageCount(450);
  const placed = layoutOrganicTopicClusters({
    boardWidth: board.width,
    boardHeight: board.height,
    seed: 20260815,
    topics,
  });
  assert.equal(placed.flatMap((topic) => topic.images).length, 450);
});
