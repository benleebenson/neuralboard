export const AUTO_BUILD_IMAGE_REQUEST_TIMEOUT_MS = 290_000;
export const AUTO_BUILD_IMAGE_RETRY_DELAY_MS = 2_000;
export const AUTO_BUILD_IMAGE_ATTEMPTS = 2;

export type ImageSearchSource = "google" | "bing" | "openverse";

export type AutoBuildFoundImage = {
  dataUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  source: ImageSearchSource;
};

export type ImageSearchFailure = {
  source: ImageSearchSource;
  code: string;
  message: string;
};

export type AutoBuildImageResult = {
  image: AutoBuildFoundImage;
  failures: ImageSearchFailure[];
  attempt: number;
};

export class AutoBuildImageSearchError extends Error {
  code: string;
  failures: ImageSearchFailure[];

  constructor(message: string, code = "image_search_failed", failures: ImageSearchFailure[] = []) {
    super(message);
    this.name = "AutoBuildImageSearchError";
    this.code = code;
    this.failures = failures;
  }
}

function isImageSearchSource(value: unknown): value is ImageSearchSource {
  return value === "google" || value === "bing" || value === "openverse";
}

function isFoundImage(value: unknown): value is AutoBuildFoundImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<AutoBuildFoundImage>;
  return typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:image/") &&
    typeof image.sourceUrl === "string" && /^https?:\/\//.test(image.sourceUrl) &&
    typeof image.width === "number" && image.width > 0 &&
    typeof image.height === "number" && image.height > 0 &&
    isImageSearchSource(image.source);
}

function parseFailures(value: unknown): ImageSearchFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const failure = item as Partial<ImageSearchFailure>;
    if (!isImageSearchSource(failure.source) || typeof failure.code !== "string" || typeof failure.message !== "string") return [];
    return [{ source: failure.source, code: failure.code, message: failure.message }];
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchImageOnce(
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Omit<AutoBuildImageResult, "attempt">> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const requestController = new AbortController();
  const onParentAbort = () => requestController.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onParentAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    requestController.abort(new DOMException(`Image search timed out after ${Math.round(timeoutMs / 1_000)} seconds`, "TimeoutError"));
  }, timeoutMs);

  try {
    const response = await fetchImpl("/api/board2/find-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: requestController.signal,
      body: JSON.stringify({ query, count: 1 }),
    });
    const data = await response.json().catch(() => null) as {
      error?: unknown;
      code?: unknown;
      images?: unknown;
      failures?: unknown;
    } | null;
    const failures = parseFailures(data?.failures);
    if (!response.ok) {
      throw new AutoBuildImageSearchError(
        typeof data?.error === "string" ? data.error : `Image search failed (${response.status})`,
        typeof data?.code === "string" ? data.code : "image_search_failed",
        failures,
      );
    }
    const image = Array.isArray(data?.images) ? data.images.find(isFoundImage) : undefined;
    if (!image) {
      const lastFailure = failures.at(-1);
      throw new AutoBuildImageSearchError(
        lastFailure?.message ?? "No source returned a usable image",
        lastFailure?.code ?? "no_results",
        failures,
      );
    }
    return { image, failures };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (requestController.signal.reason instanceof DOMException && requestController.signal.reason.name === "TimeoutError") {
      throw new AutoBuildImageSearchError(requestController.signal.reason.message, "timeout");
    }
    if (error instanceof AutoBuildImageSearchError) throw error;
    const message = error instanceof Error ? error.message : "Image finder request failed";
    throw new AutoBuildImageSearchError(
      /fetch failed|network|ECONNREFUSED|ENOTFOUND/i.test(message)
        ? "Could not reach the image finder bridge"
        : message,
      "bridge_unreachable",
    );
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", onParentAbort);
  }
}

export async function requestAutoBuildImage({
  query,
  signal,
  onAttempt,
  onRetry,
  timeoutMs = AUTO_BUILD_IMAGE_REQUEST_TIMEOUT_MS,
  retryDelayMs = AUTO_BUILD_IMAGE_RETRY_DELAY_MS,
  fetchImpl = fetch,
}: {
  query: string;
  signal: AbortSignal;
  onAttempt?: (attempt: number, totalAttempts: number) => void;
  onRetry?: (error: AutoBuildImageSearchError, delayMs: number) => void;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<AutoBuildImageResult> {
  let lastError = new AutoBuildImageSearchError("Image search failed");
  for (let attempt = 1; attempt <= AUTO_BUILD_IMAGE_ATTEMPTS; attempt++) {
    onAttempt?.(attempt, AUTO_BUILD_IMAGE_ATTEMPTS);
    try {
      return { ...await fetchImageOnce(query, signal, timeoutMs, fetchImpl), attempt };
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error instanceof AutoBuildImageSearchError
        ? error
        : new AutoBuildImageSearchError(error instanceof Error ? error.message : "Image search failed");
      if (attempt < AUTO_BUILD_IMAGE_ATTEMPTS) {
        onRetry?.(lastError, retryDelayMs);
        await abortableDelay(retryDelayMs, signal);
      }
    }
  }
  throw lastError;
}

function sourceLabel(source: ImageSearchSource): string {
  return source === "openverse" ? "Openverse" : source[0].toUpperCase() + source.slice(1);
}

function shortFailure(failure: ImageSearchFailure): string {
  if (failure.code === "cooldown") return `${sourceLabel(failure.source)} cooldown`;
  if (failure.code === "blocked") return `${sourceLabel(failure.source)} bot-check`;
  if (failure.code === "timeout") return `${sourceLabel(failure.source)} timed out`;
  if (failure.code === "rate_limited") return `${sourceLabel(failure.source)} rate limit`;
  return `${sourceLabel(failure.source)} unavailable`;
}

export function describeImageSuccess(slot: number, result: AutoBuildImageResult): string {
  const earlierFailures = result.failures.filter((failure) => failure.source !== result.image.source);
  const failureReasons = [...new Set(earlierFailures.map(shortFailure))];
  const prefix = failureReasons.length ? `${failureReasons.join("; ")}, ` : "";
  const retry = result.attempt > 1 ? " on retry" : "";
  return `Slot ${slot}: ${prefix}used ${sourceLabel(result.image.source)}${retry}`;
}

export function describeImageSkip(slot: number, error: unknown): string {
  const searchError = error instanceof AutoBuildImageSearchError ? error : null;
  const message = error instanceof Error ? error.message : "Image search failed";
  const reason = searchError?.code === "timeout" || /timed out/i.test(message)
    ? "timed out"
    : searchError?.code === "bridge_unreachable" || /fetch failed|could not reach/i.test(message)
      ? "bridge connection failed"
      : searchError?.failures.length
        ? [...new Set(searchError.failures.map(shortFailure))].join("; ")
        : message;
  return `Slot ${slot}: ${reason} after ${AUTO_BUILD_IMAGE_ATTEMPTS} attempts, skipped`;
}
