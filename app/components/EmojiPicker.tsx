"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import shellStyles from "@/app/components/AppShell.module.css";
import { shellFont } from "@/app/components/shell-font";
import styles from "./EmojiPicker.module.css";

type EmojiGroup = { label: string; emoji: ReadonlyArray<readonly [string, string]> };

const RECENT_EMOJI_STORAGE_KEY = "nb_recent_emoji";
const RECENT_EMOJI_MAX = 24;

const GROUP_ICONS: Record<string, string> = {
  "Smileys & emotion": "😀", "People & body": "👋", "Animals & nature": "🐻", "Food & drink": "🍔",
  "Travel & places": "✈️", "Activities": "⚽", "Objects": "💡", "Symbols": "❤️", "Flags": "🏁",
};

// Everyday words the CLDR names don't contain.
const EMOJI_ALIASES: Record<string, string> = {
  "😂": "lol haha laugh", "🤣": "lol rofl haha laugh", "😭": "cry sad", "😢": "cry sad", "😍": "love heart eyes",
  "🥰": "love", "😘": "kiss love", "😎": "cool", "🤔": "think hmm", "🙄": "eyeroll", "😡": "angry mad",
  "🤯": "mind blown", "😱": "shock scream", "😴": "sleep tired", "💀": "dead skull lol", "🔥": "fire lit hot",
  "💯": "hundred 100 perfect", "👍": "thumbs up yes ok like", "👎": "thumbs down no dislike", "👏": "clap applause",
  "🙏": "pray please thanks", "🎉": "party celebrate tada", "✅": "check yes done", "❌": "x no wrong",
  "❗": "important exclamation", "❓": "question", "💡": "idea", "⭐": "star", "✨": "sparkle magic",
  "🚀": "rocket launch", "📈": "chart up growth stonks", "📉": "chart down", "💰": "money cash", "👀": "eyes look",
  "❤️": "love heart", "💔": "heartbreak", "🤝": "deal handshake", "🫡": "salute", "🤡": "clown",
  "🐐": "goat best", "🧢": "cap lie", "🎯": "target goal", "⚠️": "warning", "📌": "pin", "🏆": "trophy win",
};

let emojiGroupsPromise: Promise<ReadonlyArray<EmojiGroup>> | null = null;
function loadEmojiGroups(): Promise<ReadonlyArray<EmojiGroup>> {
  emojiGroupsPromise ??= import("@/lib/board2/emoji-data").then((module) => module.EMOJI_GROUPS);
  return emojiGroupsPromise;
}

function readRecentEmoji(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_EMOJI_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_EMOJI_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...readRecentEmoji().filter((item) => item !== emoji)].slice(0, RECENT_EMOJI_MAX);
  try { window.localStorage.setItem(RECENT_EMOJI_STORAGE_KEY, JSON.stringify(next)); } catch {}
  return next;
}

/**
 * Full emoji picker in the app-shell look: a pinned recently-used row, search, and every
 * standard emoji by category. Arrow keys move between emoji, Enter picks, Escape closes.
 * Rendered in a portal so the board's overflow can't clip it; on desktop it drops below the
 * element it is rendered inside, kept within the viewport.
 */
