import type { ClientLatencyStages } from "./responseLatencyCore";
import { boundedLatencyMs, createLatencyStages } from "./responseLatencyStages";

/** No content, identity, model strings or wall-clock timestamps leave the browser. */
export function createClientLatency(startedAt?: number, initialStages: ClientLatencyStages = {}, now = () => performance.now()) {
  const started = startedAt ?? now();
  let prepareMs = 0;
  let firstContentMs: number | null = null;
  let token: string | null = null;
  // Older/restored payloads may lack the submit clock. Their carried stages
  // cannot be compared to this new run's clock; retain only new observations.
  const stages = createLatencyStages(startedAt === undefined ? {} : initialStages, now);
  let dispatchedAt: number | null = null;
  let streamEndedAt: number | null = null;
  const elapsed = () => boundedLatencyMs(now() - started);
  return {
    stage: stages.stage,
    freshLocation(durationMs: number, overlapMs?: number) {
      if (startedAt === undefined) return;
      stages.timings.locationIntentMs = boundedLatencyMs(durationMs);
      if (overlapMs !== undefined) stages.timings.freshLocationOverlapMs = boundedLatencyMs(Math.min(durationMs, overlapMs));
    },
    dispatched() { prepareMs = elapsed(); dispatchedAt = now(); },
    headers(response: Response) {
      token = response.headers.get("X-Response-Latency-Token");
      if (dispatchedAt !== null) stages.timings.responseHeadersMs = boundedLatencyMs(now() - dispatchedAt);
    },
    content(text: string) {
      if (firstContentMs !== null || !text.trim()) return;
      firstContentMs = elapsed();
      if (dispatchedAt !== null) stages.timings.dispatchToContentMs = boundedLatencyMs(now() - dispatchedAt);
    },
    streamEnded() {
      streamEndedAt = now();
      if (firstContentMs !== null) stages.timings.contentToEndMs = boundedLatencyMs(elapsed() - firstContentMs);
    },
    finish(outcome: "completed" | "cancelled" | "failed") {
      if (!token) return;
      if (streamEndedAt !== null) stages.timings.clientFinalizeMs = boundedLatencyMs(now() - streamEndedAt);
      const body = JSON.stringify({ token, outcome, prepareMs, firstContentMs, completionMs: elapsed(), stages: stages.timings });
      token = null;
      // One best-effort report; diagnostics must not delay or retry the answer.
      try {
        void fetch("/api/chat/timing", { method: "POST", headers: { "Content-Type": "application/json" },
          body, keepalive: true }).then(response => response.body?.cancel()).catch(() => {});
      } catch { /* A native fetch adapter may reject synchronously. */ }
    },
  };
}
