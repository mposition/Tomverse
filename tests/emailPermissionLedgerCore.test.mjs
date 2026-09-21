// The permission ledger's closed lists and its two derivations.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6,
// 7.6 and 7.8.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES,
  EMAIL_PERMISSION_DECISION_PHASES,
  EMAIL_PERMISSION_EVENT_CAPTURE_SOURCES,
  EMAIL_PERMISSION_EVENT_KINDS,
  EMAIL_SEND_APPROVAL_TYPES,
  approvalScopeRefusal,
  cohortRefusal,
  decisionAllowed,
} from "../lib/emailPermissionLedgerCore.ts";

const sealed = new Date("2026-09-16T00:00:00.000Z");

const riskAccepted = {
  approvalType: "risk_accepted",
  sealedAt: sealed,
  revoked: false,
  policyVersionId: "pv1",
  ruleKey: null,
  ruleVersion: null,
  country: null,
  obligationKey: null,
  purposeKey: "*",
};

const waiver = {
  approvalType: "obligation_waiver",
  sealedAt: sealed,
  revoked: false,
  policyVersionId: "pv1",
  ruleKey: "kr",
  ruleVersion: 3,
  country: "KR",
  obligationKey: "subject_prefix",
  purposeKey: null,
};

test("the lists are the ones the draft names", () => {
  assert.deepEqual([...EMAIL_PERMISSION_EVENT_KINDS], [
    "notice_shown",
    "objected",
    "relationship_started",
    "relationship_ended",
    "basis_ended",
  ]);
  assert.deepEqual([...EMAIL_PERMISSION_DECISION_PHASES], ["enqueue", "send"]);
  assert.deepEqual([...EMAIL_SEND_APPROVAL_TYPES], [
    "risk_accepted",
    "obligation_waiver",
  ]);
  assert.equal(EMAIL_PERMISSION_EVENT_CAPTURE_SOURCES.length, 7);
});

test("a waiver is not an override type", () => {
  // A waiver changes what a rule requires; it can never be the reason a
  // recipient was allowed.
  assert.deepEqual([...EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES], [
    "risk_accepted",
  ]);
  assert.ok(!EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES.includes("obligation_waiver"));
});

test("allowed needs a basis or an override, and no blockers", () => {
  assert.equal(
    decisionAllowed({ legalAllowed: true, overrideApplied: false, blockers: [] }),
    true
  );
  assert.equal(
    decisionAllowed({ legalAllowed: false, overrideApplied: true, blockers: [] }),
    true
  );
  assert.equal(
    decisionAllowed({ legalAllowed: false, overrideApplied: false, blockers: [] }),
    false
  );
});

test("a blocker is not something an override can pass", () => {
  for (const blockers of [["objected"], ["suppressed"], ["country_unknown"]]) {
    assert.equal(
      decisionAllowed({ legalAllowed: true, overrideApplied: true, blockers }),
      false,
      `${blockers[0]} must refuse even with a basis and an override`
    );
  }
});

test("an unsealed or revoked approval applies to nothing", () => {
  assert.equal(
    approvalScopeRefusal(
      { ...riskAccepted, sealedAt: null },
      { approvalType: "risk_accepted", policyVersionId: "pv1", purpose: "product_updates" }
    ),
    "approval_not_sealed"
  );
  assert.equal(
    approvalScopeRefusal(
      { ...riskAccepted, revoked: true },
      { approvalType: "risk_accepted", policyVersionId: "pv1", purpose: "product_updates" }
    ),
    "approval_revoked"
  );
});

test("a risk_accepted approval is not a waiver and the reverse", () => {
  assert.equal(
    approvalScopeRefusal(riskAccepted, {
      approvalType: "obligation_waiver",
      policyVersionId: "pv1",
      ruleKey: "kr",
      ruleVersion: 3,
      country: "KR",
      obligationKey: "subject_prefix",
    }),
    "approval_type_mismatch"
  );
  assert.equal(
    approvalScopeRefusal(waiver, {
      approvalType: "risk_accepted",
      policyVersionId: "pv1",
      purpose: "product_updates",
    }),
    "approval_type_mismatch"
  );
});

