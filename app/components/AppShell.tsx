"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { AccountControl } from "@/app/components/AccountControl";
import { useIsPro } from "@/app/components/useIsPro";
import { BOARD_LIBRARY_PENDING_FILE, type BoardLibraryEntry, getBoardsDirectory, listBoards, supportsBoardDirectory } from "@/lib/board-library";
import { normalizeJoinCode } from "@/lib/joinable-board";
import { publishBoard, unpublishBoard, type PublishPhase } from "@/lib/published-board-package";
import type { MyPublishedBoard, PublishedBoardCard } from "@/lib/published-boards";
import { boardCompositePreview } from "@/lib/simple-world";
import styles from "./AppShell.module.css";

type ShellTab = "home" | "profile";

// The editor reads `create` once and opens a fresh board tab; `joinable` also runs its existing "Make board joinable" flow.
const CREATE_BLANK_URL = "/board2?create=blank&mobileEditor=1";
const CREATE_JOINABLE_URL = "/board2?create=joinable&mobileEditor=1";

function tabFromLocation(): ShellTab {
  return new URLSearchParams(window.location.search).get("tab") === "profile" ? "profile" : "home";
}

export function AppShell() {
  const { data: session, status } = useSession();
  const { isPro, isAdmin, loading: isProLoading } = useIsPro();
  const [tab, setTab] = useState<ShellTab>("home");
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
    setTab(tabFromLocation());
    const onPop = () => setTab(tabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const selectTab = useCallback((next: ShellTab) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    window.scrollTo({ top: 0 });
  }, []);

  // A new board needs no account: uploads, timeline, camera, world view and export all work signed out.
  const createBoard = useCallback(() => {
    window.location.assign(CREATE_BLANK_URL);
  }, []);

  const createJoinableBoard = useCallback(() => {
    if (status === "loading") return;
    if (!session?.user) {
      // Joinable boards need an account; return straight into creation after sign-in.
      void signIn("google", { callbackUrl: CREATE_JOINABLE_URL });
      return;
    }
    window.location.assign(CREATE_JOINABLE_URL);
  }, [session, status]);

  if (forwarding) return <main className={styles.shell} />;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.wordmark}>Neural Board</div>
        <div className={styles.account}>
          {session?.user?.email ? (
            <AccountControl email={session.user.email} isPro={isPro} isAdmin={isAdmin} isProLoading={isProLoading} />
          ) : status === "unauthenticated" ? (
            <button type="button" className={styles.signIn} onClick={() => { void signIn("google"); }}>Sign in</button>
          ) : null}
        </div>
      </header>

      <main className={styles.main}>
        {tab === "home" ? <HomeView onCreate={createBoard} onCreateJoinable={createJoinableBoard} /> : <ProfileView />}
      </main>

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

function HomeView({ onCreate, onCreateJoinable }: { onCreate: () => void; onCreateJoinable: () => void }) {
  const [feed, setFeed] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; boards: PublishedBoardCard[] }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/published-boards", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ boards: PublishedBoardCard[] }> : Promise.reject())
      .then((body) => { if (!cancelled) setFeed({ kind: "ready", boards: body.boards }); })
      .catch(() => { if (!cancelled) setFeed({ kind: "error" }); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <h1 className={styles.pageTitle}>Public boards</h1>
      {feed.kind === "loading" ? (
        <section className={styles.empty}>Loading boards…</section>
      ) : feed.kind === "ready" && feed.boards.length > 0 ? (
        <div className={styles.feed}>
          {feed.boards.map((board) => (
            <a key={board.id} className={styles.card} href={`/board2?view=${board.id}`} aria-label={`View ${board.title}`}>
              <span className={styles.cardImage}>
                {/* eslint-disable-next-line @next/next/no-img-element -- signed Storage redirect */}
                <img src={`/api/published-boards/${board.id}/preview`} alt="" loading="lazy" />
              </span>
              <span className={styles.cardName}>{board.title}</span>
            </a>
          ))}
        </div>
      ) : (
        <section className={styles.empty}>
          {feed.kind === "error" && <p role="alert" className={styles.error}>Public boards couldn’t be loaded right now.</p>}
          <p className={styles.emptyHeading}>No public boards yet.</p>
          <p>Turn on “Public” for a board in your profile to show it here. Boards can still be edited together privately with a six-character join code.</p>
          <div className={styles.emptyActions}>
            <a className={styles.secondaryButton} href="/public">Join with a code</a>
            <button type="button" className={styles.secondaryButton} onClick={onCreateJoinable}>Create a joinable board</button>
            <button type="button" className={styles.primaryButton} onClick={onCreate}>New board</button>
          </div>
        </section>
      )}
    </>
  );
}

