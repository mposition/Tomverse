import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_COHORT_VERSION,
  autoCohortConfig,
  cohortBucket,
  decideAutoCohort,
  describeAutoCohortRefusal,
} from "../lib/autoCohort.ts";
import {
  AUTO_ROLLOUT_READINESS,
  autoRolloutReadiness,
  autoRolloutReadinessProblems,
} from "../lib/autoRolloutReadiness.ts";

// The cohort boundary is the only thing standing between "Auto works in
// shadow" and "Auto answers a real person". These tests are about the ways it
// could be true when it should not be.

const ready = { ready: true, outstanding: [], problems: [] };
const notReady = {
  ready: false,
  outstanding: ["offline_quality_evaluation"],
  problems: [],
};

const config = (overrides = {}) => ({
  killSwitch: false,
  rolloutPercent: 100,
  salt: "cohort-2026-08",
  eligiblePlans: ["Pro", "Max"],
  ...overrides,
});

const subject = (overrides = {}) => ({
  subjectKey: "user_abc",
  isGuest: false,
  plan: "Pro",
  config: config(),
  readiness: ready,
  ...overrides,
});

test("a fully ready, fully enabled rollout routes an eligible subject", () => {
  const decision = decideAutoCohort(subject());
  assert.equal(decision.eligible, true);
  assert.equal(decision.version, AUTO_COHORT_VERSION);
  assert.equal(decision.salt, "cohort-2026-08");
  assert.ok(decision.bucket >= 0 && decision.bucket < 10_000);
});

