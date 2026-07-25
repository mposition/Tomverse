import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  evaluatePublicProviderStatus,
  summarizeMonitoredStatuses,
  type PublicProviderStatusInput,
} from "../lib/providerPublicStatusCore.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const baseInput: PublicProviderStatusInput = {
  now: NOW,
  lastSuccessAt: null,
  lastFailureAt: null,
  freshnessMinutes: 30,
  internalStatus: "available",
};

test("no success recorded ever -> unknown", () => {
  const result = evaluatePublicProviderStatus({ ...baseInput });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "NO_SUCCESS_RECORDED");
  assert.equal(result.isFresh, false);
});

test("recent success, no failures -> operational", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(5),
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "RECENT_SUCCESS_CONFIRMED");
  assert.equal(result.isFresh, true);
});

test("success older than the freshness window -> unknown (stale)", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(45),
    freshnessMinutes: 30,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "SUCCESS_STALE");
  assert.equal(result.isFresh, false);
});

test("a more recent failure than the last success -> degraded, not operational", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(20),
    lastFailureAt: minutesAgo(2),
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.reasonCode, "RECENT_FAILURE_EVIDENCE");
});

test("consecutive failure threshold exceeded -> incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(60),
    lastFailureAt: minutesAgo(1),
    consecutiveFailures: DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "CONSECUTIVE_FAILURES_THRESHOLD");
});

test("some errors but a recent success within an acceptable rate -> operational per policy", () => {
  // internalStatus is the caller's already-computed window verdict (available
  // means the failure-rate policy did not trip), and there is no more-recent
  // failure than the fresh success -- so this reads as operational.
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(3),
    lastFailureAt: minutesAgo(40),
    internalStatus: "available",
  });
  assert.equal(result.status, "operational");
});

test("some errors that do trip the failure-rate policy -> degraded per policy", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(3),
    internalStatus: "limited",
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.reasonCode, "DEGRADED_PERFORMANCE");
});

test("a declared public incident wins over otherwise-healthy evidence", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(1),
    internalStatus: "available",
    hasPublicIncident: true,
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "PUBLIC_INCIDENT_DECLARED");
});

test("a future or otherwise invalid success timestamp is never treated as fresh evidence", () => {
  const future = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesFromNow(10),
  });
  assert.notEqual(future.status, "operational");
  assert.equal(future.isFresh, false);

  const invalid = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: new Date(Number.NaN),
  });
  assert.notEqual(invalid.status, "operational");
  assert.equal(invalid.isFresh, false);
});

test("different freshness windows are honored for the same timestamp", () => {
  const successAt = minutesAgo(12);
  const tight = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: successAt,
    freshnessMinutes: 10,
  });
  const loose = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: successAt,
    freshnessMinutes: 15,
  });
  assert.equal(tight.status, "unknown");
  assert.equal(loose.status, "operational");
});

test("an active model-level incident escalates to incident even with fresh provider-level success", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(1),
    internalStatus: "available",
    hasActiveModelIncident: true,
  });
  assert.equal(result.status, "incident");
});

test("internal outage status is always reported as a public incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(1),
    internalStatus: "outage",
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "INTERNAL_OUTAGE_DETECTED");
});

test("a single recent failure below the consecutive-failure threshold does not escalate to incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(30),
    lastFailureAt: minutesAgo(1),
    consecutiveFailures: 1,
  });
  assert.equal(result.status, "degraded");
  assert.notEqual(result.status, "incident");
});

test("elevated latency on an otherwise fresh success reads as degraded", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(2),
    elevatedLatency: true,
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.reasonCode, "ELEVATED_LATENCY");
});

test("summarizeMonitoredStatuses only claims all-operational when every status is fresh-success operational", () => {
  assert.equal(
    summarizeMonitoredStatuses(["operational", "operational"]).tone,
    "operational"
  );
  assert.match(
    summarizeMonitoredStatuses(["operational", "operational"]).headline,
    /operational/i
  );
});

test("summarizeMonitoredStatuses never says all-operational when any provider is unknown", () => {
  const summary = summarizeMonitoredStatuses(["operational", "unknown"]);
  assert.doesNotMatch(summary.headline, /all monitored providers are operational/i);
  assert.equal(summary.tone, "unknown");
});

test("summarizeMonitoredStatuses surfaces degraded before unknown", () => {
  const summary = summarizeMonitoredStatuses(["degraded", "unknown", "operational"]);
  assert.equal(summary.tone, "degraded");
});

test("summarizeMonitoredStatuses surfaces incident above everything else", () => {
  const summary = summarizeMonitoredStatuses([
    "incident",
    "degraded",
    "unknown",
    "operational",
  ]);
  assert.equal(summary.tone, "incident");
});

// --- E2E-style fixture matrix from the report -----------------------------

test("fixture matrix: OpenAI/Anthropic/Google/Perplexity/Mistral produce the documented statuses", () => {
  const fixtures: Array<{ name: string; input: PublicProviderStatusInput; expected: string }> = [
    {
      name: "OpenAI: recent success",
      input: { ...baseInput, lastSuccessAt: minutesAgo(2) },
      expected: "operational",
    },
    {
      name: "Anthropic: no success ever recorded",
      input: { ...baseInput, lastSuccessAt: null },
      expected: "unknown",
    },
    {
      name: "Google: stale success",
      input: { ...baseInput, lastSuccessAt: minutesAgo(120) },
      expected: "unknown",
    },
    {
      name: "Perplexity: recent consecutive failures",
      input: {
        ...baseInput,
        lastSuccessAt: minutesAgo(90),
        lastFailureAt: minutesAgo(1),
        consecutiveFailures: 5,
      },
      expected: "incident",
    },
    {
      name: "Mistral: recent success but high latency",
      input: { ...baseInput, lastSuccessAt: minutesAgo(1), elevatedLatency: true },
      expected: "degraded",
    },
  ];

  const statuses = fixtures.map((fixture) => {
    const result = evaluatePublicProviderStatus(fixture.input);
    assert.equal(result.status, fixture.expected, fixture.name);
    return result.status;
  });

  const summary = summarizeMonitoredStatuses(statuses as never);
  assert.doesNotMatch(summary.headline, /all monitored providers are operational/i);
});