type ProfileState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "no-folder" }
  | { kind: "error"; message: string }
  | { kind: "ready"; directory: FileSystemDirectoryHandle; boards: BoardLibraryEntry[] };

function ProfileView() {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });

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
      <h1 className={styles.pageTitle}>Your boards</h1>
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
      ) : state.boards.length === 0 ? (
        <section className={styles.empty}>
          <p className={styles.emptyHeading}>No boards in “{state.directory.name}” yet.</p>
          <p>Save a board from the editor to see it here.</p>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => { void load(true); }}>Change folder</button>
          </div>
        </section>
      ) : (
        <>
          <BoardList directory={state.directory} boards={boards} previews={previews} />
          <button type="button" className={styles.textButton} onClick={() => { void load(true); }}>Change folder ({state.directory.name})</button>
        </>
      )}
    </>
  );
}

type PublishProgress = { phase: PublishPhase["phase"]; fraction: number; controller: AbortController };

/** The user's boards as rows: preview, name and a Public switch that publishes to the Home feed. */
function BoardList({ directory, boards, previews }: { directory: FileSystemDirectoryHandle; boards: BoardLibraryEntry[]; previews: Record<string, string> }) {
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
    if (status !== "authenticated") { void signIn("google", { callbackUrl: "/?tab=profile" }); return; }
    setConfirming(board);
  };

  return (
    <>
      <ul className={styles.boardList}>
        {boards.map((board) => {
          const inFlight = progress[board.fileName];
          const isPublic = !!inFlight || !!published?.[board.fileName];
          const switchLabel = `Public: ${board.meta.title}`;
          return (
            <li key={board.fileName} className={styles.boardRow}>
              <button
                type="button"
                className={styles.boardOpen}
                aria-label={`Open ${board.meta.title}`}
                onClick={() => {
                  sessionStorage.setItem(BOARD_LIBRARY_PENDING_FILE, board.fileName);
                  window.location.assign("/board2?mobileEditor=1");
                }}
              >
                <span className={styles.rowImage}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                  {previews[board.fileName] ? <img src={previews[board.fileName]} alt="" /> : <span className={styles.cardPending} aria-hidden="true" />}
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{board.meta.title}</span>
                  {inFlight ? (
                    <span className={styles.rowStatus} aria-live="polite">
                      {inFlight.phase === "compressing" ? "Compressing" : inFlight.phase === "uploading" ? "Uploading" : "Publishing"} {Math.round(inFlight.fraction * 100)}%
                      <span className={styles.progressTrack} aria-hidden="true"><span className={styles.progressFill} style={{ width: `${Math.round((inFlight.phase === "compressing" ? inFlight.fraction * 0.2 : inFlight.phase === "uploading" ? 0.2 + inFlight.fraction * 0.78 : 1) * 100)}%` }} /></span>
                    </span>
                  ) : errors[board.fileName] ? (
                    <span role="alert" className={`${styles.rowStatus} ${styles.error}`}>{errors[board.fileName]}</span>
                  ) : null}
                </span>
              </button>
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

function HouseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 3.5l8.5 7.5" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></svg>;
}
function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>;
}
function PersonIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="3.75" /><path d="M4.5 20.5c0-4.4 3.4-7.5 7.5-7.5s7.5 3.1 7.5 7.5Z" /></svg>;
}
