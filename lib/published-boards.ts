export const PUBLISHED_BOARDS_BUCKET = "published-boards";
export const PUBLISHED_BOARDS_UNAVAILABLE = "Publishing is temporarily unavailable.";

/** Supabase's free tier rejects any single upload over 50 MB; stay under it with headroom. */
export const PUBLISHED_PACKAGE_MAX_BYTES = 45 * 1024 * 1024;
export const PUBLISHED_PREVIEW_MAX_BYTES = 512 * 1024;
/** Stop accepting publications before the free tier's 1 GB storage cap is reached. */
export const PUBLISHED_STORAGE_BUDGET_BYTES = 950 * 1024 * 1024;

export const PUBLISHED_TITLE_MAX = 120;
export const PUBLISHED_KEY_MAX = 255;

/** One Home feed card. The owner's email is never sent to other users. */
export type PublishedBoardCard = { id: string; title: string; publishedAt: string };

/** The signed-in user's own publications, keyed by board file name, for the Profile toggles. */
export type MyPublishedBoard = { id: string; boardKey: string; title: string; sizeBytes: number; publishedAt: string };

export type PublishStart = {
  id: string;
  version: string;
  uploads: { package: string; preview: string };
};

export function validPublishedBoardId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
