"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { AccountControl } from "@/app/components/AccountControl";
import { useIsPro } from "@/app/components/useIsPro";
import { editorBoardUrl, rememberShellTab, type ShellTab } from "@/lib/app-shell";
import { type BoardLibraryEntry, getBoardsDirectory, listBoards, supportsBoardDirectory } from "@/lib/board-library";
import { ANONYMOUS_BOARD_TTL_DAYS, BOARD_TYPE_PARAM, JOIN_CODE_LENGTH, normalizeJoinCode, readCreatedBoards, type BoardType } from "@/lib/joinable-board";
import { publishBoard, unpublishBoard, type PublishPhase } from "@/lib/published-board-package";
import type { MyPublishedBoard, PublishedBoardCard } from "@/lib/published-boards";
import { boardCompositePreview } from "@/lib/simple-world";
import styles from "./AppShell.module.css";
import { shellFont } from "./shell-font";

// The editor reads `create` (and the board type) once and opens a fresh board tab; `joinable` also
// makes it joinable right away. Signed out, that's an anonymous board kept for ANONYMOUS_BOARD_TTL_DAYS.
function createBoardUrl(type: BoardType): string {
  return `/board2?create=joinable&${BOARD_TYPE_PARAM}=${type}&mobileEditor=1`;
}

// Dismissing the join overlay keeps it closed for the rest of this tab's visit; the header's
// "Join with code" brings it back.
const JOIN_OVERLAY_DISMISSED_KEY = "nb_join_overlay_dismissed";

function tabFromLocation(): ShellTab {
  return new URLSearchParams(window.location.search).get("tab") === "profile" ? "profile" : "home";
}

