export type BazookaCharacterTarget = {
  role: "host" | "guest";
  guestId?: string;
  center: { x: number; y: number };
  radius?: number;
};

export type BazookaCharacterHit = BazookaCharacterTarget & {
  point: { x: number; y: number };
  distance: number;
};

const DEFAULT_CHARACTER_HIT_RADIUS = 58;
export const HOST_BAZOOKA_MAX_HEALTH = 10;
export const GUEST_BAZOOKA_MAX_HEALTH = 3;
export const BAZOOKA_RAGDOLL_RECOVERY_MS = 900;
export const BAZOOKA_RAGDOLL_GROUND_DRAG = 12;

export function bazookaShotKey(event: {
  shotId?: string;
  sessionId: string;
  startTime: number;
  seed: number;
}): string {
  return event.shotId ?? `${event.sessionId}:${event.startTime}:${event.seed}`;
}

export function firstBazookaCharacterHit(
  from: { x: number; y: number },
  to: { x: number; y: number },
  targets: readonly BazookaCharacterTarget[],
): BazookaCharacterHit | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.0001) return null;
  const length = Math.sqrt(lengthSquared);
  let best: BazookaCharacterHit | null = null;

  for (const target of targets) {
    const radius = target.radius ?? DEFAULT_CHARACTER_HIT_RADIUS;
    const offsetX = from.x - target.center.x;
    const offsetY = from.y - target.center.y;
    const b = 2 * (offsetX * dx + offsetY * dy);
    const c = offsetX * offsetX + offsetY * offsetY - radius * radius;
    const discriminant = b * b - 4 * lengthSquared * c;
    if (discriminant < 0) continue;
    const root = Math.sqrt(discriminant);
    const entry = (-b - root) / (2 * lengthSquared);
    const exit = (-b + root) / (2 * lengthSquared);
    const t = entry >= 0 && entry <= 1 ? entry : exit >= 0 && exit <= 1 ? 0 : null;
    if (t === null) continue;
    const distance = t * length;
    if (best && best.distance <= distance) continue;
    best = {
      ...target,
      point: { x: from.x + dx * t, y: from.y + dy * t },
      distance,
    };
  }

  return best;
}

export function bazookaRagdollImpulse(
  direction: { x: number; y: number },
  seed: number,
): { x: number; y: number; spin: number } {
  const length = Math.max(0.001, Math.hypot(direction.x, direction.y));
  const x = direction.x / length;
  const y = direction.y / length;
  const spinDirection = Math.abs(x) > 0.08 ? Math.sign(x) : seed % 2 === 0 ? 1 : -1;
  return {
    x: x * 820,
    y: Math.max(-850, Math.min(-280, y * 480 - 520)),
    spin: spinDirection * (7.5 + (seed % 7) * 0.35),
  };
}

export function nextBazookaHealth(
  current: number,
  max: number,
  hitAt: number,
): { current: number; max: number; hitAt: number } {
  return {
    current: Math.max(0, Math.min(max, current) - 1),
    max,
    hitAt,
  };
}

export function combatHealthColor(current: number, max: number): string {
  const ratio = Math.max(0, Math.min(1, current / Math.max(1, max)));
  return `hsl(${Math.round(ratio * 120)} 78% 42%)`;
}
