/**
 * A branch's effective protection, in one comparable shape
 * (docs/policy/qa-release-agent.md version 7, section 8 item 10).
 *
 * Before the test-branch observations of items 7 and 9, the current
 * protection of the target branch -- classic branch protection and every
 * ruleset rule that applies to it -- is read and recorded, and the
 * observations count only while it stays the same. This module turns the two
 * GitHub answers into one normalised record and compares two records, so
 * "the same" is decided by code rather than by reading JSON.
 *
 * Pure: the caller fetches. An answer that is not the expected shape is an
 * error, never a guess.
 */

export type QaReleaseClassicProtection =
  | { present: false }
  | {
      present: true;
      pullRequestRequired: boolean;
      requiredApprovals: number | null;
      dismissStaleReviews: boolean | null;
      requireCodeOwnerReviews: boolean | null;
      requireLastPushApproval: boolean | null;
      requiredChecks: string[] | null;
      strict: boolean | null;
      enforceAdmins: boolean;
      allowForcePushes: boolean;
      allowDeletions: boolean;
      requiredLinearHistory: boolean;
    };

export type QaReleaseRulesetRule = { type: string; rulesetId: number; parameters: unknown };

export type QaReleaseBranchProtection = {
  branch: string;
  classic: QaReleaseClassicProtection;
  rules: QaReleaseRulesetRule[];
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("protection_shape");
  return value as Json;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("protection_shape");
  return value;
};
const enabled = (value: unknown): boolean => (value === undefined || value === null ? false : bool(record(value).enabled));

/** `GET /repos/{o}/{r}/branches/{b}/protection`; null when GitHub answered 404 (no classic protection). */
export function qaReleaseClassicProtection(raw: unknown | null): QaReleaseClassicProtection {
  if (raw === null) return { present: false };
  const body = record(raw);
  const reviews = body.required_pull_request_reviews === undefined ? null : record(body.required_pull_request_reviews);
  const checks = body.required_status_checks === undefined || body.required_status_checks === null ? null : record(body.required_status_checks);
  let contexts: string[] | null = null;
  if (checks) {
    const list = Array.isArray(checks.checks) ? checks.checks.map((check) => record(check).context) : checks.contexts;
    if (!Array.isArray(list) || !list.every((context) => typeof context === "string")) throw new Error("protection_shape");
    contexts = [...new Set(list as string[])].sort();
  }
  const count = reviews?.required_approving_review_count;
  if (reviews && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) throw new Error("protection_shape");
  return {
    present: true,
    pullRequestRequired: reviews !== null,
    requiredApprovals: reviews ? (count as number) : null,
    dismissStaleReviews: reviews ? bool(reviews.dismiss_stale_reviews) : null,
    requireCodeOwnerReviews: reviews ? bool(reviews.require_code_owner_reviews) : null,
    requireLastPushApproval: reviews ? bool(reviews.require_last_push_approval ?? false) : null,
    requiredChecks: contexts,
    strict: checks ? bool(checks.strict) : null,
    enforceAdmins: enabled(body.enforce_admins),
    allowForcePushes: enabled(body.allow_force_pushes),
    allowDeletions: enabled(body.allow_deletions),
    requiredLinearHistory: enabled(body.required_linear_history),
  };
}

/** `GET /repos/{o}/{r}/rules/branches/{b}`: every active ruleset rule on the branch, in a stable order. */
export function qaReleaseRulesetRules(raw: unknown): QaReleaseRulesetRule[] {
  if (!Array.isArray(raw)) throw new Error("protection_shape");
  return raw
    .map((entry) => {
      const rule = record(entry);
      const id = rule.ruleset_id;
      if (typeof rule.type !== "string" || typeof id !== "number") throw new Error("protection_shape");
      return { type: rule.type, rulesetId: id, parameters: rule.parameters ?? null };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.rulesetId - b.rulesetId);
}

/** Stable JSON: object keys sorted at every depth, so equal values serialise equally. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Json)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * What differs between two records of the same branch, by field; empty when
 * they are the same protection. Ruleset ids are compared too: a ruleset
 * deleted and recreated with the same rules is a change somebody made.
 */
export function qaReleaseProtectionDifferences(expected: QaReleaseBranchProtection, actual: QaReleaseBranchProtection): string[] {
  const differences: string[] = [];
  if (expected.branch !== actual.branch) differences.push("branch");
  const a = expected.classic as Json;
  const b = actual.classic as Json;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (canonical(a[key]) !== canonical(b[key])) differences.push(`classic.${key}`);
  }
  if (canonical(expected.rules) !== canonical(actual.rules)) differences.push("rules");
  return differences;
}

/**
 * develop's protection as the policy records it (section 8 item 10, read on
 * 2026-10-03): PR required with zero approvals, three required checks, not
 * strict, admins not enforced, no ruleset.
 */
export const QA_RELEASE_DEVELOP_PROTECTION_RECORDED: QaReleaseBranchProtection = Object.freeze({
  branch: "develop",
  classic: Object.freeze({
    present: true,
    pullRequestRequired: true,
    requiredApprovals: 0,
    dismissStaleReviews: false,
    requireCodeOwnerReviews: false,
    requireLastPushApproval: false,
    requiredChecks: [
      "Admin Console E2E (PostgreSQL)",
      "Build and test the Rust workspace",
      "Security, unit, build, and Chromium smoke tests",
    ],
    strict: false,
    enforceAdmins: false,
    allowForcePushes: false,
    allowDeletions: false,
    requiredLinearHistory: false,
  }) as QaReleaseClassicProtection,
  rules: [],
}) as QaReleaseBranchProtection;