export function EmojiPicker({ selected, compact, onPick, onClose }: {
  selected?: string;
  compact: boolean; // phones: a bottom sheet with 44px targets
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<ReadonlyArray<EmojiGroup> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  // Mounted only after a click, never during SSR, so storage can be read up front.
  const [recent, setRecent] = useState<string[]>(readRecentEmoji);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (compact) return;
    const place = () => {
      const root = rootRef.current;
      const anchor = anchorRef.current?.parentElement;
      if (!root || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const gutter = 16;
      const width = Math.min(360, window.innerWidth - gutter * 2);
      const below = window.innerHeight - rect.bottom - 8 - gutter;
      const above = rect.top - 8 - gutter;
      const openUp = below < 280 && above > below;
      root.style.left = `${Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter))}px`;
      root.style.width = `${width}px`;
      root.style.maxHeight = `${Math.min(440, openUp ? above : below)}px`;
      root.style.top = openUp ? "auto" : `${rect.bottom + 8}px`;
      root.style.bottom = openUp ? `${window.innerHeight - rect.top + 8}px` : "auto";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [compact]);

  useEffect(() => {
    let cancelled = false;
    loadEmojiGroups().then((loaded) => { if (!cancelled) setGroups(loaded); }, () => { if (!cancelled) setLoadFailed(true); });
    // Phones would pop the keyboard over the grid, so only desktop focuses search on open.
    if (!compact) searchRef.current?.focus({ preventScroll: true });
    return () => { cancelled = true; };
  }, [compact]);

  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!groups || words.length === 0) return null;
    const matches: string[] = [];
    for (const group of groups) {
      for (const [emoji, name] of group.emoji) {
        const haystack = `${name} ${EMOJI_ALIASES[emoji] ?? ""}`;
        if (emoji === query.trim() || words.every((word) => haystack.includes(word))) matches.push(emoji);
      }
    }
    return matches;
  }, [groups, query]);

  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of groups ?? []) for (const [emoji, name] of group.emoji) names.set(emoji, name);
    return names;
  }, [groups]);

  function pick(emoji: string) {
    setRecent(rememberRecentEmoji(emoji));
    onPick(emoji);
  }

  function jumpTo(label: string) {
    setQuery("");
    requestAnimationFrame(() => {
      const section = scrollRef.current?.querySelector<HTMLElement>(`[data-emoji-group="${CSS.escape(label)}"]`);
      // The scroll area is the sections' offsetParent (position: relative).
      if (section && scrollRef.current) scrollRef.current.scrollTop = section.offsetTop;
    });
  }

  // Roving focus over every emoji cell (recents included), by on-screen position.
  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.dataset.emojiCell || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const cells = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-emoji-cell]") ?? [])];
    const index = cells.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowLeft") next = cells[index - 1];
    else if (event.key === "ArrowRight") next = cells[index + 1];
    else if (event.key === "Home") next = cells[0];
    else if (event.key === "End") next = cells[cells.length - 1];
    else {
      const from = target.getBoundingClientRect();
      const down = event.key === "ArrowDown";
      const ordered = down ? cells.slice(index + 1) : cells.slice(0, index).reverse();
      let rowTop: number | null = null;
      let bestDistance = Infinity;
      for (const cell of ordered) {
        const rect = cell.getBoundingClientRect();
        if (rect.height === 0 || Math.abs(rect.top - from.top) < 2) continue; // hidden or same row
        rowTop ??= rect.top;
        if (Math.abs(rect.top - rowTop) >= 2) break; // past the adjacent row
        const distance = Math.abs(rect.left - from.left);
        if (distance < bestDistance) { bestDistance = distance; next = cell; }
      }
      if (!next && !down) { searchRef.current?.focus(); return; }
    }
    next?.focus();
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const cell = (emoji: string, key: string) => (
    <button
      key={key}
      type="button"
      data-emoji-cell="1"
      className={styles.cell}
      aria-label={nameOf.get(emoji) ?? emoji}
      aria-pressed={selected === emoji}
      title={nameOf.get(emoji) ?? emoji}
      onClick={(event) => { event.stopPropagation(); pick(emoji); }}
    >{emoji}</button>
  );

  return (
    <span ref={anchorRef} hidden>{createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Choose an emoji"
      className={`${shellStyles.theme} ${shellFont.variable} ${styles.picker} ${compact ? styles.sheet : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
        onGridKeyDown(event);
      }}
    >
      <div className={styles.searchRow}>
        <label className={shellStyles.search + " " + styles.search}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search emoji"
            aria-label="Search emoji"
            enterKeyHint="done"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                scrollRef.current?.querySelector<HTMLButtonElement>("[data-emoji-cell]")?.focus();
              } else if (event.key === "Enter" && results?.[0]) {
                event.preventDefault();
                pick(results[0]);
              }
            }}
          />
        </label>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close emoji picker">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>

      {recent.length > 0 && (
        <div className={styles.recent}>
          <span className={shellStyles.caption}>Recently used</span>
          <div className={styles.recentRow}>{recent.map((emoji) => cell(emoji, `recent:${emoji}`))}</div>
        </div>
      )}

      {!results && groups && (
        <div role="toolbar" aria-label="Emoji categories" className={styles.tabs}>
          {groups.map((group) => (
            <button key={group.label} type="button" className={styles.tab} title={group.label} aria-label={group.label} onClick={() => jumpTo(group.label)}>
              {GROUP_ICONS[group.label] ?? group.emoji[0]?.[0]}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className={styles.scroll}>
        {loadFailed ? (
          <p className={shellStyles.caption}>Could not load emoji. Try again.</p>
        ) : !groups ? (
          <p className={shellStyles.caption}>Loading…</p>
        ) : results ? (
          results.length === 0
            ? <p className={shellStyles.caption}>No emoji match “{query.trim()}”.</p>
            : <div className={styles.grid}>{results.map((emoji) => cell(emoji, emoji))}</div>
        ) : (
          groups.map((group) => (
            <section key={group.label} data-emoji-group={group.label} aria-label={group.label}>
              <h3 className={styles.groupTitle}>{group.label}</h3>
              <div className={styles.grid}>{group.emoji.map(([emoji]) => cell(emoji, emoji))}</div>
            </section>
          ))
        )}
      </div>
    </div>,
    document.body,
    )}</span>
  );
}
