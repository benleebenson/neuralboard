export type GroundedQuery = {
  actionType?: string;
  progress?: number;
  explicitGrounded?: boolean;
  skateAirborne?: boolean;
  grappleAirborne?: boolean;
  airY?: number;
};

const FULLY_AIRBORNE_ACTIONS = new Set([
  "flip",
  "jump",
  "jumpTo",
  "arcJump",
  "zipline",
  "wallClimb",
  "forceChoke",
  "eliminated",
  "punchThroughFall",
]);

/** Single authority deciding whether terrain may influence the root or leg chains. */
export function isGrounded(query: GroundedQuery): boolean {
  if (query.explicitGrounded === false) return false;
  if (FULLY_AIRBORNE_ACTIONS.has(query.actionType ?? "")) return false;
  if (query.actionType === "grapple" && (query.grappleAirborne ?? true)) return false;
  if (query.actionType === "skateTo" && query.skateAirborne) return false;
  if (Math.abs(query.airY ?? 0) > 0.001) return false;
  return query.explicitGrounded ?? true;
}
