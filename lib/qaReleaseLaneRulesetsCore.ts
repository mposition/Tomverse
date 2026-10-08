/**
 * The rulesets the merge lane needs before it may run (docs/policy/
 * qa-release-agent.md version 7, section 8 items 7 and 9), as the exact
 * request bodies of `POST /repos/{owner}/{repo}/rulesets`.
 *
 * - "update outside develop": every branch but develop refuses updates and
 *   creations from anyone not on the bypass list. The lane's App is never on
 *   it, so the App cannot touch main or move a pull request's base.
 * - "develop pull requests": develop takes changes only through a pull
 *   request (no approvals required), so the App cannot push to develop
 *   directly; only the repository admin role bypasses it.
 *
 * The same bodies, pointed at test branches instead, are what the S-M0 test
 * observations run against (item 10), so the observed protection and the
 * applied one cannot drift apart: one builder makes both.
 *
 * Pure. The bypass list beyond the admin role is the operator's decision
 * after the observations (item 7); these builders refuse a list that holds
 * the lane's own App.
 */

/** GitHub's built-in repository role ids for ruleset bypass: 5 is "admin". */
export const QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID = 5;

/**
 * Automation that updates branches and can bypass the update ruleset
 * (item 7). Ids read from `GET /apps/{slug}` on 2026-10-07.
 *
 * Workflows that push with GH_AUTOMATION_PAT act as the account, which the
 * admin role already covers. GitHub Actions (app 15368) is not a candidate:
 * on this personal-account repository GitHub refuses it as a bypass actor
 * ("must be part of the ruleset source or owner organization", seen
 * 2026-10-08), so visual-baseline-record pushes its review branch with the PAT
 * instead. Dependabot opens and updates its own branches and was accepted.
 */
export const QA_RELEASE_BYPASS_CANDIDATES = Object.freeze([
  Object.freeze({
    appId: 29110,
    slug: "dependabot",
    botLogin: "dependabot[bot]",
    branchPattern: "dependabot/**",
    reason: "Dependabot creates and updates its own branches",
  }),
]);

export const QA_RELEASE_UPDATE_RULESET_NAME = "qa-release-lane: no updates outside develop";
export const QA_RELEASE_DEVELOP_RULESET_NAME = "qa-release-lane: develop through pull requests";
/** The exact names the test rulesets carry; teardown removes these and nothing else. */
export const QA_RELEASE_TEST_RULESET_NAMES = Object.freeze([
  `${QA_RELEASE_UPDATE_RULESET_NAME} (test)`,
  `${QA_RELEASE_DEVELOP_RULESET_NAME} (test)`,
]);
export const QA_RELEASE_TEST_PREFIX = "qa-lane-test/";

/**
 * The branches of the bypass automation that the test update ruleset also
 * covers, so the observations see each listed App update a branch the
 * ruleset applies to (item 7: the automation's branch updates succeed). Only
 * a candidate's own branch pattern may be named, and only while its App is
 * on the bypass list.
 */
export function qaReleaseAutomationRefs(bypassAppIds: readonly number[]): string[] {
  return QA_RELEASE_BYPASS_CANDIDATES.filter((candidate) => bypassAppIds.includes(candidate.appId))
    .map((candidate) => `refs/heads/${candidate.branchPattern}`)
    .sort();
}

export type QaReleaseRulesetBody = {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors: Array<{ actor_id: number; actor_type: "RepositoryRole" | "Integration"; bypass_mode: "always" }>;
};

export type QaReleaseRulesetScope =
  | { kind: "real" }
  /** The test branches of the observations: their full names. */
  | { kind: "test"; updateBranches: string[]; developBranch: string };

const ref = (branch: string) => `refs/heads/${branch}`;
const TEST_BRANCH = /^qa-lane-test\/[a-z0-9][a-z0-9-]{0,48}$/;

const adminBypass = { actor_id: QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const };

/** Both ruleset bodies for one scope, with the operator's bypass apps. */
export function qaReleaseLaneRulesets(input: {
  scope: QaReleaseRulesetScope;
  bypassAppIds: readonly number[];
  laneAppId: number;
}): { update: QaReleaseRulesetBody; develop: QaReleaseRulesetBody } {
  const { scope, laneAppId } = input;
  if (!Number.isSafeInteger(laneAppId) || laneAppId <= 0) throw new Error("lane_app_id_invalid");
  const apps = [...new Set(input.bypassAppIds)].sort((a, b) => a - b);
  if (apps.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("bypass_app_id_invalid");
  // The point of the update ruleset is that this App is not exempt from it.
  if (apps.includes(laneAppId)) throw new Error("lane_app_in_bypass");

  let updateInclude: string[];
  let updateExclude: string[];
  let developInclude: string[];
  let suffix = "";
  if (scope.kind === "real") {
    updateInclude = ["~ALL"];
    updateExclude = [ref("develop")];
    developInclude = [ref("develop")];
  } else {
    const names = [...scope.updateBranches, scope.developBranch];
    if (names.length < 2 || !names.every((name) => TEST_BRANCH.test(name)) || new Set(names).size !== names.length) {
      throw new Error("test_branches_invalid");
    }
    // The bypass automation's own branches too, so its updates under the
    // ruleset can be observed (item 7).
    updateInclude = [...scope.updateBranches.map(ref), ...qaReleaseAutomationRefs(apps)].sort();
    updateExclude = [];
    developInclude = [ref(scope.developBranch)];
    suffix = " (test)";
  }

  return {
    update: {
      name: QA_RELEASE_UPDATE_RULESET_NAME + suffix,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: updateInclude, exclude: updateExclude } },
      // The App never creates a branch, so creation is restricted with updates.
      rules: [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }],
      bypass_actors: [adminBypass, ...apps.map((id) => ({ actor_id: id, actor_type: "Integration" as const, bypass_mode: "always" as const }))],
    },
    develop: {
      name: QA_RELEASE_DEVELOP_RULESET_NAME + suffix,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: developInclude, exclude: [] } },
      // Zero approvals (item 10, version 4): the rule exists to refuse a direct
      // push, not to require a review the lane cannot give. Every parameter
      // GitHub stores is named, because one left out is filled with GitHub's
      // default -- and that default for unattributed changes (read back on
      // 2026-10-08) is an extra approval, which zero approvals rules out.
      rules: [
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge", "squash", "rebase"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_extra_approval_for_unattributed_changes: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: false,
            required_reviewers: [],
          },
        },
      ],
      // Item 9: the admin role only.
      bypass_actors: [adminBypass],
    },
  };
}

/**
 * Rules in a form where what was sent and what GitHub stored compare equal
 * when they mean the same: sorted by type, and the update rule's one
 * parameter, which GitHub omits when it is false (read back on 2026-10-08),
 * treated as absent when false. Every other parameter is compared as given.
 */
export function qaReleaseComparableRules(rules: readonly { type: string; parameters?: unknown }[] | null | undefined) {
  return [...(rules ?? [])]
    .map((rule) => {
      const parameters = rule.parameters ?? null;
      if (rule.type === "update") {
        const fetchAndMerge = parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>).update_allows_fetch_and_merge : undefined;
        const others = parameters && typeof parameters === "object" ? Object.keys(parameters).filter((key) => key !== "update_allows_fetch_and_merge") : [];
        if ((fetchAndMerge === undefined || fetchAndMerge === false) && others.length === 0) return { type: "update", parameters: null };
      }
      return { type: rule.type, parameters };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
}
