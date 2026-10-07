import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_BYPASS_CANDIDATES,
  QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID,
  qaReleaseLaneRulesets,
} from "../lib/qaReleaseLaneRulesetsCore.ts";

const LANE_APP = 900001;
const CANDIDATES = QA_RELEASE_BYPASS_CANDIDATES.map((candidate) => candidate.appId);

test("the real rulesets: every branch but develop refuses updates and creations; develop takes pull requests only", () => {
  const { update, develop } = qaReleaseLaneRulesets({ scope: { kind: "real" }, bypassAppIds: CANDIDATES, laneAppId: LANE_APP });
  assert.deepEqual(update.conditions.ref_name, { include: ["~ALL"], exclude: ["refs/heads/develop"] });
  assert.deepEqual(update.rules.map((rule) => rule.type), ["creation", "update"]);
  assert.deepEqual(update.rules[1].parameters, { update_allows_fetch_and_merge: false });
  assert.deepEqual(update.bypass_actors, [
    { actor_id: QA_RELEASE_REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" },
    { actor_id: 15368, actor_type: "Integration", bypass_mode: "always" },
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
    include: ["refs/heads/qa-lane-test/main-mirror", "refs/heads/qa-lane-test/other-base"],
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
