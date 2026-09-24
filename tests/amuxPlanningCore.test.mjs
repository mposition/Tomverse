import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAmuxUrgency,
  calibrateAmuxHistory,
  confidenceAdjustedMetric,
  evaluateAmuxQuotaTelemetry,
  parseAmuxDeadline,
} from "../lib/amux/planningCore.ts";

const now = new Date("2026-09-21T00:00:00.000Z");

test("deadline parser accepts only canonical instants and ISO dates", () => {
  assert.deepEqual(
    parseAmuxDeadline({
      classificationDueAt: "2026-09-22",
      title: "ignored deadline: tomorrow",
    }),
    {
      state: "parsed",
      due_at: "2026-09-22T23:59:59.999Z",
      source: "classification",
      precision: "date",
      raw: "2026-09-22",
    },
  );
  assert.equal(
    parseAmuxDeadline({
      title: "Ship [deadline: 2026-09-22T10:30:00+10:00]",
    }).due_at,
    "2026-09-22T00:30:00.000Z",
  );
  assert.equal(
    parseAmuxDeadline({ title: "deadline: 2026-02-30" }).state,
    "invalid",
  );
  assert.equal(
    parseAmuxDeadline({ title: "due: 2026/09/22" }).state,
    "invalid",
  );
  for (const title of [
    "due: 12/31/2026",
    "due: 31-12-2026",
    "deadline: 2026년 9월 22일",
  ]) {
    assert.equal(parseAmuxDeadline({ title }).state, "invalid");
  }
  assert.equal(
    parseAmuxDeadline({ title: "please finish tomorrow" }).state,
    "absent",
  );
  assert.equal(
    parseAmuxDeadline({ title: "Planning note — deadline: next Friday" })
      .state,
    "absent",
  );
  assert.equal(
    parseAmuxDeadline({ title: "Planning note — deadline: 2026 roadmap" })
      .state,
    "absent",
  );
  assert.deepEqual(
    parseAmuxDeadline({
      title: "Ship due: 2026-09-22",
      description: "The old note says deadline=2026-09-23",
    }).state,
    "ambiguous",
  );
});

test("urgency is monotonic near a deadline and bounded when overdue", () => {
  const later = calculateAmuxUrgency("2026-09-28T00:00:00.000Z", now);
  const soon = calculateAmuxUrgency("2026-09-21T04:00:00.000Z", now);
  const overdue = calculateAmuxUrgency("2026-08-01T00:00:00.000Z", now);
  assert.ok(later.score < soon.score);
  assert.ok(soon.score < overdue.score);
  assert.equal(overdue.score, 240);
});

test("historical calibration shrinks small samples and reports provenance", () => {
  const one = calibrateAmuxHistory(
    [
      {
        outcome: "succeeded",
        toStatus: "done",
        startedAt: new Date("2026-09-20T23:00:00Z"),
        endedAt: new Date("2026-09-20T23:30:00Z"),
      },
    ],
    now,
    60 * 60 * 1_000,
  );
  assert.equal(one.sample_size, 1);
  assert.equal(one.predicted_success?.value, 0.6);
  assert.ok((one.predicted_success?.confidence ?? 1) < 0.05);
  const adjusted = confidenceAdjustedMetric(one.predicted_success);
  assert.ok(adjusted.value > 0.5 && adjusted.value < 0.51);
  assert.equal(adjusted.source, "historical_attempts");
});

test("lease expiry is liveness evidence, not worker outcome calibration", () => {
  const result = calibrateAmuxHistory(
    [
      {
        outcome: "expired",
        toStatus: "todo",
        startedAt: new Date("2026-09-20T22:00:00Z"),
        endedAt: new Date("2026-09-20T23:00:00Z"),
      },
    ],
    now,
    60 * 60 * 1_000,
  );
  assert.equal(result.sample_size, 0);
  assert.equal(result.predicted_success, null);
});

test("quota exhaustion requires fresh high-confidence evidence", () => {
  const provider = evaluateAmuxQuotaTelemetry(
    {
      remaining_fraction: 0,
      observed_at: "2026-09-20T23:59:50Z",
      source: "provider_api",
      exhausted: true,
    },
    now,
  );
  assert.equal(provider.state, "fresh");
  assert.equal(provider.provider_exhausted, true);

  const lowConfidence = evaluateAmuxQuotaTelemetry(
    {
      remaining_fraction: 0,
      observed_at: "2026-09-20T23:59:50Z",
      source: "provider_api",
      confidence: 0.5,
      exhausted: true,
    },
    now,
  );
  assert.equal(lowConfidence.provider_exhausted, false);

  const stale = evaluateAmuxQuotaTelemetry(
    {
      remaining_fraction: 0,
      observed_at: "2026-09-20T20:00:00Z",
      source: "provider_api",
      exhausted: true,
    },
    now,
  );
  assert.equal(stale.state, "stale");
  assert.equal(stale.metric, null);
  assert.equal(stale.provider_exhausted, false);
});
