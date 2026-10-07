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
 * Every setting GitHub returns is kept: the ones this module knows by name,
 * and any other under `unrecognized`, so a change to a setting nobody
 * anticipated is still a difference rather than invisible.
 *
 * Pure: the caller fetches. An answer that is not the expected shape is an
 * error, never a guess.
 */

export type QaReleaseRequiredCheck = { context: string; appId: number | null };

/** Users, teams and apps named by a classic list (push restrictions, review bypass, dismissal). */
export type QaReleaseActorList = { users: string[]; teams: string[]; apps: string[] };

export type QaReleaseClassicProtection =
  | { present: false }
  | {
      present: true;
      pullRequestRequired: boolean;
      requiredApprovals: number | null;
      dismissStaleReviews: boolean | null;
      requireCodeOwnerReviews: boolean | null;
      requireLastPushApproval: boolean | null;
      /** Who may dismiss reviews; null when GitHub returned no list. */
      dismissalRestrictions: QaReleaseActorList | null;
      /** Who may merge without the required reviews; null when GitHub returned no list. */
      reviewBypass: QaReleaseActorList | null;
      /** Each required check with the App that must provide it (null: any App). */
      requiredChecks: QaReleaseRequiredCheck[] | null;
      strict: boolean | null;
      /** Who may push at all; null when the branch has no push restriction (an empty list is a restriction). */
      restrictions: QaReleaseActorList | null;
      enforceAdmins: boolean;
      allowForcePushes: boolean;
      allowDeletions: boolean;
      requiredLinearHistory: boolean;
      requiredConversationResolution: boolean;
      requiredSignatures: boolean;
      lockBranch: boolean;
      blockCreations: boolean;
      allowForkSyncing: boolean;
      /**
       * Settings this module does not know, by key, as GitHub returned them:
       * a change to one is still a difference, and a protection holding one
       * is never claimed to have been copied.
       */
      unrecognized: Record<string, unknown>;
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

const namesOf = (value: unknown, key: "login" | "slug"): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("protection_shape");
  return value
    .map((entry) => {
      const name = record(entry)[key];
      if (typeof name !== "string") throw new Error("protection_shape");
      return name;
    })
    .sort();
};
/**
 * A classic actor list, or null only when GitHub returned none. A list that is
 * present but names nobody is kept as such: push restrictions with no
 * allowed actor are a restriction, not its absence.
 */
const actorList = (value: unknown): QaReleaseActorList | null => {
  if (value === undefined || value === null) return null;
  const list = record(value);
  return { users: namesOf(list.users, "login"), teams: namesOf(list.teams, "slug"), apps: namesOf(list.apps, "slug") };
};

const TOP_LEVEL_KEYS = new Set([
  "url",
  "required_pull_request_reviews",
  "required_status_checks",
  "restrictions",
  "enforce_admins",
  "allow_force_pushes",
  "allow_deletions",
  "required_linear_history",
  "required_conversation_resolution",
  "required_signatures",
  "lock_branch",
  "block_creations",
  "allow_fork_syncing",
]);
const REVIEW_KEYS = new Set([
  "url",
  "dismiss_stale_reviews",
  "require_code_owner_reviews",
  "require_last_push_approval",
  "required_approving_review_count",
  "dismissal_restrictions",
  "bypass_pull_request_allowances",
]);
const CHECK_KEYS = new Set(["url", "strict", "contexts", "contexts_url", "checks", "enforcement_level"]);

