export function lipSyncBridgeHttpError(status: number, statusText: string, data: unknown): string {
  const detail = data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : statusText;
  return `Bridge returned ${status}${detail ? ` — ${detail}` : ""}`;
}

export function lipSyncBridgeRequestError(error: unknown): { message: string; status: number } {
  const message = error instanceof Error ? error.message : "Lip sync request failed";
  const networkFailure = error instanceof TypeError
    || /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message);
  return networkFailure
    ? { message: `Lip sync bridge unreachable — is the Mac mini awake? (${message})`, status: 502 }
    : { message, status: 500 };
}
