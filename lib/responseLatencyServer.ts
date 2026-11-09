import "server-only";
import { recordResponseLatency } from "@/lib/responseLatencyStore";
import type { ResponseLatencyDimensions, ResponseLatencySample, ResponseLatencyTimings } from "@/lib/responseLatencyCore";

export function createServerLatency(id: string, now = () => performance.now()) {
  const started = now();
  const timings: ResponseLatencyTimings = {};
  const dimensions: ResponseLatencyDimensions = { product: "unknown", mode: "unknown", modelId: null, provider: null };
  let finished = false;
  const duration = (since: number) => Math.max(0, Math.min(3_600_000, Math.round(now() - since)));
  return {
    dimensions,
    stage(key: "routingMs" | "contextMs") {
      const since = now();
      return () => { timings[key] = duration(since); };
    },
    provider() { timings.preProviderMs ??= duration(started); },
    content() { timings.firstContentMs ??= duration(started); },
    finish(outcome: ResponseLatencySample["outcome"], modelId: string | null, provider: string | null) {
      if (finished) return;
      finished = true;
      timings.settlementMs = duration(started);
      void recordResponseLatency(`${id}:server`, { ...dimensions, modelId, provider, source: "server", outcome, timings });
    },
  };
}
