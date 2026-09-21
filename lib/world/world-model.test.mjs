import test from "node:test";
import assert from "node:assert/strict";
import {
  REGION_CLEARANCE, REGION_MIN_HEIGHT, REGION_MIN_WIDTH, STAGING_COLUMNS,
  buildRegion, createEmptyWorld, createRegion, diffItemMoves, emptyRegionManifest, generateFarLod, growRegionBounds,
  itemSelectionKey, moveSelectedItems, moveSelectedRegions, parseWorld, projectWorldSize, rectsOverlap, regionSelectionKey,
  serializeWorld, stagingPlacement, translateManifestItems, validateRegionPlacement, visibleRegions, worldMediaPlacements,
} from "./world-model.ts";

const W = REGION_MIN_WIDTH;
const H = REGION_MIN_HEIGHT;
const hash = (n) => (n * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(4);

function regionWith(name, bounds, items = []) {
  const assets = items.map((_, index) => ({ archivePath: `assets/${name}_${index}.jpg`, file: `${hash(index + name.length * 100)}.jpg`, preview: true, mime: "image/jpeg", bytes: 1000 }));
  const manifest = emptyRegionManifest(name, bounds);
  manifest.board.media = items.map((item, index) => ({ id: `${name}_m${index}`, type: "image", assetFile: assets[index].archivePath, boardX: item.x, boardY: item.y, boardW: item.w ?? 380, boardH: item.h ?? 300 }));
  return buildRegion({ regionId: `region_${name}`, name, bounds, manifest, assets }).region;
}

function worldOf(...regions) {
  return { ...createEmptyWorld(), regions };
}

test("regions are never smaller than one editor board, and never overlap", () => {
  const world = worldOf(regionWith("a", { x: 0, y: 0, width: W, height: H }));
  assert.match(validateRegionPlacement(world, { x: 9000, y: 0, width: 1000, height: 800 }), /at least/);
  assert.match(validateRegionPlacement(world, { x: 100, y: 100, width: W, height: H }), /overlap/);
  // Inside the clearance margin still counts as overlapping; just outside does not.
  assert.ok(validateRegionPlacement(world, { x: W + REGION_CLEARANCE - 1, y: 0, width: W, height: H }));
  assert.equal(validateRegionPlacement(world, { x: W + REGION_CLEARANCE, y: 0, width: W, height: H }), null);
  assert.throws(() => createRegion(world, "overlaps", { x: 10, y: 10, width: W, height: H }), /overlap/);
  const created = createRegion(world, "fine", { x: W + 500, y: 0, width: W, height: H });
  assert.equal(created.world.regions.length, 2);
  assert.equal(created.file.manifest.board.dimensions.width, W);
});

test("staging strip: first import in an empty world, then row-wise fill that wraps", () => {
  let world = createEmptyWorld();
  const placed = [];
  for (let index = 0; index < STAGING_COLUMNS * 2 + 1; index += 1) {
    const { bounds, origin } = stagingPlacement(world, W, H);
    world = { ...world, staging: origin, regions: [...world.regions, regionWith(`s${index}`, bounds)] };
    placed.push(bounds);
  }
  assert.deepEqual(placed[0], { x: 0, y: 0, width: W, height: H });
  assert.equal(new Set(placed.slice(0, STAGING_COLUMNS).map((rect) => rect.y)).size, 1, "first row shares a y");
  assert.ok(placed[STAGING_COLUMNS].y > placed[0].y, "the next import wraps to a new row");
  assert.equal(placed[STAGING_COLUMNS].x, 0);
  assert.equal(placed.length, STAGING_COLUMNS * 2 + 1);
});

test("imports never overlap existing work, wherever it was dragged", () => {
  // Existing content, plus a region the user dragged right into the middle of the strip's first row.
  let world = worldOf(regionWith("home", { x: 0, y: 0, width: W, height: H }), regionWith("far", { x: 20000, y: -9000, width: W, height: H }));
  const first = stagingPlacement(world, W, H);
  world = { ...world, staging: first.origin };
  world = { ...world, regions: [...world.regions, regionWith("dragged", { x: first.origin.x + W + 1200, y: first.origin.y - 500, width: W, height: H })] };
  for (let index = 0; index < 40; index += 1) {
    const { bounds } = stagingPlacement(world, index % 3 ? W : W + 1500, index % 2 ? H : H + 900);
    for (const region of world.regions) assert.equal(rectsOverlap(region.bounds, bounds, REGION_CLEARANCE), false, `import ${index} overlaps ${region.name}`);
    world = { ...world, regions: [...world.regions, regionWith(`imp${index}`, bounds)] };
  }
  assert.equal(world.regions.length, 43);
  // Old content is untouched.
  assert.deepEqual(world.regions[0].bounds, { x: 0, y: 0, width: W, height: H });
});

test("the staging origin is stable: it does not drift as imports accumulate", () => {
  let world = worldOf(regionWith("home", { x: 0, y: 0, width: W, height: H }));
  const first = stagingPlacement(world, W, H);
  world = { ...world, staging: first.origin, regions: [...world.regions, regionWith("one", first.bounds)] };
  assert.deepEqual(stagingPlacement(world, W, H).origin, first.origin);
  assert.equal(first.origin.y, H + 800);
});

test("moving a selection of regions moves them as a unit with contents, and refuses overlap", () => {
  const a = regionWith("a", { x: 0, y: 0, width: W, height: H }, [{ x: 100, y: 100 }]);
  const b = regionWith("b", { x: W + 1000, y: 0, width: W, height: H }, [{ x: 300, y: 300 }]);
  const c = regionWith("c", { x: 0, y: H + 1000, width: W, height: H });
  const world = worldOf(a, b, c);
  const selection = new Set([regionSelectionKey(a.id), regionSelectionKey(b.id)]);
  const moved = moveSelectedRegions(world, selection, 0, -5000);
  assert.deepEqual(moved.regions[0].bounds, { x: 0, y: -5000, width: W, height: H });
  assert.deepEqual(moved.regions[1].bounds, { x: W + 1000, y: -5000, width: W, height: H });
  assert.deepEqual(moved.regions[2].bounds, c.bounds, "unselected regions stay");
  // Board-local item positions are unchanged: contents travel with the region.
  assert.equal(moved.regions[0].lod.media[0].x, 100);
  // Dragging onto an unselected region is refused: the world comes back unchanged.
  assert.equal(moveSelectedRegions(world, selection, 0, H + 1000), world);
  // The same selection can be moved again later.
  assert.deepEqual(moveSelectedRegions(moved, selection, 700, 0).regions[0].bounds, { x: 700, y: -5000, width: W, height: H });
});

test("moving selected items updates placements, LOD fingerprint and, via diff, the manifest", () => {
  const region = regionWith("a", { x: 0, y: 0, width: W, height: H }, [{ x: 100, y: 100 }, { x: 900, y: 100 }]);
  const world = worldOf(region);
  const selection = new Set([itemSelectionKey(region.id, "a_m0")]);
  const moved = moveSelectedItems(world, selection, 250, 40);
  assert.deepEqual([moved.regions[0].lod.media[0].x, moved.regions[0].lod.media[0].y], [350, 140]);
  assert.equal(moved.regions[0].lod.media[1].x, 900);
  assert.notEqual(moved.regions[0].lod.contentFingerprint, region.lod.contentFingerprint);
  const moves = diffItemMoves(world, moved);
  assert.deepEqual([...moves.get(region.id)], [["a_m0", { dx: 250, dy: 40 }]]);
  const manifest = emptyRegionManifest("a", region.bounds);
  manifest.board.media = [{ id: "a_m0", boardX: 100, boardY: 100 }, { id: "a_m1", boardX: 900, boardY: 100 }];
  const next = translateManifestItems(manifest, moves.get(region.id));
  assert.deepEqual([next.board.media[0].boardX, next.board.media[0].boardY, next.board.media[1].boardX], [350, 140, 900]);
  assert.equal(manifest.board.media[0].boardX, 100, "input manifest is not mutated");
});

test("items cannot be dragged out of their region, and a group keeps its shape against an edge", () => {
  const region = regionWith("a", { x: 0, y: 0, width: W, height: H }, [{ x: 100, y: 100 }, { x: 600, y: 100 }]);
  const both = new Set([itemSelectionKey(region.id, "a_m0"), itemSelectionKey(region.id, "a_m1")]);
  const left = moveSelectedItems(worldOf(region), both, -5000, 0).regions[0].lod.media;
  assert.deepEqual(left.map((item) => item.x), [0, 500], "stops at the left edge, spacing preserved");
  const right = moveSelectedItems(worldOf(region), both, 99999, 99999).regions[0].lod.media;
  assert.equal(right[1].x + right[1].width, W);
  assert.equal(right[1].y + right[1].height, H);
  assert.equal(right[1].x - right[0].x, 500);
});

test("far LOD follows the real footprint and is denser where content is concentrated", () => {
  const cluster = [];
  for (let index = 0; index < 12; index += 1) cluster.push({ x: 100 + (index % 4) * 60, y: 100 + Math.floor(index / 4) * 60, w: 300, h: 250 });
  const region = regionWith("dense", { x: 0, y: 0, width: W, height: H }, [...cluster, { x: 3500, y: 2600 }]);
  const far = region.lod.far;
  assert.equal(far.density.length, far.cols * far.rows);
  const cellW = far.extentWidth / far.cols;
  const cellH = far.extentHeight / far.rows;
  const at = (x, y) => far.density[Math.floor(y / cellH) * far.cols + Math.floor(x / cellW)];
  assert.ok(at(250, 250) > at(3600, 2700), "the cluster is denser than the lone image");
  assert.equal(at(2000, 1500), 0, "empty space between them has no ink");
  assert.equal(generateFarLod([]).density.every((value) => value === 0), true);
});

test("the content fingerprint changes only when contents change", () => {
  const a = regionWith("a", { x: 0, y: 0, width: W, height: H }, [{ x: 100, y: 100 }]);
  const same = regionWith("a", { x: 5000, y: 5000, width: W, height: H }, [{ x: 100, y: 100 }]);
  const changed = regionWith("a", { x: 0, y: 0, width: W, height: H }, [{ x: 101, y: 100 }]);
  assert.equal(a.lod.contentFingerprint, same.lod.contentFingerprint, "moving the region in the world is not a content change");
  assert.notEqual(a.lod.contentFingerprint, changed.lod.contentFingerprint);
});

test("growing a region to fit its board is refused when it would touch a neighbour", () => {
  const a = regionWith("a", { x: 0, y: 0, width: W, height: H });
  const roomy = worldOf(a);
  assert.deepEqual(growRegionBounds(roomy, a, { width: W + 2000, height: H }), { x: 0, y: 0, width: W + 2000, height: H });
  const b = regionWith("b", { x: W + 500, y: 0, width: W, height: H });
  assert.deepEqual(growRegionBounds(worldOf(a, b), a, { width: W + 2000, height: H }), a.bounds);
  assert.equal(growRegionBounds(roomy, a, { width: W, height: H }), a.bounds);
});

test("culling returns only regions that intersect the viewport", () => {
  const regions = Array.from({ length: 60 }, (_, index) => regionWith(`r${index}`, { x: (index % 10) * (W + 800), y: Math.floor(index / 10) * (H + 800), width: W, height: H }));
  const world = worldOf(...regions);
  const visible = visibleRegions(world, { x: 0, y: 0, width: 2 * W, height: H });
  assert.deepEqual(visible.map((region) => region.name).sort(), ["r0", "r1"]);
});

test("worldMediaPlacements keeps images and videos as references, drops everything else", () => {
  const assets = [{ archivePath: "assets/a.jpg", file: `${hash(1)}.jpg`, preview: true, mime: "image/jpeg", bytes: 1 }];
  const manifest = { board: { media: [
    { id: "i", type: "image", assetFile: "assets/a.jpg", boardX: 1, boardY: 2, boardW: 3, boardH: 4 },
    { id: "n", type: "narration" },
  ] } };
  const placements = worldMediaPlacements(manifest, assets);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].asset, assets[0].file);
});

test("a world file never carries media bytes", () => {
  const region = regionWith("a", { x: 0, y: 0, width: W, height: H });
  const world = worldOf(region);
  assert.equal(parseWorld(serializeWorld(world)).regions.length, 1);
  assert.throws(() => parseWorld(JSON.stringify({ ...world, schemaVersion: 1 })), /schema 1/);
  assert.doesNotThrow(() => parseWorld(serializeWorld({ ...world, staging: { x: 1, y: 2 } })));
  assert.throws(() => parseWorld(JSON.stringify({ ...world, staging: { x: "no", y: 2 } })), /staging/);
});

test("projected size: 50 regions x 40 images keeps the JSON around a megabyte while originals stay outside", () => {
  const size = projectWorldSize(50, 40);
  assert.ok(size.indexBytes < 1_000_000, `index ${size.indexBytes}`);
  assert.ok(size.regionFileBytes < 2_000_000, `region files ${size.regionFileBytes}`);
  assert.ok(size.assetBytes > 1e9, "originals are the bulk, and none of it is in JSON");
  console.log("projected 50x40:", JSON.stringify(size));
});