const requiredChecksOf = (checks: Json): QaReleaseRequiredCheck[] => {
  let list: QaReleaseRequiredCheck[];
  if (Array.isArray(checks.checks)) {
    list = checks.checks.map((entry) => {
      const check = record(entry);
      if (typeof check.context !== "string") throw new Error("protection_shape");
      const appId = check.app_id;
      if (appId !== null && appId !== undefined && (typeof appId !== "number" || !Number.isSafeInteger(appId))) {
        throw new Error("protection_shape");
      }
      return { context: check.context, appId: typeof appId === "number" ? appId : null };
    });
  } else if (Array.isArray(checks.contexts) && checks.contexts.every((context) => typeof context === "string")) {
    list = (checks.contexts as string[]).map((context) => ({ context, appId: null }));
  } else {
    throw new Error("protection_shape");
  }
  const seen = new Set<string>();
  return list
    .filter((check) => {
      const key = `${check.context}|${check.appId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.context.localeCompare(b.context) || (a.appId ?? -1) - (b.appId ?? -1));
};

/** `GET /repos/{o}/{r}/branches/{b}/protection`; null when GitHub answered 404 (no classic protection). */
export function qaReleaseClassicProtection(raw: unknown | null): QaReleaseClassicProtection {
  if (raw === null) return { present: false };
  const body = record(raw);
  const reviews = body.required_pull_request_reviews === undefined ? null : record(body.required_pull_request_reviews);
  const checks = body.required_status_checks === undefined || body.required_status_checks === null ? null : record(body.required_status_checks);
  const unrecognized: Record<string, unknown> = {};
  for (const key of Object.keys(body)) if (!TOP_LEVEL_KEYS.has(key)) unrecognized[key] = body[key];
  if (reviews) for (const key of Object.keys(reviews)) if (!REVIEW_KEYS.has(key)) unrecognized[`required_pull_request_reviews.${key}`] = reviews[key];
  if (checks) for (const key of Object.keys(checks)) if (!CHECK_KEYS.has(key)) unrecognized[`required_status_checks.${key}`] = checks[key];

  const count = reviews?.required_approving_review_count;
  if (reviews && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) throw new Error("protection_shape");
  return {
    present: true,
    pullRequestRequired: reviews !== null,
    requiredApprovals: reviews ? (count as number) : null,
    dismissStaleReviews: reviews ? bool(reviews.dismiss_stale_reviews) : null,
    requireCodeOwnerReviews: reviews ? bool(reviews.require_code_owner_reviews) : null,
    requireLastPushApproval: reviews ? bool(reviews.require_last_push_approval ?? false) : null,
    dismissalRestrictions: reviews ? actorList(reviews.dismissal_restrictions) : null,
    reviewBypass: reviews ? actorList(reviews.bypass_pull_request_allowances) : null,
    requiredChecks: checks ? requiredChecksOf(checks) : null,
    strict: checks ? bool(checks.strict) : null,
    restrictions: actorList(body.restrictions),
    enforceAdmins: enabled(body.enforce_admins),
    allowForcePushes: enabled(body.allow_force_pushes),
    allowDeletions: enabled(body.allow_deletions),
    requiredLinearHistory: enabled(body.required_linear_history),
    requiredConversationResolution: enabled(body.required_conversation_resolution),
    requiredSignatures: enabled(body.required_signatures),
    lockBranch: enabled(body.lock_branch),
    blockCreations: enabled(body.block_creations),
    allowForkSyncing: enabled(body.allow_fork_syncing),
    unrecognized,
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
export const qaReleaseCanonicalJson = (value: unknown): string => canonical(value);
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

/** Whether two classic protections are the same, field by field. */
export function qaReleaseClassicDifferences(expected: QaReleaseClassicProtection, actual: QaReleaseClassicProtection): string[] {
  const a = expected as Json;
  const b = actual as Json;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((key) => canonical(a[key]) !== canonical(b[key]))
    .map((key) => `classic.${key}`);
}

/**
 * What differs between two records of the same branch, by field; empty when
 * they are the same protection. Ruleset ids are compared too: a ruleset
 * deleted and recreated with the same rules is a change somebody made.
 */
export function qaReleaseProtectionDifferences(expected: QaReleaseBranchProtection, actual: QaReleaseBranchProtection): string[] {
  const differences: string[] = [];
  if (expected.branch !== actual.branch) differences.push("branch");
  differences.push(...qaReleaseClassicDifferences(expected.classic, actual.classic));
  if (canonical(expected.rules) !== canonical(actual.rules)) differences.push("rules");
  return differences;
}

/**
 * develop's protection as the policy records it (section 8 item 10, read on
 * 2026-10-03; the settings the policy text does not name, and the App each
 * required check comes from, read on 2026-10-07): PR required with zero
 * approvals, three required checks from GitHub Actions, not strict, admins
 * not enforced, no ruleset.
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
    dismissalRestrictions: null,
    reviewBypass: null,
    requiredChecks: [
      { context: "Admin Console E2E (PostgreSQL)", appId: 15368 },
      { context: "Build and test the Rust workspace", appId: 15368 },
      { context: "Security, unit, build, and Chromium smoke tests", appId: 15368 },
    ],
    strict: false,
    restrictions: null,
    enforceAdmins: false,
    allowForcePushes: false,
    allowDeletions: false,
    requiredLinearHistory: false,
    requiredConversationResolution: false,
    requiredSignatures: false,
    lockBranch: false,
    blockCreations: false,
    allowForkSyncing: false,
    unrecognized: {},
  }) as QaReleaseClassicProtection,
  rules: [],
}) as QaReleaseBranchProtection;

/**
 * The `PUT /repos/{o}/{r}/branches/{b}/protection` body that gives a test
 * branch exactly the classic protection recorded for a real one (section 8
 * item 10: the test branch copies the real branch's protection). Null when
 * the real branch has none, so the test branch gets none either.
 *
 * A protection this body cannot express -- push restrictions, review bypass
 * or dismissal lists, required signatures (a separate endpoint), or any
 * setting this module does not know -- is refused rather than copied in part:
 * an observation on a partial copy is an observation of something else. The
 * harness also reads the copy back and compares it (qaReleaseClassicDifferences).
 */
export function qaReleaseClassicProtectionBody(classic: QaReleaseClassicProtection): Record<string, unknown> | null {
  if (!classic.present) return null;
  if (
    classic.restrictions !== null ||
    classic.reviewBypass !== null ||
    classic.dismissalRestrictions !== null ||
    classic.requiredSignatures ||
    Object.keys(classic.unrecognized).length > 0
  ) {
    throw new Error("protection_not_copyable");
  }
  return {
    required_status_checks:
      classic.requiredChecks === null
        ? null
        : {
            strict: classic.strict === true,
            // -1 is GitHub's "any App", which it reads back as null.
            checks: classic.requiredChecks.map((check) => ({ context: check.context, app_id: check.appId ?? -1 })),
          },
    enforce_admins: classic.enforceAdmins,
    required_pull_request_reviews: classic.pullRequestRequired
      ? {
          dismiss_stale_reviews: classic.dismissStaleReviews === true,
          require_code_owner_reviews: classic.requireCodeOwnerReviews === true,
          required_approving_review_count: classic.requiredApprovals ?? 0,
          require_last_push_approval: classic.requireLastPushApproval === true,
        }
      : null,
    restrictions: null,
    allow_force_pushes: classic.allowForcePushes,
    allow_deletions: classic.allowDeletions,
    required_linear_history: classic.requiredLinearHistory,
    required_conversation_resolution: classic.requiredConversationResolution,
    lock_branch: classic.lockBranch,
    block_creations: classic.blockCreations,
    allow_fork_syncing: classic.allowForkSyncing,
  };
}
