/**
 * The one way a turn may be routed by Auto while a readiness gate is
 * outstanding, and the reasons it almost never is.
 *
 * ## The circularity this exists to break
 *
 * `docs/ops/tomverse-chat-fallback-drill.md` needs the drill account's turn to
 * be *routed*, because a fallback only happens on a routed turn. Routing needs
 * `lib/autoRolloutReadiness.ts` to say ready. And the register is static code
 * with no environment dimension: attesting a gate to make staging work commits
 * the same `passed` to production. So the runbook's "attested in staging only"
 * was not a thing that could be done — following it would have meant passing a
 * production gate to run a drill, which is the rollout boundary failing at
 * exactly the moment it is being tested.
 *
 * The alternative to a narrow, request-scoped hole is recording a gate as
 * `passed` when it is not. That is worse in a way that outlives the drill: the
 * register is the audit record of a human judgement, and a false entry in it is
 * indistinguishable from a real one forever after.
 *
 * ## What is bypassed, and what is not
 *
 * **Readiness only.** Not the kill switch, not the plan allowlist, not the
 * guest exclusion, not the cohort bucket. An operator running a drill still
 * has to put the account on an eligible plan and set a rollout percentage, and
 * an operator reaching for the kill switch mid-drill still gets it. The hole is
 * the smallest one that makes the drill possible.
 *
 * ## Why it cannot be reached in production
 *
 * Four locks, all required, and the first is the one that matters:
 *
 * 1. **Not production.** `resolveDeploymentEnvironment` fails closed, so an
 *    unlabelled deployment reads as production and nothing here engages. No
 *    combination of the other three opens it.
 * 2. **The fault-injection credential.** The same secret and header the drill
 *    already carries — one credential, not two, and one thing to remove when
 *    the drill is over. A deployment with no
 *    `ROUTING_FAULT_INJECTION_SECRET` has no override either.
 * 3. **A named subject.** `AUTO_ROUTER_DRILL_SUBJECTS`, an explicit allowlist.
 *    Empty means nobody, so a valid credential alone routes no one.
 * 4. **Not a guest.** Guests are excluded from Auto structurally, and a drill
 *    is not a reason to make an exception the product does not have.
 *
 * Every use is recorded as `staging_drill_override` on the decision, so a
 * routed turn that took this path is never mistaken for one that qualified.
 */

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { decideFaultInjection } from "@/lib/routingFaultInjection";

export const DRILL_SUBJECTS_ENV = "AUTO_ROUTER_DRILL_SUBJECTS";

/** The reason recorded on a decision that took this path. */
export const DRILL_OVERRIDE_REASON = "staging_drill_override";

export type DrillOverrideRefusal =
  | "production"
  | "no_credential"
  | "subject_not_listed"
  | "guest";

export type DrillOverrideDecision =
  | { allowed: true; reason: typeof DRILL_OVERRIDE_REASON }
  | { allowed: false; reason: DrillOverrideRefusal };

const drillSubjects = (environment: NodeJS.ProcessEnv): readonly string[] =>
  (environment[DRILL_SUBJECTS_ENV] || "")
    .split(",")
    .map((subject) => subject.trim())
    .filter(Boolean);

/**
 * Whether this request may skip the readiness gate.
 *
 * Production is checked first and separately from the credential, so the
 * refusal a production deployment produces is `production` whatever else the
 * request carries — a caller probing for the override learns only that it is
 * production, which they could see from the URL.
 */
export const decideDrillOverride = (input: {
  /** The `X-Tomverse-Fault-Injection` header, verbatim. */
  faultHeader: string | null | undefined;
  subjectKey: string;
  isGuest: boolean;
  environment?: NodeJS.ProcessEnv;
}): DrillOverrideDecision => {
  const environment = input.environment ?? process.env;
  if (resolveDeploymentEnvironment(environment) === "production") {
    return { allowed: false, reason: "production" };
  }
  // The same credential the drill already carries. Reusing it means one secret
  // to configure and one to remove, and it makes "the override outlived the
  // drill" impossible: deleting the secret closes both.
  if (!decideFaultInjection(input.faultHeader, environment).inject) {
    return { allowed: false, reason: "no_credential" };
  }
  if (input.isGuest) return { allowed: false, reason: "guest" };
  const subjects = drillSubjects(environment);
  if (!subjects.includes(input.subjectKey)) {
    return { allowed: false, reason: "subject_not_listed" };
  }
  return { allowed: true, reason: DRILL_OVERRIDE_REASON };
};
