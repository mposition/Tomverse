import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
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

// --- AUD-R001: synthetic-probe evidence merge policy ----------------------

test("no real evidence but a fresh probe success -> operational (PROBE_SUCCESS_CONFIRMED)", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeSuccessAt: minutesAgo(5),
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "PROBE_SUCCESS_CONFIRMED");
  assert.equal(result.isFresh, true);
});

// recordProviderProbeFailure always writes lastProbeFailureAt = NOW() in the
// same statement that increments consecutiveProbeFailures, so every fixture
// carrying a failure count also carries the timestamp production would have
// written alongside it.
test("a single probe failure with no real success -> degraded, not incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(3),
    consecutiveProbeFailures: 1,
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.reasonCode, "PROBE_REPEATED_FAILURE");
});

test("repeated probe failures at the threshold with no real success -> incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(3),
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "PROBE_REPEATED_FAILURE");
});

test("probe failures below the incident threshold stay degraded, never escalate alone", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(3),
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD - 1,
  });
  assert.equal(result.status, "degraded");
});

test("a fresh real success overrides probe failures entirely", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(2),
    lastProbeFailureAt: minutesAgo(3),
    consecutiveProbeFailures: 10,
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "RECENT_SUCCESS_CONFIRMED");
});

test("probe evidence never overrides an existing real-traffic incident or degraded verdict", () => {
  const incident = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(60),
    lastFailureAt: minutesAgo(1),
    consecutiveFailures: DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
    lastProbeSuccessAt: minutesAgo(1),
  });
  assert.equal(incident.status, "incident");
  assert.equal(incident.reasonCode, "CONSECUTIVE_FAILURES_THRESHOLD");

  const degraded = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(20),
    lastFailureAt: minutesAgo(2),
    lastProbeSuccessAt: minutesAgo(1),
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.reasonCode, "RECENT_FAILURE_EVIDENCE");
});

test("both real and probe evidence stale -> unknown (SUCCESS_STALE)", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(120),
    lastProbeSuccessAt: minutesAgo(90),
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "SUCCESS_STALE");
});

test("neither real nor probe evidence ever recorded -> unknown (NO_SUCCESS_RECORDED)", () => {
  const result = evaluatePublicProviderStatus({ ...baseInput });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "NO_SUCCESS_RECORDED");
});

test("a future or invalid probe success timestamp is never treated as fresh evidence", () => {
  const future = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeSuccessAt: minutesFromNow(10),
  });
  assert.notEqual(future.status, "operational");

  const invalid = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeSuccessAt: new Date(Number.NaN),
  });
  assert.notEqual(invalid.status, "operational");
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

// --- STG-F004 / R-02: probe failure evidence expires on the freshness window -

test("STG-F004 regression: a 38-hour-old Perplexity failure count no longer reads as a current incident", () => {
  // The audit baseline: 202 accumulated probe failures whose last recorded
  // failure was ~38 hours old because the scheduler had stopped running,
  // while every other provider had been checked within the hour. Before the
  // fix this pinned the provider to "incident" indefinitely.
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "PROBE_FAILURE_STALE");
  assert.equal(result.isFresh, false);
  // The reason text must not present the expired count as live evidence.
  assert.doesNotMatch(result.reasonText, /\b202\b/);
  assert.match(result.reasonText, /older than the 30-minute freshness window/i);
});

test("a fresh probe failure at the incident threshold still escalates", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(29),
    freshnessMinutes: 30,
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "PROBE_REPEATED_FAILURE");
});

test("a probe failure one minute past the window stops escalating", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: minutesAgo(31),
    freshnessMinutes: 30,
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "PROBE_FAILURE_STALE");
});

test("probe failure freshness uses the same window as success freshness", () => {
  const failureAt = minutesAgo(45);
  const tight = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: failureAt,
    freshnessMinutes: 30,
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  const loose = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: failureAt,
    freshnessMinutes: 90,
    consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  });
  assert.equal(tight.status, "unknown");
  assert.equal(loose.status, "incident");
});

test("a stale probe failure never suppresses a fresh real-traffic success", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(2),
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "RECENT_SUCCESS_CONFIRMED");
});

test("a stale probe failure never suppresses a fresh probe success", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeSuccessAt: minutesAgo(4),
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "PROBE_SUCCESS_CONFIRMED");
});

test("a null probe failure timestamp cannot back a current verdict", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastProbeFailureAt: null,
    consecutiveProbeFailures: 202,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "PROBE_FAILURE_STALE");
  assert.match(result.reasonText, /without a usable timestamp/i);
});

