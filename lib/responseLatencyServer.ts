import "server-only";
import { recordResponseLatency } from "@/lib/responseLatencyStore";
import type { ResponseLatencyDimensions, ResponseLatencySample, ResponseLatencyTimings } from "@/lib/responseLatencyCore";

export function createServerLatency(id: string, now = () => performance.now()) {
  const started = now();
  const timings: ResponseLatencyTimings = {};
  const dimensions: ResponseLatencyDimensions = { product: "unknown", mode: "unknown", modelId: null, provider: null };
  let finished = false;
  let routingEnded: number | undefined;
  // Moments before the response stream exists, for a turn that never reaches one. Not part of the
  // stored sample: they exist so a request that dies early (a client that gave up waiting for
  // headers) can still say how far it got and what it was waiting on.
  const checkpoints: Array<{ name: string; ms: number }> = [];
  let openStage: { key: string; since: number } | null = null;
  const duration = (since: number) => Math.max(0, Math.min(3_600_000, Math.round(now() - since)));
  return {
    dimensions,
    /** Names a point on the way to the stream. Bounded; never carries content. */
    checkpoint(name: string) {
      if (checkpoints.length < 32) checkpoints.push({ name, ms: duration(started) });
    },
    /** How far the turn got, whether or not it finished. */
    prestream() {
      return {
        elapsedMs: duration(started),
        timings: { ...timings },
        checkpoints: [...checkpoints],
        ...(openStage ? { openStage: openStage.key, openStageMs: duration(openStage.since) } : {}),
      };
    },
    stage(key: "routingMs" | "contextMs" | "presearchMs") {
      const since = now();
      openStage = { key, since };
      if (key === "routingMs") timings.beforeRoutingMs = duration(started);
      return () => {
        if (openStage?.key === key) openStage = null;
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
