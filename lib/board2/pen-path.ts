// A freehand pen stroke as one continuous, smoothed path: it starts at the first point, curves
// through the midpoints between samples using each sample as the control point, and ends at the
// last point. One path (rather than a segment per sample) leaves no gaps between samples and no
// darker overlaps where a translucent stroke would cross itself at every joint.

type Point = { x: number; y: number };

export type PenPathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "Q"; cx: number; cy: number; x: number; y: number }
  | { op: "L"; x: number; y: number };

export function penPathCommands(points: readonly Point[]): PenPathCommand[] {
  if (points.length === 0) return [];
  const commands: PenPathCommand[] = [{ op: "M", x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], next = points[i + 1];
    commands.push({ op: "Q", cx: p.x, cy: p.y, x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 });
  }
  const last = points[points.length - 1];
  commands.push({ op: "L", x: last.x, y: last.y });
  return commands;
}

/** SVG `d` for a pen stroke, with every coordinate multiplied by `scale`. */
export function penSvgPath(points: readonly Point[], scale = 1): string {
  const n = (value: number) => Math.round(value * scale * 100) / 100;
  return penPathCommands(points).map((c) => c.op === "Q" ? `Q ${n(c.cx)} ${n(c.cy)} ${n(c.x)} ${n(c.y)}` : `${c.op} ${n(c.x)} ${n(c.y)}`).join(" ");
}

/** Adds a pen stroke to a canvas context's current path, mapping board points with `toX`/`toY`. */
export function tracePenPath(ctx: Pick<CanvasRenderingContext2D, "moveTo" | "quadraticCurveTo" | "lineTo">, points: readonly Point[], toX: (x: number) => number, toY: (y: number) => number): void {
  for (const c of penPathCommands(points)) {
    if (c.op === "M") ctx.moveTo(toX(c.x), toY(c.y));
    else if (c.op === "Q") ctx.quadraticCurveTo(toX(c.cx), toY(c.cy), toX(c.x), toY(c.y));
    else ctx.lineTo(toX(c.x), toY(c.y));
  }
}