test("future and invalid probe failure timestamps are never treated as fresh", () => {
  for (const lastProbeFailureAt of [
    minutesFromNow(10),
    new Date(Number.NaN),
  ]) {
    const result = evaluatePublicProviderStatus({
      ...baseInput,
      lastProbeFailureAt,
      consecutiveProbeFailures: DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reasonCode, "PROBE_FAILURE_STALE");
  }
});

test("stale probe failure evidence does not override a real-traffic verdict", () => {
  // The real-traffic branches sit above the probe branch and must keep winning.
  const declared = evaluatePublicProviderStatus({
    ...baseInput,
    hasPublicIncident: true,
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(declared.reasonCode, "PUBLIC_INCIDENT_DECLARED");

  const outage = evaluatePublicProviderStatus({
    ...baseInput,
    internalStatus: "outage",
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(outage.reasonCode, "INTERNAL_OUTAGE_DETECTED");

  const realFailure = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(90),
    lastFailureAt: minutesAgo(2),
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(realFailure.status, "degraded");
  assert.equal(realFailure.reasonCode, "RECENT_FAILURE_EVIDENCE");
});

test("stale success plus stale probe failure still reports the stale failure honestly", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(120),
    lastProbeFailureAt: minutesAgo(38 * 60),
    consecutiveProbeFailures: 202,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "PROBE_FAILURE_STALE");
});

// STG-R002: real-traffic failure evidence expires, administrator verification
// is its own evidence stream, and neither may impersonate the other.
//
// The staging incident these pin: Perplexity's deep-research model was
// rejected five times with HTTP 400, consecutiveFailures reached 5, and
// lastSuccessAt stayed null. consecutiveFailures only resets on a recorded
// success, and no success could be recorded while every Perplexity model was
// reported unavailable -- so the provider stayed at Incident indefinitely on
// evidence that was, by then, a day and a half old.

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

test("five real request failures from 38 hours ago are not a current incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: hoursAgo(38),
    consecutiveFailures: 5,
    freshnessMinutes: 30,
  });
  assert.notEqual(result.status, "incident");
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "REAL_FAILURE_STALE");
});

test("three consecutive failures inside the freshness window are an incident", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: minutesAgo(2),
    consecutiveFailures: 3,
    freshnessMinutes: 30,
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "CONSECUTIVE_FAILURES_THRESHOLD");
});

test("a stale failure count with no timestamp cannot back a current verdict", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 9,
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "REAL_FAILURE_STALE");
});

test("an old failure with no count no longer holds a provider at degraded forever", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: hoursAgo(40),
    lastFailureAt: hoursAgo(38),
    consecutiveFailures: 1,
  });
  assert.notEqual(result.status, "degraded");
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "REAL_FAILURE_STALE");
});

test("a successful admin verification after an old failure restores a usable status", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: hoursAgo(38),
    // Recovery zeroes the counter in the same transaction that consumes the
    // verification, so this is the state the provider is left in.
    consecutiveFailures: 0,
    lastVerificationSuccessAt: minutesAgo(1),
  });
  assert.equal(result.status, "operational");
  assert.equal(result.reasonCode, "ADMIN_VERIFICATION_SUCCESS");
});

test("a successful verification is never reported as real-traffic success", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastVerificationSuccessAt: minutesAgo(1),
  });
  assert.equal(result.reasonCode, "ADMIN_VERIFICATION_SUCCESS");
  assert.notEqual(result.reasonCode, "RECENT_SUCCESS_CONFIRMED");
  // isFresh reports real-traffic (or probe) freshness only. A verification
  // proves the API answers; it does not prove users are being served.
  assert.equal(result.isFresh, false);
});

test("verification alone does not clear a fresh consecutive-failure block", () => {
  // Recovery is a separate, audited action for exactly this reason: while real
  // traffic is still failing right now, an operator's successful check does
  // not make the provider healthy.
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: minutesAgo(1),
    consecutiveFailures: 5,
    lastVerificationSuccessAt: minutesAgo(0.5),
  });
  assert.equal(result.status, "incident");
  assert.equal(result.reasonCode, "CONSECUTIVE_FAILURES_THRESHOLD");
});

test("a failed admin verification leaves the provider non-operational", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastFailureAt: hoursAgo(38),
    consecutiveFailures: 0,
    lastVerificationFailureAt: minutesAgo(1),
  });
  assert.equal(result.status, "degraded");
  assert.equal(result.reasonCode, "RECOVERY_VERIFICATION_FAILED");
});

test("a newer failed verification supersedes an older successful one", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastVerificationSuccessAt: minutesAgo(10),
    lastVerificationFailureAt: minutesAgo(1),
  });
  assert.equal(result.reasonCode, "RECOVERY_VERIFICATION_FAILED");
});

test("verification evidence expires on the same window as every other signal", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastVerificationSuccessAt: hoursAgo(4),
    freshnessMinutes: 30,
  });
  assert.notEqual(result.status, "operational");
  assert.equal(result.status, "unknown");
});

test("a future-dated verification timestamp is never treated as evidence", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: null,
    lastVerificationSuccessAt: minutesFromNow(30),
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "NO_SUCCESS_RECORDED");
});

test("real traffic still outranks verification evidence when both are fresh", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(2),
    lastVerificationSuccessAt: minutesAgo(1),
  });
  assert.equal(result.reasonCode, "RECENT_SUCCESS_CONFIRMED");
});

test("a stale failure that predates a stale success is still reported as stale success", () => {
  const result = evaluatePublicProviderStatus({
    ...baseInput,
    lastSuccessAt: minutesAgo(45),
    lastFailureAt: minutesAgo(60),
    consecutiveFailures: 0,
  });
  assert.equal(result.reasonCode, "SUCCESS_STALE");
});
