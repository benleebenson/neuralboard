export type CharacterTraversalMode = "cinematic" | "solid";

export type TerrainFootIK = {
  terrainGrounded: boolean;
  leftFootY: number;
  rightFootY: number;
};

/** Standard-board choreography never samples media as body collision geometry. */
export function resolveTerrainFootIK(
  traversalMode: CharacterTraversalMode,
  grounded: boolean,
  sampleSolidTerrainOffsets: () => readonly [number, number],
): TerrainFootIK {
  if (traversalMode === "cinematic" || !grounded) {
    return { terrainGrounded: false, leftFootY: 0, rightFootY: 0 };
  }
  const [leftFootY, rightFootY] = sampleSolidTerrainOffsets();
  return { terrainGrounded: true, leftFootY, rightFootY };
}
