import assert from "node:assert/strict";
import test from "node:test";

import {
  PROBE_FRESHNESS_WINDOW_MS,
  rollUpModelHealth,
  sharesFailureDomain,
} from "../lib/modelHealthRollup.ts";

const NOW = new Date("2026-08-05T12:00:00Z");
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000);

const probes = (results, { spacingMinutes = 5 } = {}) =>
  results.map((success, index) => ({
    success,
    completedAt: minutesAgo((results.length - index) * spacingMinutes),
    latencyMs: 400 + index * 10,
  }));

const rollUp = (overrides = {}) =>
  rollUpModelHealth({
    modelId: "gpt-5-6-luna",
    provider: "openai",
    providerVerdict: { outage: false, limited: false },
    observations: probes([true, true, true, true, true, true]),
    now: NOW,
    ...overrides,
  });

test("a model with clean recent probes is healthy and auto-eligible", () => {
  const rollup = rollUp();
  assert.equal(rollup.status, "healthy");
  assert.equal(rollup.reason, "healthy");
  assert.equal(rollup.eligibleForAutoRouting, true);
  assert.equal(rollup.probeCount, 6);
  assert.equal(rollup.failureRatePercent, 0);
  assert.equal(rollup.medianLatencyMs, 425);
});

// The half of G2 the provider-keyed signal could never express: a broken model
// under a healthy provider.
test("a failing model is unavailable even while its provider looks fine", () => {
  const rollup = rollUp({ observations: probes([false, false, false, false, false, false]) });
  assert.equal(rollup.status, "unavailable");
  assert.equal(rollup.reason, "model_probe_outage");
  assert.equal(rollup.eligibleForAutoRouting, false);
  assert.equal(rollup.failureRatePercent, 100);
});

// The other half: one degraded model must not take its whole provider out.
test("one bad model does not change the verdict for a sibling", () => {
  const bad = rollUp({
    modelId: "gpt-5-5",
    observations: probes([false, false, false, false, false, false]),
  });
  const good = rollUp({ modelId: "gpt-5-6-luna" });
  assert.equal(bad.status, "unavailable");
  assert.equal(good.status, "healthy");
});

test("a provider outage takes every model with it, whatever its own probes say", () => {
  const rollup = rollUp({ providerVerdict: { outage: true, limited: false } });
  assert.equal(rollup.status, "unavailable");
  assert.equal(rollup.reason, "provider_unavailable");
  assert.equal(rollup.eligibleForAutoRouting, false);
});

// A model's own probes cannot see a shared path misbehaving, so a degraded
// provider degrades its models even when they look clean.
test("a degraded provider degrades a model whose own probes are clean", () => {
  const rollup = rollUp({ providerVerdict: { outage: false, limited: true } });
  assert.equal(rollup.status, "degraded");
  assert.equal(rollup.reason, "provider_degraded");
  assert.equal(rollup.eligibleForAutoRouting, false);
});

// Unknown is a real answer, not a synonym for healthy. Auto must not select a
// model nobody has checked.
test("a model with no probes is unknown, not healthy", () => {
  const rollup = rollUp({ observations: [] });
  assert.equal(rollup.status, "unknown");
  assert.equal(rollup.reason, "model_never_probed");
  assert.equal(rollup.eligibleForAutoRouting, false);
  assert.equal(rollup.lastProbeAt, null);
  assert.equal(rollup.failureRatePercent, null);
});

test("probes older than the freshness window say nothing about now", () => {
  const stale = new Date(NOW.getTime() - PROBE_FRESHNESS_WINDOW_MS - 60_000);
  const rollup = rollUp({
    observations: [{ success: true, completedAt: stale, latencyMs: 300 }],
  });
  assert.equal(rollup.status, "unknown");
  assert.equal(rollup.reason, "model_probes_stale");
  assert.equal(rollup.eligibleForAutoRouting, false);
});

test("a probe just inside the window still counts", () => {
  const fresh = new Date(NOW.getTime() - PROBE_FRESHNESS_WINDOW_MS + 60_000);
  const rollup = rollUp({
    observations: Array.from({ length: 6 }, () => ({
      success: true,
      completedAt: fresh,
      latencyMs: 300,
    })),
  });
  assert.equal(rollup.status, "healthy");
});

test("recovery is read from the trailing streak, not the whole history", () => {
  // Failures first, then a clean run: the model is working now.
  const rollup = rollUp({
    observations: probes([false, false, false, true, true, true, true, true, true, true]),
  });
  assert.equal(rollup.status, "healthy");
  assert.ok(rollup.failureRatePercent > 0, "the history is still visible in the rate");
});

test("observations arrive in any order and are still read newest-last", () => {
  const ordered = probes([false, true, true, true, true, true]);
  const shuffled = [ordered[3], ordered[0], ordered[5], ordered[1], ordered[4], ordered[2]];
  assert.deepEqual(
    rollUp({ observations: shuffled }).status,
    rollUp({ observations: ordered }).status
  );
  assert.deepEqual(
    rollUp({ observations: shuffled }).lastProbeAt,
    rollUp({ observations: ordered }).lastProbeAt
  );
});

// G3 has no explicit failure domain yet. Naming the proxy in one place keeps
// `candidate.provider !== primary.provider` from spreading through the Router
// and quietly becoming the definition.
test("failure domain is provider, until an explicit one exists", () => {
  assert.equal(sharesFailureDomain({ provider: "openai" }, { provider: "openai" }), true);
  assert.equal(sharesFailureDomain({ provider: "openai" }, { provider: "anthropic" }), false);
});
