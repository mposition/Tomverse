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



test("every step that can update a branch is caught, however the push is written", async () => {
  const { qaReleaseStepMayUpdateBranch } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  for (const run of [
    'git push origin "$b"',
    'GIT_TERMINAL_PROMPT=0 git push origin "$b"',
    "command git push origin b",
    "/usr/bin/git push origin b",
    'bash -c "git push origin b"',
    "if git push origin develop; then echo ok; fi",
    "git -c http.extraheader=x push origin b",
    "gh pr merge 12 --merge",
    "gh api -X PATCH repos/o/r/git/refs/heads/b -f sha=x",
  ]) {
    assert.equal(qaReleaseStepMayUpdateBranch({ run }), true, run);
  }
  assert.equal(qaReleaseStepMayUpdateBranch({ uses: "ad-m/github-push-action@v1" }), true);
  assert.equal(qaReleaseStepMayUpdateBranch({ uses: "peter-evans/create-pull-request@v7" }), true);
  for (const run of ["# git push is never the signal", 'docker push "ghcr.io/x"', "bad.push(x)", "npm run check:push-scope", "npm test"]) {
    assert.equal(qaReleaseStepMayUpdateBranch({ run }), false, run);
  }
});

test("a branch-updating step passes only as the exact step a person reviewed", async () => {
  const { qaReleaseWorkflowTokenPushers, qaReleasePushStepDigest } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  const PAT = "${{ secrets.GH_AUTOMATION_PAT }}";
  const workflow = {
    env: { A: "1" },
    jobs: {
      push: {
        env: { GH_TOKEN: PAT },
        steps: [{ uses: "actions/checkout@v6", with: { token: PAT } }, { name: "Push", run: 'git push origin "$b"' }],
      },
    },
  };
  const path = ".github/workflows/x.yml";
  const sha256 = qaReleasePushStepDigest(workflow, "push", 1);
  const reviewed = [{ path, job: "push", step: 1, sha256 }];
  assert.deepEqual(qaReleaseWorkflowTokenPushers([{ path, workflow }], reviewed), []);
  // Not reviewed at all: listed with its digest, for the reviewer.
  assert.deepEqual(qaReleaseWorkflowTokenPushers([{ path, workflow }], []), [`${path}#push/1 ${sha256}`]);

  // Any change to what decides the credential is a new digest, so it is listed again.
  const changes = [
    (w) => (w.jobs.push.steps[1].run += "\n# a comment"),
    (w) => (w.jobs.push.env.GH_TOKEN = "${{ github.token }}"),
    (w) => (w.env.B = "2"),
    (w) => (w.jobs.push.steps[0].with["persist-credentials"] = false),
    (w) => (w.jobs.push.steps[0].if = "${{ false }}"),
    (w) => (w.jobs.push.if = "${{ github.event_name == 'push' }}"),
    (w) => (w.jobs.push.steps[1].env = { GH_TOKEN: "${{ github.token }}" }),
  ];
  for (const change of changes) {
    const changed = structuredClone(workflow);
    change(changed);
    assert.equal(qaReleaseWorkflowTokenPushers([{ path, workflow: changed }], reviewed).length, 1, String(change));
  }
  // Another path, job or step index with the same digest does not count.
  assert.equal(qaReleaseWorkflowTokenPushers([{ path: ".github/workflows/y.yml", workflow }], reviewed).length, 1);
  assert.deepEqual(qaReleaseWorkflowTokenPushers([{ path, workflow: null }], reviewed), [`${path}#unreadable`]);
});

test("the reviewed list names exact steps with full digests and a reason", async () => {
  const { QA_RELEASE_REVIEWED_PUSH_STEPS } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  assert.ok(QA_RELEASE_REVIEWED_PUSH_STEPS.length > 0);
  for (const entry of QA_RELEASE_REVIEWED_PUSH_STEPS) {
    assert.match(entry.path, /^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(entry.step) && entry.step >= 0);
    assert.ok(entry.why.length > 10);
  }
});
