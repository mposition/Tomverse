import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_DEVELOP_PROTECTION_RECORDED,
  qaReleaseClassicProtection,
  qaReleaseProtectionDifferences,
  qaReleaseRulesetRules,
} from "../lib/qaReleaseBranchProtectionCore.ts";

// develop's classic protection in GitHub's own shape, as read on 2026-10-07.
const DEVELOP_RAW = {
  required_status_checks: {
    strict: false,
    contexts: ["Security, unit, build, and Chromium smoke tests", "Admin Console E2E (PostgreSQL)", "Build and test the Rust workspace"],
    checks: [
      { context: "Security, unit, build, and Chromium smoke tests", app_id: 15368 },
      { context: "Admin Console E2E (PostgreSQL)", app_id: 15368 },
      { context: "Build and test the Rust workspace", app_id: 15368 },
    ],
  },
  required_pull_request_reviews: {
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
  enforce_admins: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_linear_history: { enabled: false },
};

const snapshot = (classicRaw, rulesRaw = []) => ({
  branch: "develop",
  classic: qaReleaseClassicProtection(classicRaw),
  rules: qaReleaseRulesetRules(rulesRaw),
});

test("develop as GitHub answers it is the protection the policy records", () => {
  assert.deepEqual(qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot(DEVELOP_RAW)), []);
});

test("any change to a recorded setting or an added ruleset is a named difference", () => {
  const approvals = structuredClone(DEVELOP_RAW);
  approvals.required_pull_request_reviews.required_approving_review_count = 1;
  assert.deepEqual(qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot(approvals)), ["classic.requiredApprovals"]);

  const strict = structuredClone(DEVELOP_RAW);
  strict.required_status_checks.strict = true;
  strict.required_status_checks.checks.pop();
  assert.deepEqual(qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot(strict)), [
    "classic.requiredChecks",
    "classic.strict",
  ]);

  const ruled = snapshot(DEVELOP_RAW, [{ type: "pull_request", ruleset_id: 7, parameters: { required_approving_review_count: 0 } }]);
  assert.deepEqual(qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, ruled), ["rules"]);

  assert.deepEqual(qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot(null)).length > 0, true);
});

test("rules are compared in a stable order, keys and all", () => {
  const one = qaReleaseRulesetRules([
    { type: "update", ruleset_id: 2, parameters: { b: 1, a: 2 } },
    { type: "creation", ruleset_id: 2 },
  ]);
  const two = qaReleaseRulesetRules([
    { type: "creation", ruleset_id: 2 },
    { type: "update", ruleset_id: 2, parameters: { a: 2, b: 1 } },
  ]);
  const base = { branch: "main", classic: { present: false } };
  assert.deepEqual(qaReleaseProtectionDifferences({ ...base, rules: one }, { ...base, rules: two }), []);
  // The same rules under a recreated ruleset are a change.
  const recreated = qaReleaseRulesetRules([
    { type: "creation", ruleset_id: 9 },
    { type: "update", ruleset_id: 9, parameters: { a: 2, b: 1 } },
  ]);
  assert.deepEqual(qaReleaseProtectionDifferences({ ...base, rules: one }, { ...base, rules: recreated }), ["rules"]);
});

test("an answer of the wrong shape is an error, not a guess", () => {
  assert.throws(() => qaReleaseClassicProtection({ required_pull_request_reviews: { required_approving_review_count: "0" } }), /protection_shape/);
  assert.throws(() => qaReleaseClassicProtection([]), /protection_shape/);
  assert.throws(() => qaReleaseRulesetRules({}), /protection_shape/);
  assert.throws(() => qaReleaseRulesetRules([{ type: "update" }]), /protection_shape/);
  assert.deepEqual(qaReleaseClassicProtection(null), { present: false });
});

test("a test branch gets the recorded classic protection back in GitHub's PUT shape", async () => {
  const { qaReleaseClassicProtectionBody } = await import("../lib/qaReleaseBranchProtectionCore.ts");
  const body = qaReleaseClassicProtectionBody(qaReleaseClassicProtection(DEVELOP_RAW));
  assert.deepEqual(body, {
    required_status_checks: {
      strict: false,
      contexts: ["Admin Console E2E (PostgreSQL)", "Build and test the Rust workspace", "Security, unit, build, and Chromium smoke tests"],
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: false,
  });
  // Read back, the copy is the same protection.
  const roundTrip = {
    ...body,
    required_status_checks: { ...body.required_status_checks, checks: body.required_status_checks.contexts.map((context) => ({ context })) },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_linear_history: { enabled: false },
  };
  assert.deepEqual(qaReleaseClassicProtection(roundTrip), qaReleaseClassicProtection(DEVELOP_RAW));
  assert.equal(qaReleaseClassicProtectionBody({ present: false }), null);
});