export function AppShell() {
  const { data: session, status } = useSession();
  const { isPro, isAdmin, loading: isProLoading } = useIsPro();
  // Null until the URL is read after hydration, so a refresh on Profile never flashes (and fetches) Home first.
  const [tab, setTab] = useState<ShellTab | null>(null);
  const [forwarding, setForwarding] = useState(false);

  useEffect(() => {
    // Old share links pointed at /?join=CODE when the root rendered the editor; keep them working.
    const join = normalizeJoinCode(new URLSearchParams(window.location.search).get("join"));
    if (join) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForwarding(true);
      window.location.replace(`/board2?join=${join}`);
      return;
    }
    const initial = tabFromLocation();
    setTab(initial);
    rememberShellTab(initial);
    const onPop = () => { const next = tabFromLocation(); setTab(next); rememberShellTab(next); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const selectTab = useCallback((next: ShellTab) => {
    setTab(next);
    rememberShellTab(next);
    const url = new URL(window.location.href);
    if (next === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    window.scrollTo({ top: 0 });
  }, []);

  // + first asks which kind of board. A new board needs no account and is immediately joinable by
  // code. AI features still ask for sign-in inside the editor.
  const [chooserOpen, setChooserOpen] = useState(false);
  const createBoard = useCallback(() => setChooserOpen(true), []);
  const closeChooser = useCallback(() => setChooserOpen(false), []);

  const [query, setQuery] = useState("");
  // Null until read after hydration so the overlay never flashes for someone who dismissed it.
  const [joinOpen, setJoinOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let dismissed = false;
    try { dismissed = window.sessionStorage.getItem(JOIN_OVERLAY_DISMISSED_KEY) === "1"; } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is read after hydration
    setJoinOpen(!dismissed && tabFromLocation() === "home");
  }, []);
  const closeJoin = useCallback(() => {
    setJoinOpen(false);
    try { window.sessionStorage.setItem(JOIN_OVERLAY_DISMISSED_KEY, "1"); } catch {}
  }, []);

  if (forwarding) return <main className={`${styles.shell} ${shellFont.variable}`} />;

  const user = session?.user;
  const userLabel = user?.name || user?.email || "";

  return (
    <div className={`${styles.shell} ${shellFont.variable}`}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}><LogoMark /><span>NeuralBoard</span></div>
          {tab === "home" && (
            <label className={styles.search}>
              <SearchIcon />
              <input type="search" placeholder="Search boards" aria-label="Search public boards" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
          )}
          <div className={styles.headerActions}>
            {tab !== null && <button type="button" className={styles.outlineButton} onClick={() => setJoinOpen(true)}>Join with code</button>}
            {user?.email ? (
              tab === "home" ? (
                <button type="button" className={styles.avatarButton} aria-label="Your profile" title="Your profile" onClick={() => selectTab("profile")}>
                  <Avatar label={userLabel} />
                </button>
              ) : (
                <AccountControl email={user.email} isPro={isPro} isAdmin={isAdmin} isProLoading={isProLoading} />
              )
            ) : status === "unauthenticated" ? (
              <button type="button" className={styles.gradientButton} onClick={() => { void signIn(); }}>Sign in</button>
            ) : null}
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {tab === "home" ? <HomeView query={query} onCreate={createBoard} /> : tab === "profile" ? <ProfileView userLabel={userLabel} onCreate={createBoard} /> : null}
      </main>
      {/* Shown on arrival at Home (and from "Join with code" anywhere), in front of the boards. */}
      {joinOpen && tab !== null && !chooserOpen && <JoinOverlay onClose={closeJoin} onCreate={createBoard} />}
      {chooserOpen && <NewBoardChooser onClose={closeChooser} />}

      <nav className={styles.tabBar} aria-label="Neural Board">
        <button type="button" className={styles.tab} aria-label="Home" title="Home" aria-current={tab === "home" ? "page" : undefined} onClick={() => selectTab("home")}>
          <HouseIcon />
        </button>
        <button type="button" className={`${styles.tab} ${styles.createTab}`} aria-label="New board" title="New board" onClick={createBoard}>
          <PlusIcon />
        </button>
        <button type="button" className={styles.tab} aria-label="Profile" title="Your boards" aria-current={tab === "profile" ? "page" : undefined} onClick={() => selectTab("profile")}>
          <PersonIcon />
        </button>
      </nav>
    </div>
  );
}

const viewUrl = (id: string) => `/board2?view=${id}`;

function NewBoardChooser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={styles.joinBackdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.joinCard} role="dialog" aria-modal="true" aria-labelledby="new-board-title">
      <button type="button" className={styles.joinClose} aria-label="Close" title="Close" onClick={onClose}><CloseIcon /></button>
      <h2 id="new-board-title" className={styles.joinTitle}>New board</h2>
      <a className={styles.boardTypeOption} href={createBoardUrl("simple")} autoFocus>
        <StickyNotesIcon />
        <span><strong>Neural Board (Teacher)</strong>Sticky notes and photos, together. Share the code and everyone adds ideas.</span>
      </a>
      <a className={styles.boardTypeOption} href={createBoardUrl("neural")}>
        <ClapperIcon />
        <span><strong>Neural Board</strong>Everything, plus the video editor to turn the board into a video.</span>
      </a>
      <p className={styles.caption}>Either way, people join with a code. A Neural Board (Teacher) can become a Neural Board later.</p>
    </section>
    </div>
  );
}

