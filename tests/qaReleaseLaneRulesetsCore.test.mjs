import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_BYPASS_CANDIDATES,
  QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID,
  QA_RELEASE_TEST_RULESET_NAMES,
  qaReleaseAutomationRefs,
  qaReleaseLaneRulesets,
} from "../lib/qaReleaseLaneRulesetsCore.ts";

test("only a bypassed App's own branches are added, and the test names are exact", () => {
  assert.deepEqual(qaReleaseAutomationRefs([29110]), ["refs/heads/dependabot/**"]);
  assert.deepEqual(qaReleaseAutomationRefs([]), []);
  assert.deepEqual(qaReleaseAutomationRefs([123]), []);
  assert.deepEqual(QA_RELEASE_TEST_RULESET_NAMES, [
    "qa-release-lane: no updates outside develop (test)",
    "qa-release-lane: develop through pull requests (test)",
  ]);
});

const LANE_APP = 900001;
const CANDIDATES = QA_RELEASE_BYPASS_CANDIDATES.map((candidate) => candidate.appId);

test("the real rulesets: every branch but develop refuses updates and creations; develop takes pull requests only", () => {
  const { update, develop } = qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: CANDIDATES, laneAppId: LANE_APP });
  assert.deepEqual(update.conditions.ref_name, { include: ["~ALL"], exclude: ["refs/heads/develop"] });
  assert.deepEqual(update.rules.map((rule) => rule.type), ["creation", "update"]);
  assert.deepEqual(update.rules[1].parameters, { update_allows_fetch_and_merge: false });
  assert.deepEqual(update.bypass_actors, [
    { actor_id: QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" },
    { actor_id: 29110, actor_type: "Integration", bypass_mode: "always" },
  ]);

  assert.deepEqual(develop.conditions.ref_name, { include: ["refs/heads/develop"], exclude: [] });
  assert.equal(develop.rules.length, 1);
  assert.equal(develop.rules[0].type, "pull_request");
  assert.equal(develop.rules[0].parameters.required_approving_review_count, 0);
  // Item 9: only the admin role bypasses develop's rule -- no app, not even automation.
  assert.deepEqual(develop.bypass_actors, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]);
});

test("the lane's own App can never be on a bypass list", () => {
  assert.throws(() => qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: [15368, LANE_APP], laneAppId: LANE_APP }), /lane_app_in_bypass/);
  assert.throws(() => qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: [0], laneAppId: LANE_APP }), /bypass_app_id_invalid/);
  assert.throws(() => qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: [], laneAppId: 0 }), /lane_app_id_invalid/);
});

test("the test rulesets are the real ones pointed at the test branches only", () => {
  const scope = { kind: "test", updateBranches: ["qa-lane-test/main-mirror", "qa-lane-test/other-base"], developBranch: "qa-lane-test/develop-mirror" };
  const testSet = qaReleaseLaneRulesets({ scope, bypassAppIds: CANDIDATES, laneAppId: LANE_APP });
  const realSet = qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: CANDIDATES, laneAppId: LANE_APP });
  assert.deepEqual(testSet.update.conditions.ref_name, {
    // The bypass automation branches are covered too, so their updates can be observed.
    include: ["refs/heads/dependabot/**", "refs/heads/qa-lane-test/main-mirror", "refs/heads/qa-lane-test/other-base"],
    exclude: [],
  });
  assert.deepEqual(testSet.develop.conditions.ref_name, { include: ["refs/heads/qa-lane-test/develop-mirror"], exclude: [] });
  // Everything but the branch condition and the name is identical.
  for (const key of ["update", "develop"]) {
    assert.deepEqual(testSet[key].rules, realSet[key].rules);
    assert.deepEqual(testSet[key].bypass_actors, realSet[key].bypass_actors);
    assert.equal(testSet[key].name, `${realSet[key].name} (test)`);
  }
  // A test scope can never reach a real branch.
  for (const bad of [
    { ...scope, updateBranches: ["main"] },
    { ...scope, developBranch: "develop" },
    { ...scope, updateBranches: ["qa-lane-test/x", "qa-lane-test/x"] },
    { ...scope, updateBranches: [] , developBranch: "qa-lane-test/develop-mirror" },
  ]) {
    assert.throws(() => qaReleaseLaneRulesets({ scope: bad, bypassAppIds: [], laneAppId: LANE_APP }), /test_branches_invalid/);
  }
});

// What GitHub stored for the test rulesets on 2026-10-08, read back verbatim.
const STORED_UPDATE_RULES = [{ type: "creation" }, { type: "update" }];
const STORED_PULL_REQUEST_RULES = [
  {
    type: "pull_request",
    parameters: {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_extra_approval_for_unattributed_changes: true,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: false,
      required_reviewers: [],
    },
  },
];

test("what is sent compares equal to what GitHub stores, and GitHub's extra-approval default is overridden", async () => {
  const { qaReleaseComparableRules } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  const { qaReleaseCanonicalJson } = await import("../lib/qaReleaseBranchProtectionCore.ts");
  const { update, develop } = qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: [29110], laneAppId: LANE_APP });
  const same = (a, b) => qaReleaseCanonicalJson(qaReleaseComparableRules(a)) === qaReleaseCanonicalJson(qaReleaseComparableRules(b));

  // The update rule's false parameter is omitted by GitHub.
  assert.equal(same(update.rules, STORED_UPDATE_RULES), true);
  assert.equal(same(update.rules, [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: true } }]), false);

  // Every pull request parameter GitHub stores is named, so its default
  // (an extra approval for unattributed changes) cannot slip in.
  assert.deepEqual(Object.keys(develop.rules[0].parameters).sort(), Object.keys(STORED_PULL_REQUEST_RULES[0].parameters).sort());
  assert.equal(develop.rules[0].parameters.require_extra_approval_for_unattributed_changes, false);
  assert.equal(same(develop.rules, STORED_PULL_REQUEST_RULES), false);
  const storedAsSent = structuredClone(STORED_PULL_REQUEST_RULES);
  storedAsSent[0].parameters.require_extra_approval_for_unattributed_changes = false;
  assert.equal(same(develop.rules, storedAsSent), true);
});

test("a workflow that runs git push without the admin PAT is named, so the real rulesets wait for it", async () => {
  const { qaReleaseWorkflowTokenPushers } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  const files = [
    { path: ".github/workflows/token-push.yml", text: "steps:\n  - run: |\n      git push origin \"$branch\"\n" },
    { path: ".github/workflows/pat-push.yml", text: "env:\n  GH_TOKEN: ${{ secrets.GH_AUTOMATION_PAT }}\nsteps:\n  - run: git push \"https://x-access-token:${GH_TOKEN}@github.com/x.git\" b\n" },
    { path: ".github/workflows/comment-only.yml", text: "      # `git push` is never the signal\n" },
    { path: ".github/workflows/none.yml", text: "steps:\n  - run: npm test\n" },
  ];
  assert.deepEqual(qaReleaseWorkflowTokenPushers(files), [".github/workflows/token-push.yml"]);
});
