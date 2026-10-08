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


test("a push counts as the admin PAT's only when the PAT is wired to it", async () => {
  const { qaReleaseWorkflowTokenPushers } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  const { parse } = await import("yaml");
  const { readFileSync } = await import("node:fs");
  const PAT = "${{ secrets.GH_AUTOMATION_PAT }}";
  const wf = (path, workflow) => ({ path, workflow });

  // The four ways this repository wires it, each as its own workflow uses it.
  const safe = [
    wf("checkout-token", { jobs: { a: { steps: [{ uses: "actions/checkout@v6", with: { token: PAT } }, { run: 'git push origin "$b"' }] } } }),
    wf("setup-git", { jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: 'gh auth setup-git\ngit push origin "$b"' }] } } }),
    wf("remote-set-url", {
      // A backslash-continued command, as feedback-autofix writes it.
      jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: ["git remote set-url origin \\", '  "https://x-access-token:${GH_TOKEN}@github.com/x.git"', 'git push origin "$b"'].join("\n") }] } },
    }),
    wf("url", { jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: 'git push "https://x-access-token:${GH_TOKEN}@github.com/x.git" "$b"' }] } } }),
  ];
  assert.deepEqual(qaReleaseWorkflowTokenPushers(safe), []);

  // The ways it is not wired, all listed.
  const unsafe = [
    // the PAT named only in a comment
    wf("comment", { jobs: { a: { steps: [{ run: '# migrate to secrets.GH_AUTOMATION_PAT later\ngit push origin "$b"' }] } } }),
    // the PAT in another job
    wf("other-job", { jobs: { a: { env: { GH_TOKEN: PAT }, steps: [{ run: "echo" }] }, b: { steps: [{ run: 'git push origin "$b"' }] } } }),
    // a checkout token whose credential is not kept
    wf("not-persisted", { jobs: { a: { steps: [{ uses: "actions/checkout@v6", with: { token: PAT, "persist-credentials": false } }, { run: "git push origin x" }] } } }),
    // a URL whose variable is the workflow token
    wf("workflow-token-url", { jobs: { a: { steps: [{ env: { GH_TOKEN: "${{ github.token }}" }, run: 'git push "https://x-access-token:${GH_TOKEN}@github.com/x.git" b' }] } } }),
    // setup-git in an earlier step, not this one
    wf("setup-elsewhere", { jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: "gh auth setup-git" }, { run: "git push origin x" }] } } }),
    // unreadable
    wf("unreadable", null),
    // the PAT URL put on another remote, the push going to origin
    wf("other-remote", {
      jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: 'git remote set-url backup "https://x-access-token:${GH_TOKEN}@github.com/x.git"\ngit push origin b' }] } },
    }),
    // the PAT URL only in an inline comment of the push line
    wf("inline-comment", { jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: "git push origin b # https://x-access-token:${GH_TOKEN}@github.com/x.git" }] } } }),
    // the PAT URL in another command on the line
    wf("other-command", { jobs: { a: { steps: [{ env: { GH_TOKEN: PAT }, run: 'echo "https://x-access-token:${GH_TOKEN}@github.com/x.git"; git push origin b' }] } } }),
    // a PAT checkout that may not have run
    wf("conditional-checkout", {
      jobs: { a: { steps: [{ uses: "actions/checkout@v6" }, { if: "${{ false }}", uses: "actions/checkout@v6", with: { token: PAT } }, { run: "git push origin b" }] } },
    }),
    // a remote set in a step that may not have run
    wf("conditional-remote", {
      jobs: {
        a: {
          steps: [
            { if: "${{ false }}", env: { GH_TOKEN: PAT }, run: 'git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/x.git"' },
            { run: "git push origin b" },
          ],
        },
      },
    }),
  ];
  assert.deepEqual(qaReleaseWorkflowTokenPushers(unsafe), [
    "comment#a/0",
    "conditional-checkout#a/2",
    "conditional-remote#a/1",
    "inline-comment#a/0",
    "not-persisted#a/1",
    "other-command#a/0",
    "other-job#b/0",
    "other-remote#a/0",
    "setup-elsewhere#a/1",
    "unreadable#unreadable",
    "workflow-token-url#a/0",
  ]);

  // A remote given the PAT URL in an earlier, unconditional step stays authenticated.
  const carried = wf("carried-remote", {
    jobs: {
      a: {
        steps: [
          { env: { GH_TOKEN: PAT }, run: 'git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/x.git"' },
          { if: "${{ success() }}", run: 'if git push origin "$b"; then echo ok; fi' },
        ],
      },
    },
  });
  assert.deepEqual(qaReleaseWorkflowTokenPushers([carried]), []);

  // The repository's own PAT pushers read as safe, parsed from their files.
  const own = ["back-merge-main-to-develop", "cron-auto-fix", "feedback-autofix", "feedback-autofix-promotion-pr"].map((name) =>
    wf(name, parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"))),
  );
  assert.deepEqual(qaReleaseWorkflowTokenPushers(own), []);
});
