import "server-only";
import { recordResponseLatency } from "@/lib/responseLatencyStore";
import type { ResponseLatencyDimensions, ResponseLatencySample, ResponseLatencyTimings } from "@/lib/responseLatencyCore";

export function createServerLatency(id: string, now = () => performance.now()) {
  const started = now();
  const timings: ResponseLatencyTimings = {};
  const dimensions: ResponseLatencyDimensions = { product: "unknown", mode: "unknown", modelId: null, provider: null };
  let finished = false;
  let routingEnded: number | undefined;
  const duration = (since: number) => Math.max(0, Math.min(3_600_000, Math.round(now() - since)));
  return {
    dimensions,
    stage(key: "routingMs" | "contextMs" | "presearchMs") {
      const since = now();
      if (key === "routingMs") timings.beforeRoutingMs = duration(started);
      return () => {
        timings[key] = duration(since);
        if (key === "routingMs") routingEnded = now();
      };
    },
    provider() {
      timings.preProviderMs ??= duration(started);
      if (routingEnded !== undefined) timings.afterRoutingMs ??= duration(routingEnded);
    },
    content() {
      timings.firstContentMs ??= duration(started);
      if (timings.preProviderMs !== undefined) timings.providerToContentMs ??= Math.max(0, timings.firstContentMs - timings.preProviderMs);
    },
    finish(outcome: ResponseLatencySample["outcome"], modelId: string | null, provider: string | null) {
      if (finished) return;
      finished = true;
      timings.settlementMs = duration(started);
      void recordResponseLatency(`${id}:server`, { ...dimensions, modelId, provider, source: "server", outcome, timings });
    },
  };
}