// A kill switch that another setting can outrank is not a kill switch. This
// is the one an operator reaches for during an incident.
test("the kill switch beats everything, including a 100% ready rollout", () => {
  const decision = decideAutoCohort(subject({ config: config({ killSwitch: true }) }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "kill_switch");
  assert.equal(decision.bucket, null, "no bucket is computed for a killed rollout");
});

// The rule the rollout plan states, enforced where it can actually bind.
test("an outstanding readiness gate refuses everyone, at any percentage", () => {
  for (const rolloutPercent of [1, 50, 100]) {
    const decision = decideAutoCohort(
      subject({ readiness: notReady, config: config({ rolloutPercent }) })
    );
    assert.equal(decision.eligible, false, `${rolloutPercent}% slipped through`);
    assert.equal(decision.reason, "readiness_incomplete");
    assert.deepEqual(decision.outstandingGates, ["offline_quality_evaluation"]);
  }
});

test("readiness is checked above the percentage, so the reason is the real one", () => {
  // Both would refuse. The one reported is the one that has to be fixed
  // first, or the rollout looks like it is merely switched off.
  const decision = decideAutoCohort(
    subject({ readiness: notReady, config: config({ rolloutPercent: 0 }) })
  );
  assert.equal(decision.reason, "readiness_incomplete");
});

test("every default is off, so a deployment that sets nothing routes nobody", () => {
  const fromEmpty = autoCohortConfig({});
  assert.equal(fromEmpty.rolloutPercent, 0);
  assert.deepEqual(fromEmpty.eligiblePlans, []);
  assert.equal(fromEmpty.salt, "unset");
  assert.equal(fromEmpty.killSwitch, false);

  const decision = decideAutoCohort(subject({ config: fromEmpty }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "rollout_disabled");
});

// An unset salt would partition staging and production identically, so the
// same people would be the cohort in both.
test("an unset salt refuses even with a percentage and a plan", () => {
  const decision = decideAutoCohort(
    subject({ config: config({ salt: "unset" }) })
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "rollout_disabled");
});

test("an empty plan allowlist means none, never all", () => {
  const decision = decideAutoCohort(subject({ config: config({ eligiblePlans: [] }) }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "rollout_disabled");
});

test("a plan outside the allowlist is refused, and so is no plan at all", () => {
  assert.equal(decideAutoCohort(subject({ plan: "Free" })).reason, "plan_not_eligible");
  assert.equal(decideAutoCohort(subject({ plan: null })).reason, "plan_not_eligible");
});

// Structural, not commercial: sticky state lives on the conversation and a
// guest's does not survive, so a guest would get a Router that re-decides
// every turn -- a different feature under the same metrics.
test("guests are excluded even on an eligible plan", () => {
  const decision = decideAutoCohort(subject({ isGuest: true, plan: "Pro" }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "guest_not_eligible");
});

// Flapping would change the conversation's model for reasons the user cannot
// see, and reset the hysteresis streak from outside a routing decision.
test("a subject stays on the same side of the boundary across calls", () => {
  const first = decideAutoCohort(subject({ config: config({ rolloutPercent: 50 }) }));
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const again = decideAutoCohort(subject({ config: config({ rolloutPercent: 50 }) }));
    assert.equal(again.eligible, first.eligible);
    assert.equal(again.bucket, first.bucket);
  }
});

test("the bucket is stable for a subject and different across subjects", () => {
  assert.equal(cohortBucket("user_abc", "s"), cohortBucket("user_abc", "s"));
  assert.notEqual(cohortBucket("user_abc", "s"), cohortBucket("user_abd", "s"));
});

// Changing the salt reshuffles the cohort. That has to be a deliberate,
// named act, which is why the salt travels on every decision.
test("a different salt reshuffles the cohort", () => {
  const buckets = new Set();
  for (const salt of ["a", "b", "c"]) buckets.add(cohortBucket("user_abc", salt));
  assert.equal(buckets.size, 3);
});

// Ids are allocated in order, so a modulo over the id itself would correlate
// cohort membership with signup date.
test("sequential subject keys do not produce sequential buckets", () => {
  const buckets = Array.from({ length: 12 }, (_, index) =>
    cohortBucket(`user_${1000 + index}`, "cohort-2026-08")
  );
  const ascending = buckets.every(
    (bucket, index) => index === 0 || bucket > buckets[index - 1]
  );
  assert.equal(ascending, false, "buckets tracked the id order");
});

test("the rollout share is roughly the share of subjects admitted", () => {
  const admitted = (percent) => {
    let count = 0;
    for (let index = 0; index < 4_000; index += 1) {
      const decision = decideAutoCohort(
        subject({
          subjectKey: `user_${index}`,
          config: config({ rolloutPercent: percent }),
        })
      );
      if (decision.eligible) count += 1;
    }
    return (count / 4_000) * 100;
  };

  assert.ok(Math.abs(admitted(10) - 10) < 2, `10% cohort admitted ${admitted(10)}%`);
  assert.ok(Math.abs(admitted(50) - 50) < 3, `50% cohort admitted ${admitted(50)}%`);
  assert.equal(admitted(100), 100);
});

test("a refused-by-bucket decision still reports its bucket", () => {
  let refused = null;
  for (let index = 0; index < 500 && !refused; index += 1) {
    const decision = decideAutoCohort(
      subject({ subjectKey: `user_${index}`, config: config({ rolloutPercent: 1 }) })
    );
    if (!decision.eligible && decision.reason === "outside_cohort") refused = decision;
  }
  assert.ok(refused, "no subject fell outside a 1% cohort");
  assert.equal(typeof refused.bucket, "number");
});

test("every refusal has an operator-readable explanation", () => {
  for (const reason of [
    "kill_switch",
    "readiness_incomplete",
    "rollout_disabled",
    "plan_not_eligible",
    "guest_not_eligible",
    "outside_cohort",
  ]) {
    const text = describeAutoCohortRefusal({ reason, bucket: 1, outstandingGates: ["x"] });
    assert.ok(text.length > 20, `${reason} has no explanation`);
  }
});

// --- the readiness register itself ---

test("the committed register validates and names all three gates", () => {
  assert.deepEqual(autoRolloutReadinessProblems(), []);
  assert.deepEqual(
    AUTO_ROLLOUT_READINESS.map((entry) => entry.id).sort(),
    ["attempt_manifest_boundary", "offline_quality_evaluation", "shadow_report"]
  );
});

// The honest current state, asserted so a future edit that flips a gate
// without evidence has to change this test too.
test("nothing is attested yet, so the register is not ready", () => {
  const state = autoRolloutReadiness();
  assert.equal(state.ready, false);
  assert.equal(state.outstanding.length, 3);
  assert.ok(AUTO_ROLLOUT_READINESS.every((entry) => entry.status === "pending"));
});

const entry = (overrides = {}) => ({
  id: "shadow_report",
  title: "Shadow figures are acceptable",
  measures: "blast radius, not improvement",
  status: "passed",
  attestedBy: "backend-ai-lead",
  attestedAt: "2026-08-12",
  evidence: {
    artifactRef: "docs/ops/shadow-2026-08.md",
    evaluatedCommit: "abc123",
    summary: "candidate availability 96%, disagreement 31%, no_candidate 0.4%",
    expiresAt: "2099-01-01",
    knownLimitations: "regional bias not measurable: region is a filter input, not a RoutingRun column",
  },
  ...overrides,
});

const full = (overrides = {}) => [
  entry(overrides),
  entry({ id: "offline_quality_evaluation", ...overrides }),
  entry({ id: "attempt_manifest_boundary", ...overrides }),
];

test("a complete register of attested gates is ready", () => {
  const state = autoRolloutReadiness(full());
  assert.deepEqual(state.problems, []);
  assert.equal(state.ready, true);
});

// The failure this file exists to prevent: a gate that passed because
// somebody edited a string.
test("a gate cannot pass without a person, a date and complete evidence", () => {
  assert.match(
    autoRolloutReadinessProblems([entry({ attestedBy: null })]).join(" "),
    /naming who attested/
  );
  assert.match(
    autoRolloutReadinessProblems([entry({ attestedAt: null })]).join(" "),
    /without a date/
  );
  assert.match(
    autoRolloutReadinessProblems([entry({ evidence: null })]).join(" "),
    /no evidence/
  );
  for (const field of [
    "artifactRef",
    "evaluatedCommit",
    "summary",
    "expiresAt",
    "knownLimitations",
  ]) {
    const evidence = { ...entry().evidence };
    delete evidence[field];
    assert.ok(
      autoRolloutReadinessProblems([entry({ evidence })]).length > 0,
      `a gate passed with no ${field}`
    );
  }
});

test("a pending gate carrying an attestation is a half-flipped gate", () => {
  const problems = autoRolloutReadinessProblems([
    entry({ status: "pending", evidence: null, attestedAt: null }),
  ]);
  assert.match(problems.join(" "), /pending but carries an attestation/);
});

// Readiness measures a system that keeps changing, so an attestation with no
// deadline would outlive what it described.
test("an expired attestation stops being a pass", () => {
  const stale = full({ evidence: { ...entry().evidence, expiresAt: "2020-01-01" } });
  const state = autoRolloutReadiness(stale);
  assert.equal(state.ready, false);
  assert.match(state.problems.join(" "), /expired/);
});

// "Two of three look passed" is not a state anything should act on.
test("a malformed register is never ready, whatever its entries say", () => {
  const missingGate = [entry(), entry({ id: "offline_quality_evaluation" })];
  const state = autoRolloutReadiness(missingGate);
  assert.equal(state.ready, false);
  assert.equal(state.outstanding.length, 0, "both present entries claim to have passed");
  assert.match(state.problems.join(" "), /no entry for attempt_manifest_boundary/);

  // And the cohort refuses on the strength of that, rather than on a count.
  const decision = decideAutoCohort(subject({ readiness: state }));
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "readiness_incomplete");
});

test("duplicate entries are caught, because one could shadow the other", () => {
  assert.match(
    autoRolloutReadinessProblems([entry(), entry()]).join(" "),
    /appears more than once/
  );
});
