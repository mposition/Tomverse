/**
 * Who Auto is allowed to route, and why anybody else is not.
 *
 * A limited cohort is the step between "Auto works in shadow" and "Auto
 * answers everyone", and the whole value of it is that the boundary is
 * explicit. This module is that boundary: one pure function, one enumerated
 * set of refusals, and no path that reaches `eligible: true` without every
 * precondition being true at once.
 *
 * Pure on purpose. The chat route calls it, the admin surface can call it to
 * explain a decision, and a test can call it a thousand times with different
 * subjects to check the bucketing is stable -- none of which is possible if
 * the rule lives inline in a request handler.
 *
 * ## The order of the refusals is part of the design
 *
 * A refusal reports the most fundamental reason, not the first one noticed:
 *
 * 1. **kill switch** -- unconditional, checked before anything else. An
 *    operator turning Auto off in an incident must not have to reason about
 *    percentages, plans or readiness, and a kill switch that could be
 *    outranked by another setting is not a kill switch.
 * 2. **readiness** -- the three attestations in `lib/autoRolloutReadiness.ts`.
 *    Placed above the rollout percentage so that setting the percentage to 100
 *    changes nothing while a gate is outstanding. The rule the rollout plan
 *    states -- if any one is missing it stays shadow -- is enforced here or it
 *    is enforced nowhere.
 * 3. **rollout disabled / zero percent** -- the ordinary off state.
 * 4. **plan** -- what the account is entitled to.
 * 5. **guest** -- see below.
 * 6. **bucket** -- the cohort boundary itself, the only refusal that means
 *    "everything is fine, this subject is simply not in the sample".
 *
 * Reporting the bucket for a subject who was actually blocked by an
 * outstanding gate would make the rollout look larger than it is.
 */

import { createHash } from "node:crypto";

import { autoRolloutReadiness, type AutoReadinessGateId } from "@/lib/autoRolloutReadiness";

/** Bump when bucketing, salt handling or the refusal set changes. */
export const AUTO_COHORT_VERSION = "auto-cohort-v1";

/** Buckets per cohort. 10,000 makes a 0.01% cohort expressible. */
const BUCKETS = 10_000;

export type AutoCohortRefusal =
  | "kill_switch"
  | "readiness_incomplete"
  | "rollout_disabled"
  | "plan_not_eligible"
  | "guest_not_eligible"
  | "outside_cohort";

export type AutoCohortDecision =
  | { eligible: true; bucket: number; version: string; salt: string }
  | {
      eligible: false;
      reason: AutoCohortRefusal;
      /** Which gates are outstanding, on `readiness_incomplete` only. */
      outstandingGates?: readonly AutoReadinessGateId[];
      /** Present whenever a bucket was computed, so a near-miss is legible. */
      bucket: number | null;
      version: string;
      salt: string;
    };

export type AutoCohortConfig = {
  /** Unconditional off. Any truthy value disables Auto for everybody. */
  killSwitch: boolean;
  /** 0–100. The share of eligible subjects Auto routes. */
  rolloutPercent: number;
  /**
   * Versioned, because changing it reshuffles who is in the cohort. A silent
   * reshuffle mid-measurement replaces the population under the metrics
   * without replacing the metrics, so the salt is named and the name is
   * recorded on every decision.
   */
  salt: string;
  /** Plans Auto may route. Empty means none, never "all". */
  eligiblePlans: readonly string[];
};

const parsePercent = (raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
};

/**
 * Configuration from the environment, defaulting to off in every field.
 *
 * Every default here is the safe one, so a deployment that sets nothing routes
 * nobody. The alternative -- defaulting to a small cohort because it is
 * "probably fine" -- makes a missing variable indistinguishable from a
 * deliberate rollout.
 */
export const autoCohortConfig = (
  env: NodeJS.ProcessEnv = process.env
): AutoCohortConfig => ({
  killSwitch: env.AUTO_ROUTER_KILL_SWITCH === "on",
  rolloutPercent: parsePercent(env.AUTO_ROUTER_ROLLOUT_PERCENT),
  salt: env.AUTO_ROUTER_COHORT_SALT || "unset",
  eligiblePlans: (env.AUTO_ROUTER_ELIGIBLE_PLANS || "")
    .split(",")
    .map((plan) => plan.trim())
    .filter(Boolean),
});

