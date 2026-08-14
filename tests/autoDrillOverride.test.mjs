import assert from "node:assert/strict";
import test from "node:test";

import {
  DRILL_OVERRIDE_REASON,
  DRILL_SUBJECTS_ENV,
  decideDrillOverride,
} from "../lib/autoDrillOverride.ts";
import { FAULT_INJECTION_SECRET_ENV } from "../lib/routingFaultInjection.ts";
import { decideAutoCohort } from "../lib/autoCohort.ts";

// The one path that routes a turn while a readiness gate is outstanding. Most
// of this file is about the ways it stays shut -- and the first test is the
// one that matters, because everything else is a defence in depth behind it.

const SECRET = "drill-secret-long-enough";
const SUBJECT = "drill-account-1";

const staging = {
  APP_ENV: "staging",
  [FAULT_INJECTION_SECRET_ENV]: SECRET,
  [DRILL_SUBJECTS_ENV]: SUBJECT,
};
const header = `${SECRET}:attempt_0_pre_token`;

const decide = (overrides = {}) =>
  decideDrillOverride({
    faultHeader: header,
    subjectKey: SUBJECT,
    isGuest: false,
    environment: staging,
    ...overrides,
  });

test("a prepared staging drill may pass an outstanding gate", () => {
  assert.deepEqual(decide(), { allowed: true, reason: DRILL_OVERRIDE_REASON });
});

test("production refuses, under every combination of the other locks", () => {
  // The lock that matters. If this can be opened, the other three are
  // decoration.
  const productions = [
    { ...staging, APP_ENV: "production" },
    { ...staging, APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: "production" },
    // Unlabelled production build: the resolver fails closed and so does this.
    {
      [FAULT_INJECTION_SECRET_ENV]: SECRET,
      [DRILL_SUBJECTS_ENV]: SUBJECT,
      NODE_ENV: "production",
    },
    // Everything an operator could plausibly set, on a production deployment.
    {
      APP_ENV: "production",
      NODE_ENV: "production",
      [FAULT_INJECTION_SECRET_ENV]: SECRET,
      [DRILL_SUBJECTS_ENV]: `${SUBJECT},someone-else`,
      AUTO_ROUTER_ROLLOUT_PERCENT: "100",
      AUTO_ROUTER_ELIGIBLE_PLANS: "Pro,Max",
      AUTO_ROUTER_COHORT_SALT: "drill",
    },
  ];
  for (const environment of productions) {
    const decision = decideDrillOverride({
      faultHeader: header,
      subjectKey: SUBJECT,
      isGuest: false,
      environment,
    });
    assert.equal(decision.allowed, false, JSON.stringify(environment));
    assert.equal(decision.reason, "production");
  }
});

test("the credential is the drill's own, so removing it closes both", () => {
  for (const environment of [
    { ...staging, [FAULT_INJECTION_SECRET_ENV]: undefined },
    { ...staging, [FAULT_INJECTION_SECRET_ENV]: "short" },
  ]) {
    assert.equal(decide({ environment }).reason, "no_credential");
  }
  assert.equal(decide({ faultHeader: null }).reason, "no_credential");
  assert.equal(
    decide({ faultHeader: `wrong-secret:attempt_0_pre_token` }).reason,
    "no_credential"
  );
});

test("a valid credential alone routes nobody", () => {
  // The subject allowlist is separate on purpose: whoever holds the secret
  // still cannot route an arbitrary account.
  assert.equal(
    decide({ environment: { ...staging, [DRILL_SUBJECTS_ENV]: undefined } })
      .reason,
    "subject_not_listed"
  );
  assert.equal(decide({ subjectKey: "someone-else" }).reason, "subject_not_listed");
});

test("a guest is refused, because the product has no such exception", () => {
  assert.equal(decide({ isGuest: true }).reason, "guest");
});

// What the override actually does to the cohort decision, and what it
// deliberately leaves alone.

const pendingReadiness = { ready: false, outstanding: ["shadow_report"] };
const cohortConfig = {
  killSwitch: false,
  rolloutPercent: 100,
  salt: "drill",
  eligiblePlans: ["Pro"],
};

const cohort = (overrides = {}) =>
  decideAutoCohort({
    subjectKey: SUBJECT,
    isGuest: false,
    plan: "Pro",
    config: cohortConfig,
    readiness: pendingReadiness,
    ...overrides,
  });

test("without the override an outstanding gate still refuses", () => {
  const decision = cohort();
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "readiness_incomplete");
});

test("with it the turn routes, and says so on the decision", () => {
  const decision = cohort({ drillOverride: true });
  assert.equal(decision.eligible, true);
  assert.equal(decision.drillOverride, DRILL_OVERRIDE_REASON);
});

test("an ordinary eligible decision carries no override marker", () => {
  // The absence is what makes a genuinely-ready decision readable as one.
  const decision = cohort({
    drillOverride: true,
    readiness: { ready: true, outstanding: [] },
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.drillOverride, undefined);
});

test("the kill switch still outranks it", () => {
  // An operator turning Auto off during a drill must not have to also
  // remember to withdraw a credential.
  const decision = cohort({
    drillOverride: true,
    config: { ...cohortConfig, killSwitch: true },
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "kill_switch");
});

test("it bypasses readiness and nothing else", () => {
  for (const [overrides, reason] of [
    [{ config: { ...cohortConfig, rolloutPercent: 0 } }, "rollout_disabled"],
    [{ config: { ...cohortConfig, eligiblePlans: [] } }, "rollout_disabled"],
    [{ config: { ...cohortConfig, salt: "unset" } }, "rollout_disabled"],
    [{ plan: "Free" }, "plan_not_eligible"],
    [{ isGuest: true }, "guest_not_eligible"],
  ]) {
    const decision = cohort({ drillOverride: true, ...overrides });
    assert.equal(decision.eligible, false, reason);
    assert.equal(decision.reason, reason);
  }
});

test("the register itself is untouched by any of this", () => {
  // The alternative to this module was recording a gate as `passed` when it is
  // not. That is worse in a way that outlives the drill: a false entry in the
  // audit record of a human judgement is indistinguishable from a real one
  // forever after.
  const before = cohort();
  cohort({ drillOverride: true });
  assert.deepEqual(cohort(), before);
});