function JoinOverlay({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  // Boards made on this device that haven't expired, newest first, for one-tap return.
  const [recent, setRecent] = useState<Array<{ code: string; expiresAt: string | null }>>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const now = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is read after hydration
    setRecent(Object.entries(readCreatedBoards())
      .filter(([, board]) => !board.expiresAt || Date.parse(board.expiresAt) > now)
      .sort(([, a], [, b]) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 6)
      .map(([boardCode, board]) => ({ code: boardCode, expiresAt: board.expiresAt })));
  }, []);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizeJoinCode(code);
    if (normalized.length !== JOIN_CODE_LENGTH) { setError("Enter the six-character code shown on the board."); return; }
    setChecking(true); setError("");
    try {
      const response = await fetch(`/api/joinable-board?code=${normalized}`, { cache: "no-store" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not join that board.");
      window.location.assign(`/board2?join=${normalized}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join that board.");
      setChecking(false);
    }
  }

  return (
    <div className={styles.joinBackdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.joinCard} role="dialog" aria-modal="true" aria-labelledby="join-board-title">
      <button type="button" className={styles.joinClose} aria-label="Close" title="Close" onClick={onClose}><CloseIcon /></button>
      <h2 id="join-board-title" className={styles.joinTitle}>Join a board</h2>
      <p className={styles.joinLead}>Type the code shown on the board.</p>
      <form className={styles.joinForm} onSubmit={join}>
        <input
          autoFocus
          className={styles.joinInput}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={JOIN_CODE_LENGTH}
          aria-label="Board code"
          placeholder="ABC123"
          value={code}
          onChange={(event) => { setCode(normalizeJoinCode(event.target.value)); setError(""); }}
        />
        <button type="submit" className={styles.primaryButton} disabled={checking || code.length !== JOIN_CODE_LENGTH}>{checking ? "Checking…" : "Join"}</button>
      </form>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {recent.length > 0 && (
        <div className={styles.recentBoards}>
          <span className={styles.caption}>Your boards on this device:</span>
          {recent.map((board) => (
            <a key={board.code} className={styles.recentBoard} href={`/board2?join=${board.code}`} title={board.expiresAt ? `Expires ${new Date(board.expiresAt).toLocaleDateString()}` : "Saved to your account"}>{board.code}</a>
          ))}
        </div>
      )}
      <p className={styles.caption}>
        Or <button type="button" className={styles.inlineLink} onClick={onCreate}>start a new board</button>. No account needed: signed out, boards are kept for {ANONYMOUS_BOARD_TTL_DAYS} days unless you save them to an account.
      </p>
    </section>
    </div>
  );
}

function HomeView({ query, onCreate }: { query: string; onCreate: () => void }) {
  const [feed, setFeed] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; boards: PublishedBoardCard[] }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/published-boards", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ boards: PublishedBoardCard[] }> : Promise.reject())
      .then((body) => { if (!cancelled) setFeed({ kind: "ready", boards: body.boards }); })
      .catch(() => { if (!cancelled) setFeed({ kind: "error" }); });
    return () => { cancelled = true; };
  }, []);

  const needle = query.trim().toLowerCase();
  const boards = feed.kind === "ready" ? feed.boards.filter((board) => !needle || board.title.toLowerCase().includes(needle)) : [];
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const copyCode = (code: string) => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopiedCode(code);
      window.setTimeout(() => setCopiedCode((current) => current === code ? null : current), 1400);
    }, () => {});
  };

  return (
    <>
      <h1 className={styles.srOnly}>Public boards</h1>
      <PublishedFromThisDevice copiedCode={copiedCode} onCopy={copyCode} />
      {feed.kind === "loading" ? (
        <section className={styles.empty}>Loading boards…</section>
      ) : boards.length > 0 ? (
        // Every board is equal: one grid, newest first, nothing featured.
        <ul className={styles.feedGrid}>
          {boards.map((board) => (
            <li key={board.id} className={styles.feedItem}>
              <a className={styles.card} href={viewUrl(board.id)} aria-label={`View ${board.title}`}>
                <span className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage redirect */}
                  <img src={`/api/published-boards/${board.id}/preview`} alt="" loading="lazy" />
                </span>
                <span className={styles.cardTitle}>{board.title}</span>
              </a>
              {/* Published without an account: view only here; its code stays on the creating device. */}
              {board.anonymous && (
                <div className={styles.cardJoin}>
                  <a className={styles.joinLink} href={viewUrl(board.id)} aria-label={`View ${board.title} (read-only)`}>View</a>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : feed.kind === "ready" && feed.boards.length > 0 ? (
        <section className={styles.empty}><p className={styles.emptyHeading}>No public boards match “{query.trim()}”.</p></section>
      ) : (
        <section className={styles.empty}>
          {feed.kind === "error" && <p role="alert" className={styles.error}>Public boards couldn’t be loaded right now.</p>}
          <p className={styles.emptyHeading}>No public boards yet.</p>
          <p>Turn on “Public” for a board in your profile to show it here. Boards can still be edited together privately with a six-character join code.</p>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.primaryButton} onClick={onCreate}>New board</button>
          </div>
        </section>
      )}
    </>
  );
}

function BoardCodeRow({ code, copied, onCopy, openLabel = "Join to edit" }: { code: string; copied: boolean; onCopy: (code: string) => void; openLabel?: string }) {
  return (
    <div className={styles.cardJoin}>
      <button type="button" className={styles.codeChip} onClick={() => onCopy(code)} title="Copy join code" aria-label={`Join code ${code}, copy`}>
        {copied ? "Copied!" : code}
      </button>
      <a className={styles.joinLink} href={`/board2?join=${code}`}>{openLabel}</a>
    </div>
  );
}

// Boards this device published by saving without an account (nb_anon_boards), with their codes, so
// they can be reopened here or entered on another device. Shown signed in or not.
function PublishedFromThisDevice({ copiedCode, onCopy }: { copiedCode: string | null; onCopy: (code: string) => void }) {
  const [boards, setBoards] = useState<Array<{ code: string; publishedId: string; expiresAt: string | null }>>([]);
  useEffect(() => {
    const now = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is read after hydration
    setBoards(Object.entries(readCreatedBoards())
      .filter(([, board]) => !!board.publishedId && (!board.expiresAt || Date.parse(board.expiresAt) > now))
      .sort(([, a], [, b]) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .map(([code, board]) => ({ code, publishedId: board.publishedId!, expiresAt: board.expiresAt })));
  }, []);
  if (!boards.length) return null;
  return (
    <section className={styles.myPublished} aria-labelledby="my-published-title">
      <h2 id="my-published-title" className={styles.sectionTitle}>Published from this device</h2>
      <p className={styles.caption}>Enter a board’s code on another device to keep editing it there.</p>
      <ul className={styles.feedGrid}>
        {boards.map((board) => (
          <li key={board.code} className={styles.feedItem}>
            <a className={styles.card} href={`/board2?join=${board.code}`} aria-label={`Open board ${board.code}`}>
              <span className={styles.thumb}>
                {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage redirect */}
                <img src={`/api/published-boards/${board.publishedId}/preview`} alt="" loading="lazy" />
              </span>
              <span className={styles.cardTitle}>{board.expiresAt ? `Expires ${new Date(board.expiresAt).toLocaleDateString()}` : "Saved to an account"}</span>
            </a>
            <BoardCodeRow code={board.code} copied={copiedCode === board.code} onCopy={onCopy} openLabel="Open" />
          </li>
        ))}
      </ul>
    </section>
  );
}

type ProfileState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "no-folder" }
  | { kind: "error"; message: string }
  | { kind: "ready"; directory: FileSystemDirectoryHandle; boards: BoardLibraryEntry[] };

function ProfileView({ userLabel, onCreate }: { userLabel: string; onCreate: () => void }) {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [publicCount, setPublicCount] = useState<number | null>(null);

  const loadIdRef = useRef(0);
  const load = useCallback(async (prompt: boolean) => {
    // Only the latest call may update state, so overlapping loads (remount, folder change) cannot flicker the list.
    const loadId = ++loadIdRef.current;
    const settle = (next: ProfileState | ((current: ProfileState) => ProfileState)) => { if (loadId === loadIdRef.current) setState(next); };
    if (!supportsBoardDirectory()) { settle({ kind: "unsupported" }); return; }
    try {
      const directory = await getBoardsDirectory({ prompt, write: true });
      if (!directory) { settle({ kind: "no-folder" }); return; }
      const boards = await listBoards(directory);
      settle({ kind: "ready", directory, boards });
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") { settle((current) => current.kind === "loading" ? { kind: "no-folder" } : current); return; }
      settle({ kind: "error", message: error instanceof Error ? error.message : "Could not read the boards folder." });
    }
  }, []);

  // Reads the remembered folder handle (an external store) after hydration; never prompts.
  useEffect(() => { void load(false); }, [load]);

  const boards = state.kind === "ready" ? state.boards : NO_BOARDS;
  const previews = useBoardPreviews(state.kind === "ready" ? state.directory : null, boards);

  return (
    <>
      <section className={styles.identity}>
        <Avatar label={userLabel} large />
        <div className={styles.identityText}>
          <h1 className={styles.profileName}>{userLabel || "Your profile"}</h1>
          {state.kind === "ready" && (
            <p className={styles.caption}>
              {state.boards.length} {state.boards.length === 1 ? "board" : "boards"}
              {publicCount !== null && ` · ${publicCount} public`}
            </p>
          )}
        </div>
      </section>
      <h2 className={styles.sectionTitle}>Your boards</h2>
      {state.kind === "loading" ? (
        <section className={styles.empty}>Loading boards…</section>
      ) : state.kind === "unsupported" ? (
        <section className={styles.empty}>
          <p className={styles.emptyHeading}>Your boards are saved in a folder on your computer.</p>
          <p>This browser can’t open local folders. Use Chrome or Edge on a desktop to see them here.</p>
        </section>
      ) : state.kind === "no-folder" || state.kind === "error" ? (
        <section className={styles.empty}>
          {state.kind === "error" && <p role="alert" className={styles.error}>{state.message}</p>}
          <p className={styles.emptyHeading}>Choose the folder where your .nbp boards are saved.</p>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.primaryButton} onClick={() => { void load(true); }}>Open boards folder</button>
          </div>
        </section>
      ) : (
        <>
          {state.boards.length === 0 && <p className={styles.caption}>No boards in “{state.directory.name}” yet. Save a board from the editor to see it here.</p>}
          <BoardList directory={state.directory} boards={boards} previews={previews} onCreate={onCreate} onPublicCount={setPublicCount} />
          <button type="button" className={styles.textButton} onClick={() => { void load(true); }}>Change folder ({state.directory.name})</button>
        </>
      )}
    </>
  );
}

type PublishProgress = { phase: PublishPhase["phase"]; fraction: number; controller: AbortController };

/** The user's boards as cards: preview, name and a Public switch that publishes to the Home feed. */
function BoardList({ directory, boards, previews, onCreate, onPublicCount }: {
  directory: FileSystemDirectoryHandle;
  boards: BoardLibraryEntry[];
  previews: Record<string, string>;
  onCreate: () => void;
  onPublicCount: (count: number | null) => void;
}) {
  const { status } = useSession();
  // Board file name → live publication, from the server; null until it has answered.
  const [published, setPublished] = useState<Record<string, MyPublishedBoard> | null>(null);
  const [progress, setProgress] = useState<Record<string, PublishProgress>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<BoardLibraryEntry | null>(null);
  const progressRef = useRef(progress);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  // Leaving the Profile tab cancels in-flight publishes; publishBoard cleans up after itself.
  useEffect(() => () => { for (const item of Object.values(progressRef.current)) item.controller.abort(); }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    fetch("/api/published-boards/mine", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ boards: MyPublishedBoard[] }> : Promise.reject())
      .then((body) => { if (!cancelled) setPublished(Object.fromEntries(body.boards.map((board) => [board.boardKey, board]))); })
      .catch(() => { if (!cancelled) setPublished({}); });
    return () => { cancelled = true; };
  }, [status]);

  const publicCount = published === null ? null : boards.filter((board) => published[board.fileName]).length;
  useEffect(() => { onPublicCount(publicCount); }, [onPublicCount, publicCount]);

  const setError = (fileName: string, message: string | null) => setErrors((current) => {
    const next = { ...current };
    if (message) next[fileName] = message; else delete next[fileName];
    return next;
  });
  const clearProgress = (fileName: string) => setProgress((current) => {
    const next = { ...current };
    delete next[fileName];
    return next;
  });

  const publish = async (board: BoardLibraryEntry) => {
    const controller = new AbortController();
    setError(board.fileName, null);
    setProgress((current) => ({ ...current, [board.fileName]: { phase: "compressing", fraction: 0, controller } }));
    try {
      const result = await publishBoard({
        directory,
        fileName: board.fileName,
        file: board.file,
        title: board.meta.title,
        signal: controller.signal,
        onProgress: ({ phase, fraction }) => setProgress((current) => current[board.fileName]?.controller === controller ? { ...current, [board.fileName]: { phase, fraction, controller } } : current),
      });
      setPublished((current) => ({ ...current, [board.fileName]: { id: result.id, boardKey: board.fileName, title: board.meta.title, sizeBytes: result.sizeBytes, publishedAt: new Date().toISOString() } }));
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") setError(board.fileName, error instanceof Error ? error.message : "Could not publish this board.");
    } finally {
      setProgress((current) => {
        if (current[board.fileName]?.controller !== controller) return current;
        const next = { ...current };
        delete next[board.fileName];
        return next;
      });
    }
  };

  const unpublish = async (board: BoardLibraryEntry, publication: MyPublishedBoard) => {
    setError(board.fileName, null);
    // Off at once; restore the switch if the server refuses.
    setPublished((current) => {
      const next = { ...current };
      delete next[board.fileName];
      return next;
    });
    try {
      await unpublishBoard(publication.id);
    } catch (error) {
      setPublished((current) => ({ ...current, [board.fileName]: publication }));
      setError(board.fileName, error instanceof Error ? error.message : "Could not make this board private.");
    }
  };

  const toggle = (board: BoardLibraryEntry) => {
    const inFlight = progress[board.fileName];
    if (inFlight) { inFlight.controller.abort(); clearProgress(board.fileName); return; }
    const publication = published?.[board.fileName];
    if (publication) { void unpublish(board, publication); return; }
    if (status !== "authenticated") { void signIn(undefined, { callbackUrl: "/?tab=profile" }); return; }
    setConfirming(board);
  };

  return (
    <>
      <ul className={styles.boardGrid}>
        <li>
          <button type="button" className={styles.newTile} onClick={onCreate}>
            <span className={styles.newPlus} aria-hidden="true"><PlusIcon /></span>
            <span>New board</span>
          </button>
        </li>
        {boards.map((board) => {
          const inFlight = progress[board.fileName];
          const isPublic = !!inFlight || !!published?.[board.fileName];
          const switchLabel = `Public: ${board.meta.title}`;
          const edited = editedLabel(board.meta.modifiedAt);
          return (
            <li key={board.fileName} className={styles.boardCard}>
              <button
                type="button"
                className={styles.boardOpen}
                aria-label={`Open ${board.meta.title}`}
                onClick={() => window.location.assign(editorBoardUrl(board.fileName))}
              >
                <span className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                  {previews[board.fileName] ? <img src={previews[board.fileName]} alt="" /> : <span className={styles.cardPending} aria-hidden="true" />}
                  {published?.[board.fileName] && <span className={styles.publicPill}>Public</span>}
                </span>
              </button>
              <div className={styles.boardMeta}>
                <span className={styles.boardText}>
                  <span className={styles.cardTitle}>{board.meta.title}</span>
                  {edited && <span className={styles.caption}>Edited {edited}</span>}
                </span>
                <label className={styles.switchLabel}>
                  <span>Public</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isPublic}
                    aria-label={switchLabel}
                    title={inFlight ? "Cancel publishing" : isPublic ? "Public — tap to make private" : "Private — tap to publish"}
                    className={styles.switch}
                    disabled={status === "loading" || (status === "authenticated" && published === null)}
                    onClick={() => toggle(board)}
                  >
                    <span className={styles.switchKnob} />
                  </button>
                </label>
              </div>
              {inFlight ? (
                <span className={styles.rowStatus} aria-live="polite">
                  {inFlight.phase === "compressing" ? "Compressing" : inFlight.phase === "uploading" ? "Uploading" : "Publishing"} {Math.round(inFlight.fraction * 100)}%
                  <span className={styles.progressTrack} aria-hidden="true"><span className={styles.progressFill} style={{ width: `${Math.round((inFlight.phase === "compressing" ? inFlight.fraction * 0.2 : inFlight.phase === "uploading" ? 0.2 + inFlight.fraction * 0.78 : 1) * 100)}%` }} /></span>
                </span>
              ) : errors[board.fileName] ? (
                <span role="alert" className={`${styles.rowStatus} ${styles.error}`}>{errors[board.fileName]}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {confirming && (
        <div className={styles.dialogBackdrop} role="presentation" onClick={() => setConfirming(null)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="publish-confirm-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="publish-confirm-title" className={styles.dialogTitle}>Make “{confirming.meta.title}” public?</h2>
            <p>Anyone will be able to view this board’s images and hear its narration on the Home feed. They can’t edit it.</p>
            <div className={styles.emptyActions}>
              <button type="button" className={styles.secondaryButton} autoFocus onClick={() => setConfirming(null)}>Cancel</button>
              <button type="button" className={styles.primaryButton} onClick={() => { const board = confirming; setConfirming(null); void publish(board); }}>Make public</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const NO_BOARDS: BoardLibraryEntry[] = [];
const previewCache = new Map<string, string>();
const previewKey = (board: BoardLibraryEntry) => `${board.fileName}:${board.file.lastModified}:${board.file.size}`;

/** Board composites, one at a time, so a large folder never decodes every board's media at once. */
function useBoardPreviews(directory: FileSystemDirectoryHandle | null, boards: BoardLibraryEntry[]): Record<string, string> {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    void (async () => {
      for (const board of boards) {
        if (cancelled) return;
        const key = previewKey(board);
        let url = previewCache.get(key);
        if (!url) {
          try {
            url = URL.createObjectURL(await boardCompositePreview(directory, board.fileName, board.file));
          } catch {
            // Fall back to the snapshot saved inside the .nbp; failed composites are not retried.
            url = board.thumbnailDataUri;
          }
          if (url) previewCache.set(key, url);
        }
        if (url && !cancelled) setPreviews((current) => current[board.fileName] === url ? current : { ...current, [board.fileName]: url! });
      }
    })();
    return () => { cancelled = true; };
  }, [boards, directory]);
  return previews;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];

function editedLabel(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const seconds = (time - Date.now()) / 1000;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function initials(label: string): string {
  const words = label.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

function Avatar({ label, large = false }: { label: string; large?: boolean }) {
  const letters = initials(label);
  return (
    <span className={`${styles.avatar} ${large ? styles.avatarLarge : ""}`} aria-hidden="true">
      <span className={styles.avatarInner}>{letters || <PersonIcon />}</span>
    </span>
  );
}

// A tiny neural network: one input node, two hidden nodes, one output node, each layer wired to
// the next, in a green-to-teal gradient.
export function LogoMark() {
  const gradientId = `nb-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ink = `url(#${gradientId})`;
  return (
    <span className={styles.logo} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#10b981" />
            <stop offset="1" stopColor="#14b8a6" />
          </linearGradient>
        </defs>
        <g stroke={ink} strokeWidth="2" strokeLinecap="round" opacity="0.55">
          <path d="M6 16 16 8M6 16l10 8M16 8l10 8M16 24l10-8" />
        </g>
        <g fill={ink}>
          <circle cx="6" cy="16" r="3.25" />
          <circle cx="16" cy="8" r="3.25" />
          <circle cx="16" cy="24" r="3.25" />
          <circle cx="26" cy="16" r="3.75" />
        </g>
      </svg>
    </span>
  );
}
function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
}
function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>;
}
function HouseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 3.5l8.5 7.5" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></svg>;
}
function StickyNotesIcon() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="4" y="9" width="20" height="20" rx="2" fill="#FFE58A" transform="rotate(-6 14 19)" />
      <rect x="16" y="13" width="20" height="20" rx="2" fill="#BFE3FF" transform="rotate(5 26 23)" />
      <path d="M20 20h11M20 25h8" stroke="#2F3533" strokeWidth="2" strokeLinecap="round" transform="rotate(5 26 23)" />
    </svg>
  );
}

function ClapperIcon() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
      <rect x="6" y="15" width="28" height="18" rx="2" />
      <path d="M6 15l26-6.5-1.4-4.6L5 10.2z" />
      <path d="M17 20.5v8l7-4z" fill="currentColor" />
    </svg>
  );
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>;
}
function PersonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="3.75" /><path d="M4.5 20.5c0-4.4 3.4-7.5 7.5-7.5s7.5 3.1 7.5 7.5Z" /></svg>;
}
