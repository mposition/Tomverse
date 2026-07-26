import assert from "node:assert/strict";
import test from "node:test";
import {
  describeProbeSchedulerDelay,
  evidenceSourceLabel,
} from "../lib/statusPageEvidence.ts";

test("evidenceSourceLabel attributes an operator-declared incident correctly", () => {
  assert.match(evidenceSourceLabel("PUBLIC_INCIDENT_DECLARED"), /operator/i);
});

test("evidenceSourceLabel marks probe-based reason codes as synthetic, not real traffic", () => {
  for (const code of ["PROBE_SUCCESS_CONFIRMED", "PROBE_REPEATED_FAILURE"]) {
    const label = evidenceSourceLabel(code);
    assert.match(label, /synthetic/i);
    assert.match(label, /not real user traffic/i);
  }
});

test("evidenceSourceLabel attributes every other reason code to real request traffic", () => {
  for (const code of [
    "RECENT_SUCCESS_CONFIRMED",
    "NO_SUCCESS_RECORDED",
    "SUCCESS_STALE",
    "RECENT_FAILURE_EVIDENCE",
    "CONSECUTIVE_FAILURES_THRESHOLD",
    "DEGRADED_PERFORMANCE",
    "ELEVATED_LATENCY",
    "INTERNAL_OUTAGE_DETECTED",
    "HEALTH_DATA_UNAVAILABLE",
  ]) {
    const label = evidenceSourceLabel(code);
    assert.match(label, /real request traffic/i);
  }
});

test("describeProbeSchedulerDelay returns null when the scheduler is on schedule", () => {
  assert.equal(
    describeProbeSchedulerDelay({ delayed: false, lastRunAt: "2026-07-26T12:00:00.000Z" }),
    null
  );
});

test("describeProbeSchedulerDelay returns null when there is no job record at all", () => {
  assert.equal(describeProbeSchedulerDelay(null), null);
});

test("describeProbeSchedulerDelay distinguishes a delayed-with-history scheduler from one that never ran", () => {
  assert.equal(
    describeProbeSchedulerDelay({ delayed: true, lastRunAt: "2026-07-26T11:00:00.000Z" }),
    "delayed_with_history"
  );
  assert.equal(
    describeProbeSchedulerDelay({ delayed: true, lastRunAt: null }),
    "delayed_never_run"
  );
});
