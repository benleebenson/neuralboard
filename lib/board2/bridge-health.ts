export type BridgeHealthResult = { ok: boolean; error?: string; code?: string };

const BRIDGE_HEALTH_CLIENT_TIMEOUT_MS = 8_000;

export async function checkBridgeHealth(
  signal?: AbortSignal,
  timeoutMs = BRIDGE_HEALTH_CLIENT_TIMEOUT_MS,
): Promise<BridgeHealthResult> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timeoutId = window.setTimeout(() => {
    controller.abort(new DOMException("Bridge health check timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    const response = await fetch("/api/board2/bridge-health", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; code?: string } | null;
    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || `Bridge health check failed (${response.status})`,
        code: data?.code,
      };
    }
    return { ok: true };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      error: timedOut ? "Bridge health check timed out" : "Could not reach the image finder bridge",
      code: timedOut ? "timeout" : "bridge_unreachable",
    };
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onParentAbort);
  }
}
