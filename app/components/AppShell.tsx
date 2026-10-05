"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { AccountControl } from "@/app/components/AccountControl";
import { useIsPro } from "@/app/components/useIsPro";
import { BOARD_LIBRARY_PENDING_FILE, type BoardLibraryEntry, getBoardsDirectory, listBoards, supportsBoardDirectory } from "@/lib/board-library";
import { normalizeJoinCode } from "@/lib/joinable-board";
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
  return (
    <>
      <h1 className={styles.pageTitle}>Public boards</h1>
      <section className={styles.empty}>
        <p className={styles.emptyHeading}>No public boards yet.</p>
        <p>Publishing a board to this wall isn’t available yet. Today, boards are shared privately with a six-character join code.</p>
        <div className={styles.emptyActions}>
          <a className={styles.secondaryButton} href="/public">Join with a code</a>
          <button type="button" className={styles.secondaryButton} onClick={onCreateJoinable}>Create a joinable board</button>
          <button type="button" className={styles.primaryButton} onClick={onCreate}>New board</button>
        </div>
      </section>
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
  const starred = boards.filter((board) => board.meta.trainingExample);

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
          <BoardRow title="Recently edited" boards={boards} previews={previews} />
          {starred.length > 0 && <BoardRow title="Training examples" boards={starred} previews={previews} />}
          <button type="button" className={styles.textButton} onClick={() => { void load(true); }}>Change folder ({state.directory.name})</button>
        </>
      )}
    </>
  );
}

function BoardRow({ title, boards, previews }: { title: string; boards: BoardLibraryEntry[]; previews: Record<string, string> }) {
  return (
    <section className={styles.row} aria-label={title}>
      <h2 className={styles.rowTitle}>{title}</h2>
      <div className={styles.rowScroller}>
        {boards.map((board) => (
          <button
            key={board.fileName}
            type="button"
            className={styles.card}
            aria-label={`Open ${board.meta.title}`}
            onClick={() => {
              sessionStorage.setItem(BOARD_LIBRARY_PENDING_FILE, board.fileName);
              window.location.assign("/board2?mobileEditor=1");
            }}
          >
            <span className={styles.cardImage}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
              {previews[board.fileName] ? <img src={previews[board.fileName]} alt="" /> : <span className={styles.cardPending} aria-hidden="true" />}
            </span>
            <span className={styles.cardName}>{board.meta.title}</span>
          </button>
        ))}
      </div>
    </section>
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