test("every scope member is compared, one at a time", () => {
  const base = {
    approvalType: "obligation_waiver",
    policyVersionId: "pv1",
    ruleKey: "kr",
    ruleVersion: 3,
    country: "KR",
    obligationKey: "subject_prefix",
  };
  assert.equal(approvalScopeRefusal(waiver, base), null);

  const cases = [
    [{ policyVersionId: "pv2" }, "approval_policy_version_mismatch"],
    [{ ruleKey: "sg" }, "approval_rule_mismatch"],
    [{ ruleVersion: 4 }, "approval_rule_version_mismatch"],
    [{ country: "SG" }, "approval_country_mismatch"],
    [{ obligationKey: "postal_address" }, "approval_obligation_mismatch"],
  ];
  for (const [patch, expected] of cases) {
    assert.equal(
      approvalScopeRefusal(waiver, { ...base, ...patch }),
      expected,
      `${Object.keys(patch)[0]} must be compared`
    );
  }
});

test("a rule version moving on takes the waiver with it", () => {
  // The obligation was waived for the rule as it read then. A new version is a
  // new question, and answering it with the old approval is how a duty comes
  // back without anybody noticing it went.
  assert.equal(
    approvalScopeRefusal(waiver, {
      approvalType: "obligation_waiver",
      policyVersionId: "pv1",
      ruleKey: "kr",
      ruleVersion: 4,
      country: "KR",
      obligationKey: "subject_prefix",
    }),
    "approval_rule_version_mismatch"
  );
});

test("a purpose-scoped override does not cover another purpose", () => {
  const scoped = { ...riskAccepted, purposeKey: "product_updates" };
  assert.equal(
    approvalScopeRefusal(scoped, {
      approvalType: "risk_accepted",
      policyVersionId: "pv1",
      purpose: "product_updates",
    }),
    null
  );
  assert.equal(
    approvalScopeRefusal(scoped, {
      approvalType: "risk_accepted",
      policyVersionId: "pv1",
      purpose: "promotions",
    }),
    "approval_purpose_mismatch"
  );
  assert.equal(
    approvalScopeRefusal(riskAccepted, {
      approvalType: "risk_accepted",
      policyVersionId: "pv1",
      purpose: "promotions",
    }),
    null,
    '"*" covers every purpose'
  );
});

test("the cohort needs all three digests to agree", () => {
  const member = { userId: "u1", addressDigest: "d1" };
  assert.equal(
    cohortRefusal({
      member,
      userId: "u1",
      deliveryAddressDigest: "d1",
      currentAddressDigest: "d1",
    }),
    null
  );

  const cases = [
    { member: null, userId: "u1", deliveryAddressDigest: "d1", currentAddressDigest: "d1" },
    { member, userId: "u2", deliveryAddressDigest: "d1", currentAddressDigest: "d1" },
    { member, userId: null, deliveryAddressDigest: "d1", currentAddressDigest: "d1" },
    { member, userId: "u1", deliveryAddressDigest: "d2", currentAddressDigest: "d1" },
    { member, userId: "u1", deliveryAddressDigest: "d1", currentAddressDigest: "d2" },
    { member, userId: "u1", deliveryAddressDigest: null, currentAddressDigest: "d1" },
    { member, userId: "u1", deliveryAddressDigest: "d1", currentAddressDigest: null },
  ];
  for (const input of cases) {
    assert.equal(cohortRefusal(input), "approval_member_mismatch");
  }
});

test("changing the address after enqueue stops the pinned delivery too", () => {
  // The delivery still carries the approved address; the account no longer
  // uses it. Sending anyway would be sending to a mailbox the approval was
  // about and the person has since left.
  assert.equal(
    cohortRefusal({
      member: { userId: "u1", addressDigest: "d1" },
      userId: "u1",
      deliveryAddressDigest: "d1",
      currentAddressDigest: "d2",
    }),
    "approval_member_mismatch"
  );
});

test("the database computes allowed the same way", () => {
  const sql = readFileSync(
    new URL(
      "../prisma/migrations/20260921170000_email_permission_ledger/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  // The CASE is why this is a substring set rather than one line: an object
  // in `blockers` must come back as a shape violation rather than as a
  // function error from this constraint, so the length is only taken when it
  // is an array. The derivation is otherwise identical to decisionAllowed.
  for (const part of [
    '"allowed" = (',
    '("legalAllowed" OR "overrideApprovalId" IS NOT NULL)',
    "WHEN jsonb_typeof(\"blockers\") = 'array' THEN jsonb_array_length(\"blockers\") = 0",
    "ELSE FALSE",
  ]) {
    assert.ok(
      sql.includes(part),
      `the constraint must state the same derivation as decisionAllowed: ${part}`
    );
  }
  assert.ok(
    sql.includes(
      'CHECK ("overrideApprovalId" IS NULL OR "legalAllowed" = FALSE)'
    ),
    "a verdict that used an override must keep the refusal"
  );
});
