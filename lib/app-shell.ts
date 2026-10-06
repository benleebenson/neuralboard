// URL contract between the app shell (/) and the editor (/board2).

export type ShellTab = "home" | "profile";

/** The shell tab the user last had open, so the editor's Home button returns there. */
export const SHELL_TAB_STORAGE_KEY = "nb_shell_tab";

/** Editor query param naming the boards-folder .nbp open in the active tab; a refresh reopens it. */
export const EDITOR_BOARD_PARAM = "board";

export function shellTabUrl(tab: ShellTab): string {
  return tab === "profile" ? "/?tab=profile" : "/";
}

export function editorBoardUrl(fileName: string): string {
  return `/board2?${EDITOR_BOARD_PARAM}=${encodeURIComponent(fileName)}&mobileEditor=1`;
}

export function rememberedShellTab(): ShellTab {
  try {
    return sessionStorage.getItem(SHELL_TAB_STORAGE_KEY) === "profile" ? "profile" : "home";
  } catch {
    return "home";
  }
}

export function rememberShellTab(tab: ShellTab) {
  try {
    sessionStorage.setItem(SHELL_TAB_STORAGE_KEY, tab);
  } catch {}
}
