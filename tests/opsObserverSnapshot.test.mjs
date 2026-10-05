// The ops snapshot the app builds: each section from its source, banded and
// truncated, a failed section "unknown" on its own, and every snapshot
// accepted by the runner's own parser -- with no error text, last error,
// micro-USD or exact count crossing.

import assert from "node:assert/strict";
import test from "node:test";

import { observationsFromSnapshot } from "../scripts/ops-observer/envelope-schema-core.mjs";
import { buildSnapshot, failureBand, utilisationBand } from "../scripts/ops-observer/snapshot-core.mjs";

const NOW = new Date("2026-10-05T01:23:45.678Z");
const ok = (value) => ({ status: "fulfilled", value });
const failed = () => ({ status: "rejected", reason: new Error("boom") });

const readiness = { checks: { database: true, securityEnvironment: true, providerBudgets: false, emailSnapshotKeyring: true, emailSendingIdentity: true } };
const jobs = [
  {
    key: "credit_reservation_reconciliation", status: "stuck", delayed: true,
    lastRunAt: "2026-10-05T01:02:59.999Z", lastSuccessAt: null, consecutiveFailures: 7,
    lastError: "connection reset by 10.0.0.4 for user alice@example.com", name: "x", schedule: "*/15 * * * *",
  },
  { key: "standard_email_drain", status: "success", delayed: false, lastRunAt: "2026-10-05T01:20:00.000Z", lastSuccessAt: "2026-10-05T01:20:30.500Z", consecutiveFailures: 0 },
];
const budgets = {
  usageUnavailable: false,
  providers: [
    { provider: "openai", periods: [
      { period: "day", usedMicroUsd: 960, limitMicroUsd: 1000, resetAt: "2026-10-06T00:00:00.000Z" },
      { period: "month", usedMicroUsd: 1000, limitMicroUsd: 1000, resetAt: "2026-11-01T00:00:00.000Z" },
    ] },
  ],
};
const build = (overrides = {}) =>
  buildSnapshot({ readiness: ok(readiness), jobs: ok(jobs), budgets: ok(budgets), now: NOW, commitSha: "a".repeat(40), ...overrides });

test("a full snapshot is built in the closed shape and parsed by the runner's parser", () => {
  const result = build();
  assert.equal(result.ok, true);
  const s = result.snapshot;
  assert.equal(s.generatedAt, "2026-10-05T01:23:00.000Z");
  assert.deepEqual(s.readiness, readiness.checks);
  assert.deepEqual(s.scheduledJobs[0], {
    key: "credit_reservation_reconciliation", delayed: true, stuck: true,
    lastRunAt: "2026-10-05T01:02:00.000Z", lastSuccessAt: null, consecutiveFailuresBand: "3+",
  });
  assert.deepEqual(s.providerBudgets, [
    { provider: "openai", scope: "day", utilisationBand: ">=95", resetAt: "2026-10-06T00:00:00.000Z" },
    { provider: "openai", scope: "month", utilisationBand: "exhausted", resetAt: "2026-11-01T00:00:00.000Z" },
  ]);
  // Nothing outside the allowlist crosses.
  const text = JSON.stringify(s);
  for (const leaked of ["connection reset", "alice", "10.0.0.4", "MicroUsd", "\"7\"", "*/15"]) {
    assert.ok(!text.includes(leaked), leaked);
  }
  // And the runner can turn it into observations.
  const observations = observationsFromSnapshot({ healthOk: true, snapshot: s });
  assert.equal(observations["P1b#providerBudgets"], "false");
  assert.equal(observations["P3#credit_reservation_reconciliation"], "stuck");
});

test("a failed section is unknown on its own", () => {
  for (const [section, key] of [["readiness", "readiness"], ["jobs", "scheduledJobs"], ["budgets", "providerBudgets"]]) {
    const result = build({ [section]: failed() });
    assert.equal(result.ok, true, section);
    assert.equal(result.snapshot[key], "unknown", section);
  }
  assert.equal(build({ budgets: ok({ ...budgets, usageUnavailable: true }) }).snapshot.providerBudgets, "unknown");
  assert.equal(build({ readiness: ok({ checks: { database: "yes" } }) }).snapshot.readiness, "unknown");
});

test("bands and the commit fall back honestly", () => {
  assert.deepEqual([0, 1, 2, 3, 99].map(failureBand), ["0", "1", "2", "3+", "3+"]);
  assert.equal(failureBand(-1), null);
  assert.deepEqual(
    [0, 699, 700, 849, 850, 949, 950, 999, 1000, 1200].map((used) => utilisationBand({ usedMicroUsd: used, limitMicroUsd: 1000 })),
    ["<70", "<70", "70-85", "70-85", "85-95", "85-95", ">=95", ">=95", "exhausted", "exhausted"],
  );
  assert.equal(utilisationBand({ usedMicroUsd: 1, limitMicroUsd: 0 }), null);
  assert.equal(build({ commitSha: undefined }).snapshot.commitSha, "0".repeat(40));
  assert.equal(build({ commitSha: "not-a-sha" }).snapshot.commitSha, "0".repeat(40));
});

test("a source that produces an unparseable value makes the build fail closed", () => {
  const badJobs = [{ ...jobs[1], key: "Not An Identifier" }];
  const result = build({ jobs: ok(badJobs) });
  assert.equal(result.ok, false);
});

test("a source that never answers is settled as a rejection within its limit", async () => {
  const { settleWithin } = await import("../scripts/ops-observer/snapshot-core.mjs");
  const started = Date.now();
  const hung = await settleWithin(new Promise(() => {}), 50);
  assert.equal(hung.status, "rejected");
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(await settleWithin(Promise.resolve(7), 50), { status: "fulfilled", value: 7 });
  assert.equal((await settleWithin(Promise.reject(new Error("x")), 50)).status, "rejected");
  // The built snapshot then carries that section as unknown.
  const result = build({ jobs: hung });
  assert.equal(result.snapshot.scheduledJobs, "unknown");
});
