"use client";

import type { CSSProperties } from "react";
import shellStyles from "@/app/components/AppShell.module.css";
import { shellFont } from "@/app/components/shell-font";
import styles from "./BoardItemLikes.module.css";

const HEART_PATH = "M12 20.5s-7.6-4.5-9.6-9.3C1 7.9 3.1 4.5 6.6 4.5c2.2 0 3.9 1.2 5.4 3.1 1.5-1.9 3.2-3.1 5.4-3.1 3.5 0 5.6 3.4 4.2 6.7-2 4.8-9.6 9.3-9.6 9.3z";

function Heart() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={HEART_PATH} />
    </svg>
  );
}

/**
 * A shared-board item's likes, as votes showed on the original boards' notes: a small count pill
 * beside the like button (a heart here, not the original's "+"). `onNote` puts it on a sticky note,
 * in the row below its text, sized in ems of the note's font (the caller sets `fontSize`), so it
 * scales with the note; otherwise it's a small white pill hanging under the item. Only the heart is
 * a button (its hit area is 28px, 44px on touch screens); without `onToggle` it's display only.
 */
export function BoardItemLikes({ count, mine, onNote = false, touch, itemName, onToggle, style }: {
  count: number;
  mine: boolean;
  onNote?: boolean;
  touch: boolean;
  itemName: string;
  onToggle?: () => void;
  style?: CSSProperties;
}) {
  const summary = `${count} ${count === 1 ? "like" : "likes"}${mine ? ", including yours" : ""}`;
  const className = `${shellStyles.theme} ${shellFont.variable} ${styles.likes} ${onNote ? styles.onNote : styles.under}${touch ? ` ${styles.touch}` : ""}`;
  const countPill = <span className={styles.count} aria-hidden="true">{count}</span>;
  if (!onToggle) {
    return (
      <span role="img" aria-label={`${itemName}: ${summary}`} className={className} data-board-likes={count} data-board-liked={mine ? "true" : undefined} style={style}>
        {countPill}
        <span className={styles.heart} data-mine={mine ? "true" : undefined}><Heart /></span>
      </span>
    );
  }
  return (
    <span
      className={className}
      data-board-likes={count}
      data-board-liked={mine ? "true" : undefined}
      style={style}
      // Under an item, the whole pill is likes chrome, so it doesn't start a pan or deselect; on a
      // note, only the heart is (the rest of the row is the note).
      onPointerDown={onNote ? undefined : (event) => event.stopPropagation()}
    >
      {countPill}
      <button
        type="button"
        className={styles.heart}
        aria-pressed={mine}
        aria-label={`${mine ? "Unlike" : "Like"} ${itemName} (${summary})`}
        title={mine ? "You like this — tap to unlike" : "Like"}
        data-mine={mine ? "true" : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onToggle(); }}
      >
        <Heart />
      </button>
    </span>
  );
}
