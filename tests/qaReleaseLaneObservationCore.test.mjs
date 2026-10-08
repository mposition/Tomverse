import assert from "node:assert/strict";
import test from "node:test";

import { QA_RELEASE_DEVELOP_PROTECTION_RECORDED } from "../lib/qaReleaseBranchProtectionCore.ts";
import {
  QA_RELEASE_OBSERVATIONS,
  judgeQaReleaseObservations,
  qaReleaseAutomationMissing,
  qaReleaseAutomationUpdates,
  qaReleaseRecordStillHolds,
} from "../lib/qaReleaseLaneObservationCore.ts";

const RULE = "Repository rule violations found\n\nCannot update this protected ref.";
const asExpected = () =>
  QA_RELEASE_OBSERVATIONS.map((spec) =>
    spec.expect === "succeeded" ? { id: spec.id, status: 200, message: null } : { id: spec.id, status: 422, message: RULE },
  );

test("the eight observations of items 7 and 9, in the order that keeps refusals before the changes", () => {
  assert.deepEqual(
    QA_RELEASE_OBSERVATIONS.map((spec) => [spec.id, spec.actor, spec.expect]),
    [
      ["app_merge_unreviewed_main", "app", "refused"],
      ["app_merge_reviewed_main", "app", "refused"],
      ["app_push_main", "app", "refused"],
      ["app_merge_other_base", "app", "refused"],
      ["operator_merge_main", "operator", "succeeded"],
      ["app_push_green_develop", "app", "refused"],
      ["app_merge_develop", "app", "succeeded"],
      ["operator_push_develop", "operator", "succeeded"],
    ],
  );
});

test("all as expected passes; any one different, missing, duplicated or unanswered fails", () => {
  assert.equal(judgeQaReleaseObservations(asExpected()).passed, true);

  const mergedReviewed = asExpected().map((r) => (r.id === "app_merge_reviewed_main" ? { ...r, status: 200, message: null } : r));
  assert.equal(judgeQaReleaseObservations(mergedReviewed).passed, false);

  const operatorRefused = asExpected().map((r) => (r.id === "operator_merge_main" ? { ...r, status: 405, message: RULE } : r));
  const verdict = judgeQaReleaseObservations(operatorRefused);
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.verdicts.find((v) => v.id === "operator_merge_main"), {
    id: "operator_merge_main",
    expect: "succeeded",
    observed: "refused",
    ok: false,
    namesRule: true,
  });

  assert.equal(judgeQaReleaseObservations(asExpected().slice(1)).passed, false);
  assert.equal(judgeQaReleaseObservations([...asExpected(), asExpected()[0]]).passed, false);
  const serverError = asExpected().map((r) => (r.id === "app_push_main" ? { ...r, status: 502 } : r));
  assert.equal(judgeQaReleaseObservations(serverError).passed, false);
  const noAnswer = asExpected().map((r) => (r.id === "app_merge_develop" ? { ...r, status: null } : r));
  assert.equal(judgeQaReleaseObservations(noAnswer).passed, false);
});

test("a merge refused for conflicts is unknown, whatever was expected", () => {
  const CONFLICT = "Pull Request has merge conflicts";
  for (const id of ["app_merge_unreviewed_main", "app_merge_reviewed_main", "app_merge_other_base", "operator_merge_main"]) {
    // A message naming a rule as well still does not count.
    const conflicted = asExpected().map((r) => (r.id === id ? { ...r, status: 405, message: `${CONFLICT}. ${RULE}` } : r));
    const verdict = judgeQaReleaseObservations(conflicted);
    assert.equal(verdict.passed, false, id);
    assert.equal(verdict.verdicts.find((v) => v.id === id).observed, "unknown", id);
  }
});

test("the reviewed pull request must be refused by a rule, not by classic protection", () => {
  const classic = asExpected().map((r) =>
    r.id === "app_merge_reviewed_main" ? { ...r, status: 405, message: "Required status check \"x\" is expected." } : r,
  );
  assert.equal(judgeQaReleaseObservations(classic).passed, false);
});

