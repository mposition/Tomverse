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




test("a workflow is listed when its token can write contents, or it holds another credential, unless that exact file was reviewed", async () => {
  const { qaReleaseReadWorkflow, qaReleaseWorkflowBranchWriters, qaReleaseWorkflowDigest } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  const file = (path, workflow, text = JSON.stringify(workflow)) => ({ path, text, workflow, yamlAliases: false });

  const readOnly = file("read.yml", { permissions: { contents: "read" }, jobs: { a: { steps: [{ run: "git push origin b" }] } } });
  const topWrite = file("top.yml", { permissions: { contents: "write" }, jobs: { a: { steps: [] } } });
  const jobWrite = file("job.yml", { permissions: { contents: "read" }, jobs: { a: { permissions: { contents: "write" }, steps: [] } } });
  const writeAll = file("all.yml", { permissions: "write-all", jobs: { a: { steps: [] } } });
  const jobOverridesTop = file("override.yml", { permissions: { contents: "write" }, jobs: { a: { permissions: { contents: "read" }, steps: [] } } });
  const noPermissions = file("none.yml", { jobs: { a: { steps: [] } } });
  const reusable = file("reusable.yml", { jobs: { a: { permissions: { contents: "write" }, uses: "./.github/workflows/other.yml" } } });
  const appToken = file("app.yml", { permissions: { contents: "read" }, jobs: { a: { steps: [{ uses: "actions/create-github-app-token@v2" }] } } }, "uses: actions/create-github-app-token@v2");
  const deployKey = file("key.yml", { permissions: {}, jobs: { a: { steps: [] } } }, "ssh-key: ${{ secrets.DEPLOY_KEY }}");
  const unreadable = qaReleaseReadWorkflow("bad.yml", "jobs: [");
  // A contents-read workflow that mints a write App token through another
  // action and its underscore inputs: caught by the secret it needs.
  const tibdex = file(
    "tibdex.yml",
    { permissions: { contents: "read" }, jobs: { a: { steps: [{ uses: "tibdex/github-app-token@v2" }] } } },
    "uses: tibdex/github-app-token@v2\nwith:\n  app_id: 1\n  private_key: ${{ secrets.APP_PRIVATE_KEY }}",
  );
  const otherKey = file("otherkey.yml", { permissions: { contents: "read" }, jobs: { a: { steps: [] } } }, "token: ${{ secrets.SECOND_PAT }}");
  const computed = file("computed.yml", { permissions: { contents: "read" }, jobs: { a: { steps: [] } } }, "token: ${{ secrets[format('{0}', 'X')] }}");
  // From real YAML, so quoting and flow style are the parser's, not a pattern's.
  const yamlFile = qaReleaseReadWorkflow;
  const inherit = yamlFile("inherit.yml", "permissions:\n  contents: read\njobs:\n  a:\n    uses: ./x.yml\n    secrets: inherit\n");
  const quotedInherit = yamlFile("quoted.yml", "permissions:\n  contents: read\njobs:\n  a:\n    uses: ./x.yml\n    \"secrets\": inherit\n");
  const flowInherit = yamlFile("flow.yml", "permissions: {contents: read}\njobs: {call: {uses: './x.yml', secrets: inherit}}\n");
  const mapped = yamlFile("mapped.yml", "permissions:\n  contents: read\njobs:\n  a:\n    uses: ./x.yml\n    secrets:\n      token: ${{ secrets.SLACK_WEBHOOK_URL }}\n");
  // The whole secrets object handed to a script.
  const wholeObject = yamlFile("tojson.yml", "permissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    env:\n      ALL: ${{ toJSON(secrets) }}\n    steps: []\n");
  // A multi-line if without braces, naming a secret outside the list.
  const multiLineIf = yamlFile("multiif.yml", "permissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - if: >-\n          github.event_name == 'push' &&\n          secrets.SECOND_PAT != ''\n        run: echo\n");
  // Secrets that are not GitHub credentials leave a read-only workflow unlisted.
  const harmless = yamlFile("harmless.yml", "permissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    env:\n      URL: ${{ secrets.SLACK_WEBHOOK_URL }}\n      PAT: ${{ secrets.GH_AUTOMATION_PAT }}\n    steps:\n      - if: secrets.SLACK_WEBHOOK_URL != ''\n        run: echo\n");
  // A secret reaching a job only through a merge key: the file is listed
  // whatever the expansion, and so is any other alias.
  const mergeKey = yamlFile("merge.yml", "permissions:\n  contents: read\nx-call: &call\n  uses: ./x.yml\n  secrets: inherit\njobs:\n  a:\n    <<: *call\n");
  const anchorOnly = yamlFile("anchor.yml", "permissions:\n  contents: read\nx-steps: &steps []\njobs:\n  a:\n    runs-on: x\n    steps: *steps\n");
  assert.equal(mergeKey.yamlAliases, true);
  assert.equal(harmless.yamlAliases, false);
  // A caller that did not say is not trusted.
  assert.equal(qaReleaseWorkflowBranchWriters([{ ...harmless, yamlAliases: undefined }], "read", []).length, 1);

  // The workflow token's permission decides, not what the script says:
  // a read-only token's git push cannot change a branch.
  const listed = qaReleaseWorkflowBranchWriters(
    [readOnly, topWrite, jobWrite, writeAll, jobOverridesTop, noPermissions, reusable, appToken, deployKey, unreadable, tibdex, otherKey, computed, inherit, quotedInherit, flowInherit, mapped, wholeObject, multiLineIf, harmless, mergeKey, anchorOnly],
    "read",
    [],
  );
  assert.deepEqual(
    listed.map((line) => line.split(" ")[0]),
    ["all.yml", "anchor.yml", "app.yml", "bad.yml", "computed.yml", "flow.yml", "inherit.yml", "job.yml", "key.yml", "mapped.yml", "merge.yml", "multiif.yml", "otherkey.yml", "quoted.yml", "reusable.yml", "tibdex.yml", "tojson.yml", "top.yml"],
  );
  // With the repository default at write, a workflow without permissions is listed too.
  assert.deepEqual(
    qaReleaseWorkflowBranchWriters([noPermissions], "write", []).map((line) => line.split(" ")[0]),
    ["none.yml"],
  );

  // Reviewed: the exact text passes; one changed byte is listed again, and so
  // is the same text under another path.
  const reviewed = [{ path: "top.yml", sha256: qaReleaseWorkflowDigest(topWrite.text) }];
  assert.deepEqual(qaReleaseWorkflowBranchWriters([topWrite], "read", reviewed), []);
  assert.equal(qaReleaseWorkflowBranchWriters([{ ...topWrite, text: `${topWrite.text} ` }], "read", reviewed).length, 1);
  assert.equal(qaReleaseWorkflowBranchWriters([{ ...topWrite, path: "other.yml" }], "read", reviewed).length, 1);
  // Line endings do not change the digest.
  assert.equal(qaReleaseWorkflowDigest("a\r\nb\n"), qaReleaseWorkflowDigest("a\nb\n"));
});

test("the reviewed workflows are named by path, full digest and a reason", async () => {
  const { QA_RELEASE_REVIEWED_WRITER_WORKFLOWS } = await import("../lib/qaReleaseLaneRulesetsCore.ts");
  assert.ok(QA_RELEASE_REVIEWED_WRITER_WORKFLOWS.length > 0);
  for (const entry of QA_RELEASE_REVIEWED_WRITER_WORKFLOWS) {
    assert.match(entry.path, /^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.why.length > 20);
  }
});
