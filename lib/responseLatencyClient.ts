/** No content, identity, model strings or wall-clock timestamps leave the browser. */
export function createClientLatency(startedAt = performance.now()) {
  let prepareMs = 0;
  let firstContentMs: number | null = null;
  let token: string | null = null;
  const elapsed = () => Math.max(0, Math.min(3_600_000, Math.round(performance.now() - startedAt)));
  return {
    dispatched() { prepareMs = elapsed(); },
    headers(response: Response) { token = response.headers.get("X-Response-Latency-Token"); },
    content(text: string) { if (firstContentMs === null && text.trim()) firstContentMs = elapsed(); },
    finish(outcome: "completed" | "cancelled" | "failed") {
      if (!token) return;
      const body = JSON.stringify({ token, outcome, prepareMs, firstContentMs, completionMs: elapsed() });
      token = null;
      // One best-effort report; diagnostics must not delay or retry the answer.
      try {
        void fetch("/api/chat/timing", { method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true }).then(response => response.body?.cancel()).catch(() => {});
      } catch { /* A native fetch adapter may reject synchronously. */ }
    },
  };
}
