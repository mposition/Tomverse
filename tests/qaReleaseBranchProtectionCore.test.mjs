import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_DEVELOP_PROTECTION_RECORDED,
  qaReleaseClassicDifferences,
  qaReleaseClassicProtection,
  qaReleaseClassicProtectionBody,
  qaReleaseProtectionDifferences,
  qaReleaseRulesetRules,
} from "../lib/qaReleaseBranchProtectionCore.ts";

// develop's classic protection in GitHub's own shape, every key it returned on 2026-10-07.
const DEVELOP_RAW = {
  url: "https://api.github.com/repos/mposition/Tomverse/branches/develop/protection",
  required_status_checks: {
    url: "x",
    strict: false,
    contexts: ["Security, unit, build, and Chromium smoke tests", "Admin Console E2E (PostgreSQL)", "Build and test the Rust workspace"],
    contexts_url: "x",
    checks: [
      { context: "Security, unit, build, and Chromium smoke tests", app_id: 15368 },
      { context: "Admin Console E2E (PostgreSQL)", app_id: 15368 },
      { context: "Build and test the Rust workspace", app_id: 15368 },
    ],
  },
  required_pull_request_reviews: {
    url: "x",
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    required_approving_review_count: 0,
  },
  required_signatures: { url: "x", enabled: false },
  enforce_admins: { url: "x", enabled: false },
  required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: false },
  required_conversation_resolution: { enabled: false },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
};

const snapshot = (classicRaw, rulesRaw = []) => ({
  branch: "develop",
  classic: qaReleaseClassicProtection(classicRaw),
  rules: qaReleaseRulesetRules(rulesRaw),
});
const differences = (raw, rules) => qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot(raw, rules));

test("develop as GitHub answers it is the protection the policy records", () => {
  assert.deepEqual(differences(DEVELOP_RAW), []);
});

test("any change to a recorded setting or an added ruleset is a named difference", () => {
  const approvals = structuredClone(DEVELOP_RAW);
  approvals.required_pull_request_reviews.required_approving_review_count = 1;
  assert.deepEqual(differences(approvals), ["classic.requiredApprovals"]);

  const strict = structuredClone(DEVELOP_RAW);
  strict.required_status_checks.strict = true;
  strict.required_status_checks.checks.pop();
  assert.deepEqual(differences(strict), ["classic.requiredChecks", "classic.strict"]);

  assert.deepEqual(differences(DEVELOP_RAW, [{ type: "pull_request", ruleset_id: 7, parameters: {} }]), ["rules"]);
  assert.ok(differences(null).length > 0);
});

test("settings the first version dropped are compared too", () => {
  // The App a required check must come from: "any App" is a weaker gate.
  const anyApp = structuredClone(DEVELOP_RAW);
  for (const check of anyApp.required_status_checks.checks) check.app_id = null;
  assert.deepEqual(differences(anyApp), ["classic.requiredChecks"]);

  const restricted = { ...structuredClone(DEVELOP_RAW), restrictions: { users: [{ login: "someone" }], teams: [], apps: [] } };
  assert.deepEqual(differences(restricted), ["classic.restrictions"]);
  // Push restrictions that allow nobody are still a restriction, not its absence.
  const nobody = { ...structuredClone(DEVELOP_RAW), restrictions: { users: [], teams: [], apps: [] } };
  assert.deepEqual(differences(nobody), ["classic.restrictions"]);
  assert.throws(() => qaReleaseClassicProtectionBody(qaReleaseClassicProtection(nobody)), /protection_not_copyable/);

  const bypass = structuredClone(DEVELOP_RAW);
  bypass.required_pull_request_reviews.bypass_pull_request_allowances = { users: [], teams: [], apps: [{ slug: "some-app" }] };
  assert.deepEqual(differences(bypass), ["classic.reviewBypass"]);

  for (const key of ["required_conversation_resolution", "required_signatures", "lock_branch", "block_creations", "allow_fork_syncing"]) {
    const changed = structuredClone(DEVELOP_RAW);
    changed[key] = { enabled: true };
    assert.equal(differences(changed).length, 1, key);
  }

  // A setting GitHub adds later is a difference, not invisible.
  const unknown = { ...structuredClone(DEVELOP_RAW), merge_queue: { enabled: true } };
  assert.deepEqual(differences(unknown), ["classic.unrecognized"]);
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

test("a test branch gets the recorded classic protection back, App ids and all", () => {
  const body = qaReleaseClassicProtectionBody(qaReleaseClassicProtection(DEVELOP_RAW));
  assert.deepEqual(body.required_status_checks, {
    strict: false,
    checks: [
      { context: "Admin Console E2E (PostgreSQL)", app_id: 15368 },
      { context: "Build and test the Rust workspace", app_id: 15368 },
      { context: "Security, unit, build, and Chromium smoke tests", app_id: 15368 },
    ],
  });
  // Read back in GitHub's shape, the copy is the same protection.
  const readBack = {
    ...structuredClone(DEVELOP_RAW),
    required_status_checks: { strict: false, checks: body.required_status_checks.checks.map((c) => ({ context: c.context, app_id: c.app_id })) },
  };
  assert.deepEqual(qaReleaseClassicDifferences(qaReleaseClassicProtection(DEVELOP_RAW), qaReleaseClassicProtection(readBack)), []);
  assert.equal(qaReleaseClassicProtectionBody({ present: false }), null);
});

test("a protection the body cannot express is refused rather than copied in part", () => {
  for (const raw of [
    { ...structuredClone(DEVELOP_RAW), restrictions: { users: [{ login: "someone" }], teams: [], apps: [] } },
    { ...structuredClone(DEVELOP_RAW), required_signatures: { enabled: true } },
    { ...structuredClone(DEVELOP_RAW), merge_queue: { enabled: true } },
  ]) {
    assert.throws(() => qaReleaseClassicProtectionBody(qaReleaseClassicProtection(raw)), /protection_not_copyable/);
  }
});
