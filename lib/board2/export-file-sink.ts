// Export file lifecycle. Chrome's showSaveFilePicker creates the chosen file (empty) the moment the
// person confirms the dialog; createWritable() then writes into a hidden swap file that only
// replaces the real file on close(). So a failed export must:
//   1. abort() the writable — never close() it, which would commit whatever partial bytes exist;
//   2. remove the picker-created file, which abort() leaves behind as a real-looking 0-byte file.
// remove() is Chrome-only (FileSystemHandle.remove, Chrome 110+); where it is missing we say so,
// so the error the person sees can tell them an empty file remains.

export type ExportWritable = {
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
};

export type ExportFileHandle = {
  name: string;
  remove?: () => Promise<void>;
};

export type PartialExportCleanup = "nothing-to-clean" | "removed" | "left-empty";

export async function discardPartialExport(
  fileHandle: ExportFileHandle | null,
  writable: ExportWritable | null,
  reason?: unknown,
): Promise<PartialExportCleanup> {
  if (writable) {
    try {
      await writable.abort(reason);
    } catch (error) {
      // Already errored/closed streams reject abort(); the file removal below still matters.
      console.warn("[board2:export] aborting the export file stream failed", error);
    }
  }
  if (!fileHandle) return "nothing-to-clean";
  if (typeof fileHandle.remove !== "function") return "left-empty";
  try {
    await fileHandle.remove();
    return "removed";
  } catch (error) {
    console.warn("[board2:export] removing the partial export file failed", error);
    return "left-empty";
  }
}

export type ExportFailureReport =
  | { kind: "silent" }
  | { kind: "cancelled"; message: string }
  | { kind: "error"; message: string };

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

// What to tell the person after an export throws. Only two failures are quiet: dismissing the save
// dialog, and the person pressing Cancel. Anything else — including an AbortError raised by some
// media load mid-encode — is a real failure and its message is shown in full.
export function describeExportFailure(
  error: unknown,
  context: { userCancelled: boolean; pickerDismissed: boolean; cleanup: PartialExportCleanup; fileName?: string },
): ExportFailureReport {
  if (context.pickerDismissed && isAbortError(error)) return { kind: "silent" };
  if (context.userCancelled && isAbortError(error)) {
    return { kind: "cancelled", message: context.cleanup === "left-empty" && context.fileName
      ? `Export cancelled. An empty “${context.fileName}” was left where you chose to save it; you can delete it.`
      : "Export cancelled" };
  }
  const detail = error instanceof Error ? error.message || error.name : typeof error === "string" ? error : "Unknown error";
  const fileNote = context.cleanup === "removed"
    ? " The unfinished file was deleted."
    : context.cleanup === "left-empty" && context.fileName
      ? ` An empty “${context.fileName}” was left where you chose to save it; it is not a video and can be deleted.`
      : "";
  return { kind: "error", message: `Export failed: ${detail.replace(/[.\s]+$/, "")}.${fileNote}` };
}
