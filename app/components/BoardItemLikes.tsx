"use client";

import type { CSSProperties } from "react";
import shellStyles from "@/app/components/AppShell.module.css";
import { shellFont } from "@/app/components/shell-font";
import styles from "./BoardItemLikes.module.css";

const HEART_PATH = "M12 20.5s-7.6-4.5-9.6-9.3C1 7.9 3.1 4.5 6.6 4.5c2.2 0 3.9 1.2 5.4 3.1 1.5-1.9 3.2-3.1 5.4-3.1 3.5 0 5.6 3.4 4.2 6.7-2 4.8-9.6 9.3-9.6 9.3z";

/**
 * A shared-board item's likes: one small heart (filled once anyone likes it) and the count, tucked
 * into the item's corner. Faded until you like it. Without `onToggle` it's display only.
 */
export function BoardItemLikes({ count, mine, touch, itemName, onToggle, style }: {
  count: number;
  mine: boolean;
  touch: boolean;
  itemName: string;
  onToggle?: () => void;
  style?: CSSProperties;
}) {
  const summary = `${count} ${count === 1 ? "like" : "likes"}${mine ? ", including yours" : ""}`;
  const className = `${shellStyles.theme} ${shellFont.variable} ${styles.likes}${touch ? ` ${styles.touch}` : ""}`;
  const content = (
    <span className={styles.mark}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className={count > 0 ? styles.heartFilled : styles.heartEmpty}>
        <path d={HEART_PATH} />
      </svg>
      {count > 0 && <span className={styles.count}>{count}</span>}
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
