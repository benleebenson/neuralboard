"use client";

import type { CSSProperties } from "react";
import shellStyles from "@/app/components/AppShell.module.css";
import { shellFont } from "@/app/components/shell-font";
import styles from "./BoardItemLikes.module.css";

/** Hearts drawn before the rest become an overflow count ("+6"). */
export const MAX_SHOWN_HEARTS = 5;

const HEART_PATH = "M12 20.5s-7.6-4.5-9.6-9.3C1 7.9 3.1 4.5 6.6 4.5c2.2 0 3.9 1.2 5.4 3.1 1.5-1.9 3.2-3.1 5.4-3.1 3.5 0 5.6 3.4 4.2 6.7-2 4.8-9.6 9.3-9.6 9.3z";

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={filled ? styles.heartFilled : styles.heartEmpty}>
      <path d={HEART_PATH} />
    </svg>
  );
}

/**
 * A shared-board item's likes: one heart per like up to MAX_SHOWN_HEARTS, then "+N". `compact`
 * (for items too small on screen for a row of hearts) shows one heart and the number instead.
 * Without `onToggle` it's display only.
 */
export function BoardItemLikes({ count, mine, compact, touch, itemName, onToggle, style }: {
  count: number;
  mine: boolean;
  compact: boolean;
  touch: boolean;
  itemName: string;
  onToggle?: () => void;
  style?: CSSProperties;
}) {
  const hearts = count === 0 ? [false] : Array.from({ length: compact ? 1 : Math.min(count, MAX_SHOWN_HEARTS) }, () => true);
  const extra = compact ? (count > 0 ? String(count) : "") : count > MAX_SHOWN_HEARTS ? `+${count - MAX_SHOWN_HEARTS}` : "";
  const summary = `${count} ${count === 1 ? "like" : "likes"}${mine ? ", including yours" : ""}`;
  const className = `${shellStyles.theme} ${shellFont.variable} ${styles.likes}${touch ? ` ${styles.touch}` : ""}`;
  const content = (
    <span className={styles.pill}>
      {hearts.map((filled, index) => <Heart key={index} filled={filled} />)}
      {extra && <span className={styles.extra}>{extra}</span>}
    </span>
  );
  if (!onToggle) return <span role="img" aria-label={`${itemName}: ${summary}`} className={className} data-board-likes={count} style={style}>{content}</span>;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={mine}
      aria-label={`${mine ? "Unlike" : "Like"} ${itemName} (${summary})`}
      title={mine ? "You like this — tap to unlike" : "Like"}
      data-board-likes={count}
      data-board-liked={mine ? "true" : undefined}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
    >
      {content}
    </button>
  );
}
