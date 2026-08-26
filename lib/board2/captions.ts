export const CAPTION_FADE_SECONDS = 0.15;

export type CaptionCue = {
  text: string;
  start: number;
  end: number;
};

export type CaptionFontSize = "small" | "medium" | "large";
export type CaptionPosition = "lower" | "upper";

type TranscriptSegment = {
  text: string;
  start: number;
  end: number;
};

export type CaptionLayout = {
  fontSizePx: number;
  centerY: number;
  maxWidth: number;
  lineHeight: number;
};

const FONT_SIZE_BY_NAME: Record<CaptionFontSize, number> = {
  small: 34 / 1080,
  medium: 44 / 1080,
  large: 56 / 1080,
};

function terminalPunctuation(word: string): boolean {
  return /[.!?…]["')\]]*$/.test(word);
}

function softPunctuation(word: string): boolean {
  return /[,;:]["')\]]*$/.test(word);
}

function balancedSizes(total: number): number[] {
  if (total <= 7) return [total];
  const groupCount = Math.ceil(total / 7);
  const base = Math.floor(total / groupCount);
  const extra = total % groupCount;
  return Array.from({ length: groupCount }, (_, index) => base + (index < extra ? 1 : 0));
}

function segmentPhraseRanges(words: string[]): Array<{ start: number; end: number }> {
  if (!words.length) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < words.length; index++) {
    const count = index - start + 1;
    const remaining = words.length - index - 1;
    const naturalBreak = count >= 3 && (terminalPunctuation(words[index]) || softPunctuation(words[index]));
    const safeNaturalBreak = naturalBreak && (remaining === 0 || remaining >= 3);
    const hardBreak = count === 7 && (remaining === 0 || remaining >= 3);
    if (safeNaturalBreak || hardBreak) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < words.length) {
    const remaining = words.length - start;
    if (remaining < 3 && ranges.length) {
      const previous = ranges.pop()!;
      const sizes = balancedSizes(words.length - previous.start);
      let cursor = previous.start;
      for (const size of sizes) {
        ranges.push({ start: cursor, end: cursor + size });
        cursor += size;
      }
    } else if (remaining > 7) {
      const sizes = balancedSizes(remaining);
      let cursor = start;
      for (const size of sizes) {
        ranges.push({ start: cursor, end: cursor + size });
        cursor += size;
      }
    } else {
      ranges.push({ start, end: words.length });
    }
  }
  return ranges;
}

/**
 * Whisper's existing endpoint returns segment timestamps, so phrase timing is interpolated
 * within each segment while its natural pause boundaries remain intact.
 */
export function buildPhraseCaptionTrack(
  segments: readonly TranscriptSegment[],
  timelineOffsetSeconds = 0,
): CaptionCue[] {
  return [...segments]
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .flatMap((segment) => {
      const words = segment.text.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const duration = segment.end - segment.start;
      return segmentPhraseRanges(words).map((range) => ({
        text: words.slice(range.start, range.end).join(" "),
        start: timelineOffsetSeconds + segment.start + duration * range.start / words.length,
        end: timelineOffsetSeconds + segment.start + duration * range.end / words.length,
      }));
    });
}

export function isCaptionTrack(value: unknown): value is CaptionCue[] {
  return Array.isArray(value) && value.every((cue) => {
    if (!cue || typeof cue !== "object") return false;
    const item = cue as Partial<CaptionCue>;
    return typeof item.text === "string" && item.text.trim().length > 0
      && typeof item.start === "number" && Number.isFinite(item.start)
      && typeof item.end === "number" && Number.isFinite(item.end)
      && item.end > item.start;
  });
}

export function captionOpacityAt(
  cue: CaptionCue,
  time: number,
  fadeSeconds = CAPTION_FADE_SECONDS,
): number {
  if (time < cue.start || time >= cue.end) return 0;
  const fade = Math.max(0.001, Math.min(fadeSeconds, (cue.end - cue.start) / 2));
  return Math.max(0, Math.min(1, (time - cue.start) / fade, (cue.end - time) / fade));
}

export function captionLayout(
  width: number,
  height: number,
  fontSize: CaptionFontSize,
  position: CaptionPosition,
): CaptionLayout {
  const portrait = height > width;
  const referenceEdge = Math.min(width, height);
  const fontSizePx = referenceEdge * FONT_SIZE_BY_NAME[fontSize];
  const centerY = height * (position === "lower"
    ? portrait ? 0.88 : 0.91
    : portrait ? 0.12 : 0.09);
  return {
    fontSizePx,
    centerY,
    maxWidth: width * (portrait ? 0.84 : 0.78),
    lineHeight: fontSizePx * 1.16,
  };
}

function wrapCaptionLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawScreenSpaceCaption(
  ctx: CanvasRenderingContext2D,
  time: number,
  track: readonly CaptionCue[],
  width: number,
  height: number,
  fontSize: CaptionFontSize,
  position: CaptionPosition,
): void {
  const cue = track.find((candidate) => time >= candidate.start && time < candidate.end);
  if (!cue) return;
  const opacity = captionOpacityAt(cue, time);
  if (opacity <= 0) return;
  const layout = captionLayout(width, height, fontSize, position);
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `600 ${layout.fontSizePx}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
  ctx.lineWidth = Math.max(2, layout.fontSizePx * 0.11);
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
  ctx.shadowBlur = layout.fontSizePx * 0.12;
  ctx.shadowOffsetY = layout.fontSizePx * 0.05;
  const lines = wrapCaptionLines(ctx, cue.text, layout.maxWidth);
  const firstY = layout.centerY - (lines.length - 1) * layout.lineHeight / 2;
  for (let index = 0; index < lines.length; index++) {
    const y = firstY + index * layout.lineHeight;
    ctx.strokeText(lines[index], width / 2, y, layout.maxWidth);
    ctx.fillText(lines[index], width / 2, y, layout.maxWidth);
  }
  ctx.restore();
}