/**
 * A stable bucket in [0, BUCKETS) for a subject.
 *
 * Deterministic, so a person stays on the same side of the boundary from one
 * turn to the next. Flapping would be worse than either state: the
 * conversation's model would change for reasons the user cannot see, the
 * sticky/hysteresis state would be reset by something other than a routing
 * decision, and no metric could be attributed to either arm.
 *
 * Hashed rather than taken from the id directly because ids are allocated in
 * order, and a modulo over sequential ids correlates cohort membership with
 * signup date.
 */
export const cohortBucket = (subjectKey: string, salt: string): number => {
  const digest = createHash("sha256").update(`${salt}:${subjectKey}`).digest();
  return digest.readUInt32BE(0) % BUCKETS;
};

export type AutoCohortInput = {
  /** Stable per person. Guests have one, but see `isGuest`. */
  subjectKey: string;
  isGuest: boolean;
  plan: string | null;
  config?: AutoCohortConfig;
  /** Injected so a test can vary readiness without editing the register. */
  readiness?: ReturnType<typeof autoRolloutReadiness>;
};

/**
 * Whether this subject is routed by Auto on this request.
 *
 * Guests are excluded, and the reason is structural rather than commercial:
 * Auto's stickiness and hysteresis live on the conversation, a guest's
 * conversation state does not survive, so a guest would get a Router that
 * re-decides from scratch every turn. That is a different feature from the one
 * being evaluated, and putting it in the same cohort would mix two behaviours
 * under one set of metrics.
 */
export const decideAutoCohort = (input: AutoCohortInput): AutoCohortDecision => {
  const config = input.config ?? autoCohortConfig();
  const shared = { version: AUTO_COHORT_VERSION, salt: config.salt };

  if (config.killSwitch) {
    return { eligible: false, reason: "kill_switch", bucket: null, ...shared };
  }

  const readiness = input.readiness ?? autoRolloutReadiness();
  if (!readiness.ready) {
    return {
      eligible: false,
      reason: "readiness_incomplete",
      outstandingGates: readiness.outstanding,
      bucket: null,
      ...shared,
    };
  }

  if (config.rolloutPercent <= 0 || config.eligiblePlans.length === 0) {
    return { eligible: false, reason: "rollout_disabled", bucket: null, ...shared };
  }

  if (input.isGuest) {
    return { eligible: false, reason: "guest_not_eligible", bucket: null, ...shared };
  }

  if (!input.plan || !config.eligiblePlans.includes(input.plan)) {
    return { eligible: false, reason: "plan_not_eligible", bucket: null, ...shared };
  }

  // An unset salt would put every deployment on the same partition of users,
  // so staging and production would evaluate Auto on the same people.
  if (config.salt === "unset") {
    return { eligible: false, reason: "rollout_disabled", bucket: null, ...shared };
  }

  const bucket = cohortBucket(input.subjectKey, config.salt);
  if (bucket >= Math.round(config.rolloutPercent * (BUCKETS / 100))) {
    return { eligible: false, reason: "outside_cohort", bucket, ...shared };
  }

  return { eligible: true, bucket, ...shared };
};

/**
 * A refusal as something a person can act on.
 *
 * Not user-facing copy: the user is never told they are outside a cohort,
 * because to them nothing has gone wrong -- they get the model they chose,
 * which is the product working. This is for operators reading a log or an
 * admin panel.
 */
export const describeAutoCohortRefusal = (
  decision: Extract<AutoCohortDecision, { eligible: false }>
): string => {
  switch (decision.reason) {
    case "kill_switch":
      return "AUTO_ROUTER_KILL_SWITCH is on; Auto is disabled for everybody.";
    case "readiness_incomplete":
      return (
        "Auto rollout readiness is incomplete: " +
        `${(decision.outstandingGates ?? []).join(", ") || "the register does not validate"}. ` +
        "Until every gate is attested, Auto stays in shadow."
      );
    case "rollout_disabled":
      return "The rollout is off: no percentage, no eligible plans, or no cohort salt set.";
    case "plan_not_eligible":
      return "This account's plan is not in AUTO_ROUTER_ELIGIBLE_PLANS.";
    case "guest_not_eligible":
      return "Guests are excluded: conversation-scoped sticky state does not survive a guest session.";
    case "outside_cohort":
      return `Bucket ${decision.bucket} falls outside the current rollout share.`;
  }
};