const SINCE = "2026-10-08T00:00:00.000Z";
const ACTIVITY = [
  { ref: "refs/heads/dependabot/npm_and_yarn/next-16.3.9", timestamp: "2026-10-08T01:00:00Z", activity_type: "branch_creation", actor: { login: "dependabot[bot]" } },
  { ref: "refs/heads/visual-baseline/2026-10-08", timestamp: "2026-10-08T02:00:00Z", activity_type: "push", actor: { login: "github-actions[bot]" } },
];

const record = (overrides = {}) => ({
  recordVersion: 2,
  observedAt: "2026-10-08T03:00:00.000Z",
  repository: "mposition/Tomverse",
  observationAppId: 1,
  bypassAppIds: [29110],
  protection: { develop: QA_RELEASE_DEVELOP_PROTECTION_RECORDED, main: { branch: "main", classic: { present: false }, rules: [] } },
  results: asExpected(),
  verdict: judgeQaReleaseObservations(asExpected()),
  automation: { since: SINCE, updates: qaReleaseAutomationUpdates(ACTIVITY, [29110], SINCE), missingAppIds: [] },
  ...overrides,
});

test("an update by each bypass App on its own branch since the test ruleset went on, and nothing else, counts", () => {
  const updates = qaReleaseAutomationUpdates(ACTIVITY, [29110], SINCE);
  assert.deepEqual(updates.map((u) => u.appId), [29110]);
  assert.deepEqual(qaReleaseAutomationMissing(updates, [29110]), []);
  // GitHub Actions is not a candidate (refused as a bypass actor here), so its
  // pushes never count, even when it is named.
  assert.deepEqual(qaReleaseAutomationUpdates(ACTIVITY, [15368], SINCE), []);
  assert.deepEqual(qaReleaseAutomationMissing([], [15368]), [15368]);

  const noise = [
    // before the ruleset went on
    { ...ACTIVITY[0], timestamp: "2026-10-07T23:59:59Z" },
    // the right bot on another App's branch
    { ...ACTIVITY[1], ref: "refs/heads/dependabot/x" },
    // a person on an automation branch
    { ...ACTIVITY[0], actor: { login: "mposition" } },
    // not an update
    { ...ACTIVITY[1], activity_type: "branch_deletion" },
    // malformed
    null,
    { ref: 1 },
  ];
  assert.deepEqual(qaReleaseAutomationUpdates(noise, [29110], SINCE), []);
  assert.deepEqual(qaReleaseAutomationMissing([], [29110]), [29110]);
  // An App not on the bypass list contributes nothing.
  assert.deepEqual(qaReleaseAutomationUpdates(ACTIVITY, [29110], SINCE).map((u) => u.appId), [29110]);
});
const now = (overrides = {}) => ({
  develop: QA_RELEASE_DEVELOP_PROTECTION_RECORDED,
  main: { branch: "main", classic: { present: false }, rules: [] },
  bypassAppIds: [29110],
  ...overrides,
});

test("a record licenses the real rulesets only while it passed, names the same bypass list, and the protection is unchanged", () => {
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now()), { holds: true, reasons: [] });
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now({ bypassAppIds: [] })).reasons, ["bypass_list_differs"]);
  const changedMain = { branch: "main", classic: { present: false }, rules: [{ type: "update", rulesetId: 3, parameters: null }] };
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now({ main: changedMain })).reasons, ["main.rules"]);
  const failed = record({ results: asExpected().slice(2) });
  assert.deepEqual(qaReleaseRecordStillHolds(failed, now()).reasons, ["observations_not_passed"]);
  // Item 7: no automation evidence, no real rulesets.
  const unobserved = record({ automation: { since: SINCE, updates: [], missingAppIds: [29110] } });
  assert.deepEqual(qaReleaseRecordStillHolds(unobserved, now()).reasons, ["automation_not_observed"]);
  assert.deepEqual(qaReleaseRecordStillHolds(record({ recordVersion: 1 }), now()).reasons, ["record_version"]);
});
