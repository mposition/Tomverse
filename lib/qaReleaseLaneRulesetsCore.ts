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
 * Automation that updates branches today and therefore needs to bypass the
 * update ruleset (item 7). Ids read from `GET /apps/{slug}` on 2026-10-07.
 * Workflows that push with GH_AUTOMATION_PAT act as the account, which the
 * admin role already covers; visual-baseline-record pushes with the Actions
 * token, and Dependabot opens its own branches.
 */
export const QA_RELEASE_BYPASS_CANDIDATES = Object.freeze([
  Object.freeze({
    appId: 15368,
    slug: "github-actions",
    botLogin: "github-actions[bot]",
    branchPattern: "visual-baseline/**",
    reason: "visual-baseline-record pushes its branch with the workflow token",
  }),
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
      // push, not to require a review the lane cannot give.
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
      ],
      // Item 9: the admin role only.
      bypass_actors: [adminBypass],
    },
  };
}
