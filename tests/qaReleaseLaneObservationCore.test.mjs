import assert from "node:assert/strict";
import test from "node:test";

import { QA_RELEASE_DEVELOP_PROTECTION_RECORDED } from "../lib/qaReleaseBranchProtectionCore.ts";
import {
  QA_RELEASE_OBSERVATIONS,
  judgeQaReleaseObservations,
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

test("the reviewed pull request must be refused by a rule, not by classic protection", () => {
  const classic = asExpected().map((r) =>
    r.id === "app_merge_reviewed_main" ? { ...r, status: 405, message: "Required status check \"x\" is expected." } : r,
  );
  assert.equal(judgeQaReleaseObservations(classic).passed, false);
});

const record = (overrides = {}) => ({
  recordVersion: 1,
  observedAt: "2026-10-08T00:00:00.000Z",
  repository: "mposition/Tomverse",
  observationAppId: 1,
  bypassAppIds: [15368, 29110],
  protection: { develop: QA_RELEASE_DEVELOP_PROTECTION_RECORDED, main: { branch: "main", classic: { present: false }, rules: [] } },
  results: asExpected(),
  verdict: judgeQaReleaseObservations(asExpected()),
  automationUpdatesObserved: "not_observed",
  ...overrides,
});
const now = (overrides = {}) => ({
  develop: QA_RELEASE_DEVELOP_PROTECTION_RECORDED,
  main: { branch: "main", classic: { present: false }, rules: [] },
  bypassAppIds: [29110, 15368],
  ...overrides,
});

test("a record licenses the real rulesets only while it passed, names the same bypass list, and the protection is unchanged", () => {
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now()), { holds: true, reasons: [] });
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now({ bypassAppIds: [15368] })).reasons, ["bypass_list_differs"]);
  const changedMain = { branch: "main", classic: { present: false }, rules: [{ type: "update", rulesetId: 3, parameters: null }] };
  assert.deepEqual(qaReleaseRecordStillHolds(record(), now({ main: changedMain })).reasons, ["main.rules"]);
  const failed = record({ results: asExpected().slice(2) });
  assert.deepEqual(qaReleaseRecordStillHolds(failed, now()).reasons, ["observations_not_passed"]);
});
