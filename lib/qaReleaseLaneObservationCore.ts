/**
 * The S-M0 test-branch observations (docs/policy/qa-release-agent.md version
 * 7, section 8 items 7, 9 and 10) and how they are judged.
 *
 * The rulesets are first applied to test branches that copy the real
 * branches' protection; these observations show that the protection does
 * what the policy relies on. The real rulesets go on only when every one is
 * as expected, and only while the real branches' protection is still the one
 * recorded with the observations.
 *
 * Pure: the harness (scripts/qa-release-lane-observe.mjs) performs each
 * action and hands back what GitHub answered.
 */
import type { QaReleaseBranchProtection } from "./qaReleaseBranchProtectionCore.ts";
import { qaReleaseProtectionDifferences } from "./qaReleaseBranchProtectionCore.ts";

export const QA_RELEASE_TEST_BRANCHES = Object.freeze({
  /** Copies main's protection; the update ruleset applies. */
  mainMirror: "qa-lane-test/main-mirror",
  /** A base that is neither develop nor main; the update ruleset applies. */
  otherBase: "qa-lane-test/other-base",
  /** Copies develop's protection; the develop ruleset applies. */
  developMirror: "qa-lane-test/develop-mirror",
  /** Heads of the observation pull requests (GitHub allows one open pull request per head and base); no ruleset. */
  head: "qa-lane-test/head",
  headReviewed: "qa-lane-test/head-reviewed",
});

export type QaReleaseObservationId =
  | "app_merge_unreviewed_main"
  | "app_merge_reviewed_main"
  | "app_push_main"
  | "app_merge_other_base"
  | "operator_merge_main"
  | "app_push_green_develop"
  | "app_merge_develop"
  | "operator_push_develop";

export type QaReleaseObservationSpec = {
  id: QaReleaseObservationId;
  policyItem: "8.7" | "8.9";
  actor: "app" | "operator";
  expect: "refused" | "succeeded";
  what: string;
};

/** In the order the harness runs them: refusals on a branch before the success that changes it. */
export const QA_RELEASE_OBSERVATIONS: readonly QaReleaseObservationSpec[] = Object.freeze([
  { id: "app_merge_unreviewed_main", policyItem: "8.7", actor: "app", expect: "refused", what: "App merges an unreviewed pull request into the main mirror" },
  { id: "app_merge_reviewed_main", policyItem: "8.7", actor: "app", expect: "refused", what: "App merges a pull request a person approved into the main mirror" },
  { id: "app_push_main", policyItem: "8.7", actor: "app", expect: "refused", what: "App moves the main mirror's ref directly" },
  { id: "app_merge_other_base", policyItem: "8.7", actor: "app", expect: "refused", what: "App merges a pull request whose base is neither develop nor main" },
  { id: "operator_merge_main", policyItem: "8.7", actor: "operator", expect: "succeeded", what: "The operator merges a pull request into the main mirror" },
  { id: "app_push_green_develop", policyItem: "8.9", actor: "app", expect: "refused", what: "App moves the develop mirror's ref to a commit whose required checks passed" },
  { id: "app_merge_develop", policyItem: "8.9", actor: "app", expect: "succeeded", what: "App merges a pull request into the develop mirror" },
  { id: "operator_push_develop", policyItem: "8.9", actor: "operator", expect: "succeeded", what: "The operator moves the develop mirror's ref directly" },
] as const);

/** What GitHub answered for one action: the status and its message, nothing else. */
export type QaReleaseObservationResult = {
  id: QaReleaseObservationId;
  status: number | null;
  /** GitHub's error message, cut to 200 characters; null on success or no answer. */
  message: string | null;
};

export type QaReleaseObservationVerdict = {
  id: QaReleaseObservationId;
  expect: "refused" | "succeeded";
  observed: "refused" | "succeeded" | "unknown";
  ok: boolean;
  /** A refusal that names a rule (ruleset) rather than another reason; informational. */
  namesRule: boolean;
};

const observedOf = (status: number | null): "refused" | "succeeded" | "unknown" => {
  if (status === null) return "unknown";
  if (status >= 200 && status < 300) return "succeeded";
  if (status >= 400 && status < 500) return "refused";
  return "unknown";
};

/**
 * Each observation against its expectation. An answer GitHub did not give
 * (no status, a 5xx) is unknown and never counts as the expected one.
 * The reviewed-merge refusal must name a rule: a classic-protection refusal
 * there would mean the ruleset was not what stopped it.
 */
export function judgeQaReleaseObservations(results: readonly QaReleaseObservationResult[]): {
  passed: boolean;
  verdicts: QaReleaseObservationVerdict[];
} {
  const verdicts = QA_RELEASE_OBSERVATIONS.map((spec): QaReleaseObservationVerdict => {
    const matching = results.filter((result) => result.id === spec.id);
    const result = matching.length === 1 ? matching[0] : null;
    const observed = result ? observedOf(result.status) : "unknown";
    const namesRule = /\brule/i.test(result?.message ?? "");
    const ok = observed === spec.expect && (spec.id !== "app_merge_reviewed_main" || namesRule);
    return { id: spec.id, expect: spec.expect, observed, ok, namesRule };
  });
  return { passed: verdicts.every((verdict) => verdict.ok), verdicts };
}

export type QaReleaseObservationRecord = {
  recordVersion: 1;
  observedAt: string;
  repository: string;
  observationAppId: number;
  bypassAppIds: number[];
  /** The real branches' protection, read just before the observations (item 10). */
  protection: { develop: QaReleaseBranchProtection; main: QaReleaseBranchProtection };
  results: QaReleaseObservationResult[];
  verdict: { passed: boolean; verdicts: QaReleaseObservationVerdict[] };
  /** Item 7's automation updates, which this harness cannot trigger: the operator writes what was seen. */
  automationUpdatesObserved: "not_observed";
};

/**
 * Whether a record still licenses applying the real rulesets: it passed, it
 * names the same bypass list, and the real branches' protection now is the
 * one it recorded (item 10: a change after the observation voids it).
 */
export function qaReleaseRecordStillHolds(
  record: QaReleaseObservationRecord,
  now: { develop: QaReleaseBranchProtection; main: QaReleaseBranchProtection; bypassAppIds: readonly number[] },
): { holds: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (record.recordVersion !== 1) reasons.push("record_version");
  if (!judgeQaReleaseObservations(record.results).passed) reasons.push("observations_not_passed");
  const recorded = [...record.bypassAppIds].sort((a, b) => a - b).join(",");
  const requested = [...now.bypassAppIds].sort((a, b) => a - b).join(",");
  if (recorded !== requested) reasons.push("bypass_list_differs");
  for (const branch of ["develop", "main"] as const) {
    for (const difference of qaReleaseProtectionDifferences(record.protection[branch], now[branch])) reasons.push(`${branch}.${difference}`);
  }
  return { holds: reasons.length === 0, reasons };
}
