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
import { QA_RELEASE_BYPASS_CANDIDATES } from "./qaReleaseLaneRulesetsCore.ts";

export const QA_RELEASE_TEST_BRANCHES = Object.freeze({
  /** Copies main's protection; the update ruleset applies. */
  mainMirror: "qa-lane-test/main-mirror",
  /** A base that is neither develop nor main; the update ruleset applies. */
  otherBase: "qa-lane-test/other-base",
  /** Copies develop's protection; the develop ruleset applies. */
  developMirror: "qa-lane-test/develop-mirror",
  /**
   * Heads of the develop-mirror pull request (GitHub allows one open pull
   * request per head and base); no ruleset. The develop green commit.
   */
  head: "qa-lane-test/head",
  headReviewed: "qa-lane-test/head-reviewed",
  /**
   * Heads of the main-mirror and other-base pull requests: a merged main
   * pull request's head whose required checks passed, with both bases at its
   * parent, so they merge cleanly and meet the classic checks. A develop
   * commit there conflicts once develop and main diverge, and a conflict
   * refusal says nothing about the rules (2026-10-08). No ruleset.
   */
  mainHead: "qa-lane-test/main-head",
  mainHeadReviewed: "qa-lane-test/main-head-reviewed",
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

const observedOf = (status: number | null, message: string | null): "refused" | "succeeded" | "unknown" => {
  if (status === null) return "unknown";
  // A merge refused for conflicts was never put to the rules.
  if (/merge conflict/i.test(message ?? "")) return "unknown";
  if (status >= 200 && status < 300) return "succeeded";
  if (status >= 400 && status < 500) return "refused";
  return "unknown";
};

/**
 * Each observation against its expectation. An answer GitHub did not give
 * (no status, a 5xx) or a merge refused for conflicts is unknown and never
 * counts as the expected one.
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
    const observed = result ? observedOf(result.status, result.message) : "unknown";
    const namesRule = /\brule/i.test(result?.message ?? "");
    const ok = observed === spec.expect && (spec.id !== "app_merge_reviewed_main" || namesRule);
    return { id: spec.id, expect: spec.expect, observed, ok, namesRule };
  });
  return { passed: verdicts.every((verdict) => verdict.ok), verdicts };
}

/** One update of a bypass App's branch under the test ruleset, from GitHub's repository activity. */
export type QaReleaseAutomationUpdate = { appId: number; ref: string; activityType: string; at: string };

const AUTOMATION_ACTIVITY = new Set(["push", "force_push", "branch_creation"]);

/**
 * Item 7's last observation: every App on the bypass list updated one of its
 * own branches -- which the test update ruleset covers -- after the test
 * rulesets went on, and GitHub recorded it. Built from
 * `GET /repos/{o}/{r}/activity` entries; anything else in them is ignored.
 */
export function qaReleaseAutomationUpdates(activity: readonly unknown[], bypassAppIds: readonly number[], sinceIso: string): QaReleaseAutomationUpdate[] {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) throw new Error("since_invalid");
  const updates: QaReleaseAutomationUpdate[] = [];
  for (const raw of activity) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const actor = entry.actor && typeof entry.actor === "object" ? (entry.actor as Record<string, unknown>).login : null;
    if (typeof entry.ref !== "string" || typeof entry.timestamp !== "string" || typeof entry.activity_type !== "string") continue;
    if (!AUTOMATION_ACTIVITY.has(entry.activity_type) || !(Date.parse(entry.timestamp) >= since)) continue;
    for (const candidate of QA_RELEASE_BYPASS_CANDIDATES) {
      const prefix = `refs/heads/${candidate.branchPattern.replace(/\*\*$/, "")}`;
      if (bypassAppIds.includes(candidate.appId) && actor === candidate.botLogin && entry.ref.startsWith(prefix)) {
        updates.push({ appId: candidate.appId, ref: entry.ref, activityType: entry.activity_type, at: entry.timestamp });
      }
    }
  }
  return updates.sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref));
}

/** Which bypass Apps have no recorded update; empty when each has at least one. */
export function qaReleaseAutomationMissing(updates: readonly QaReleaseAutomationUpdate[], bypassAppIds: readonly number[]): number[] {
  return [...new Set(bypassAppIds)].filter((appId) => !updates.some((update) => update.appId === appId)).sort((a, b) => a - b);
}

export type QaReleaseObservationRecord = {
  recordVersion: 2;
  observedAt: string;
  repository: string;
  observationAppId: number;
  bypassAppIds: number[];
  /** The real branches' protection, read just before the observations (item 10). */
  protection: { develop: QaReleaseBranchProtection; main: QaReleaseBranchProtection };
  results: QaReleaseObservationResult[];
  verdict: { passed: boolean; verdicts: QaReleaseObservationVerdict[] };
  /** Item 7: the bypass automation's own branch updates under the test ruleset, since it went on. */
  automation: { since: string; updates: QaReleaseAutomationUpdate[]; missingAppIds: number[] };
};

/**
 * Whether a record still licenses applying the real rulesets: it passed --
 * the eight observations and an update by every bypass App -- it names the
 * same bypass list, and the real branches' protection now is the one it
 * recorded (item 10: a change after the observation voids it).
 */
export function qaReleaseRecordStillHolds(
  record: QaReleaseObservationRecord,
  now: { develop: QaReleaseBranchProtection; main: QaReleaseBranchProtection; bypassAppIds: readonly number[] },
): { holds: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (record.recordVersion !== 2) reasons.push("record_version");
  if (!judgeQaReleaseObservations(record.results).passed) reasons.push("observations_not_passed");
  const updates = Array.isArray(record.automation?.updates) ? record.automation.updates : [];
  if (qaReleaseAutomationMissing(updates, record.bypassAppIds ?? []).length > 0) reasons.push("automation_not_observed");
  const recorded = [...record.bypassAppIds].sort((a, b) => a - b).join(",");
  const requested = [...now.bypassAppIds].sort((a, b) => a - b).join(",");
  if (recorded !== requested) reasons.push("bypass_list_differs");
  for (const branch of ["develop", "main"] as const) {
    for (const difference of qaReleaseProtectionDifferences(record.protection[branch], now[branch])) reasons.push(`${branch}.${difference}`);
  }
  return { holds: reasons.length === 0, reasons };
}
