export const ANNOTATION_LINE_HEIGHT = 1.2;

export type AnnotationTextMeasurer = (text: string) => number;

/**
 * Canonical annotation wrapping in board-space units.
 *
 * The editor and canvas renderer both call this function with the same font and
 * stored annotation width, so zoom only scales the finished layout. Explicit
 * newlines always create a line, including blank lines.
 */
export function layoutAnnotationText(
  text: string,
  maxWidth: number,
  measureText: AnnotationTextMeasurer,
): string[] {
  const safeWidth = Number.isFinite(maxWidth) ? Math.max(0, maxWidth) : 0;
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    const words = paragraph.trim().split(/[\t ]+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = words[0];
    for (let index = 1; index < words.length; index++) {
      const candidate = `${line} ${words[index]}`;
      if (line && measureText(candidate) > safeWidth) {
        lines.push(line);
        line = words[index];
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

export function annotationFontCss(
  fontSize: number,
  fontFamily: string,
  fontWeight: "normal" | "bold",
): string {
  return `${fontWeight} ${fontSize}px '${fontFamily}', cursive`;
}
