// Error plumbing for /api/board2/assets. Supabase's PostgrestError/StorageError are plain objects
// in some versions (not `instanceof Error`), which used to collapse every database failure into a
// bare "Failed to save asset" 500 with nothing useful in the function log.

export class AssetSaveError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetSaveError";
    this.status = status;
  }
}

export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  if (typeof error === "string") return error || fallback;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

// Everything a log reader needs to tell a Postgres constraint, a Storage 4xx, a sharp decode error
// and a network failure apart. Never includes request bodies or credentials.
export function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { message: errorMessage(error) };
  const source = error as Record<string, unknown>;
  const details: Record<string, unknown> = { message: errorMessage(error) };
  for (const key of ["name", "code", "details", "hint", "status", "statusCode", "error"] as const) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") details[key] = value;
  }
  if (error instanceof Error && error.stack) details.stack = error.stack.split("\n").slice(0, 6).join("\n");
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) details.cause = errorDetails(cause);
  return details;
}

export function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "23505";
}

// Storage answers an existing object with 409 / "The resource already exists".
export function isStorageDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { statusCode, status } = error as { statusCode?: unknown; status?: unknown };
  return String(statusCode ?? status) === "409" || /already exists|duplicate/i.test(errorMessage(error));
}

export function assetSaveStatus(error: unknown): number {
  return error instanceof AssetSaveError ? error.status : 500;
}
