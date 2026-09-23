// What a `risk_accepted` override cannot cross, and when a cohort may be
// sealed.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 5.6.

import assert from "node:assert/strict";
import test from "node:test";

import {
  overrideBlockers,
  overrideNeeded,
  sealRefusal,
} from "../lib/emailSendApprovalCohortCore.ts";
import {
  cohortMismatchReason,
  cohortRefusal,
} from "../lib/emailPermissionLedgerCore.ts";

const clear = {
  hasObjected: false,
  consentWithdrawn: false,
  suppressedForPurpose: false,
  suppressedForClassification: false,
  suppressedGlobally: false,
  country: "AU",
  obligationsDecided: true,
};

test("an override crosses an absent basis and nothing else", () => {
  assert.deepEqual(overrideBlockers(clear), []);
});

test("each row of section 5.6's right column blocks on its own", () => {
  const cases = [
    [{ hasObjected: true }, "objected"],
    [{ consentWithdrawn: true }, "consent_withdrawn"],
    [{ suppressedForPurpose: true }, "suppressed_purpose"],
    [{ suppressedForClassification: true }, "suppressed_classification"],
    [{ suppressedGlobally: true }, "suppressed_globally"],
    [{ country: "ZZ" }, "country_undetermined"],
    [{ obligationsDecided: false }, "obligation_undecided"],
  ];
  for (const [patch, expected] of cases) {
    assert.deepEqual(overrideBlockers({ ...clear, ...patch }), [expected]);
  }
});

test("an empty country is undetermined, not permissive", () => {
  // A blank string is what an unset column reads as, and answering "no
  // blockers" there would send to an account whose display duties nobody
  // worked out.
  assert.deepEqual(overrideBlockers({ ...clear, country: "   " }), [
    "country_undetermined",
  ]);
});

test("every blocker is reported, not just the first", () => {
  // An operator who clears a suppression and is then refused again for the
  // country, one round trip at a time, stops believing the screen.
  assert.deepEqual(
    overrideBlockers({
      ...clear,
      suppressedGlobally: true,
      country: "ZZ",
      obligationsDecided: false,
    }),
    ["suppressed_globally", "country_undetermined", "obligation_undecided"]
  );
});

test("consent makes the override unnecessary rather than allowed", () => {
  assert.equal(overrideNeeded(true), false);
  assert.equal(overrideNeeded(false), true);
});

// --- sealing -------------------------------------------------------------

const approvedAt = new Date("2026-09-16T00:00:00.000Z");
const sealedAt = new Date("2026-09-16T00:05:00.000Z");
const member = (userId, digest = `digest-${userId}`) => ({
  userId,
  addressDigest: digest,
  addressNormalizationVersion: "v1",
});

const decision = {
  reason: "Owner decision 2026-09-16.",
  reviewCondition: "Re-decide on the first organic signup.",
};

test("a coherent membership seals", () => {
  assert.equal(
    sealRefusal({
      alreadySealed: false,
      ...decision,
      members: [member("u1"), member("u2")],
      approvedAt,
      sealedAt,
    }),
    null
  );
});

test("an already sealed approval cannot be sealed again", () => {
  assert.equal(
    sealRefusal({
      alreadySealed: true,
      ...decision,
      members: [member("u1")],
      approvedAt,
      sealedAt,
    }),
    "already_sealed"
  );
});

test("an empty cohort is refused rather than sealed as covering nobody", () => {
  // An approval covering nobody and one whose member writes failed look the
  // same afterwards, and sealing makes the ambiguity permanent.
  assert.equal(
    sealRefusal({
      alreadySealed: false,
      ...decision,
      members: [],
      approvedAt,
      sealedAt,
    }),
    "no_members"
  );
});

test("one account cannot appear twice", () => {
  assert.equal(
    sealRefusal({
      alreadySealed: false,
      ...decision,
      members: [member("u1"), member("u1", "other")],
      approvedAt,
      sealedAt,
    }),
    "duplicate_user"
  );
});

test("a cohort built under two normalisation rules is refused", () => {
  // Compared under either rule, some members would silently drop out at send
  // time rather than here.
  assert.equal(
    sealRefusal({
      alreadySealed: false,
      ...decision,
      members: [
        member("u1"),
        { ...member("u2"), addressNormalizationVersion: "v2" },
      ],
      approvedAt,
      sealedAt,
    }),
    "mixed_normalization_versions"
  );
});

test("a seal cannot predate the approval it closes", () => {
  assert.equal(
    sealRefusal({
      alreadySealed: false,
      ...decision,
      members: [member("u1")],
      approvedAt,
      sealedAt: new Date(approvedAt.getTime() - 1),
    }),
    "seals_before_approval"
  );
});

// --- the two views of one comparison -------------------------------------

const query = (patch = {}) => ({
  member: member("u1", "digest-a"),
  userId: "u1",
  deliveryAddressDigest: "digest-a",
  currentAddressDigest: "digest-a",
  addressNormalizationVersion: "v1",
  ...patch,
});

test("the stored blocker and the detailed reason never disagree", () => {
  // `cohortRefusal` is derived from `cohortMismatchReason`, and this is what
  // keeps them that way: two implementations of the same comparison would let
  // the admin screen and the send answer differently, and only the screen
  // would be looked at.
  const cases = [
    query(),
    query({ userId: null }),
    query({ member: null }),
    query({ member: member("someone-else", "digest-a") }),
    query({ addressNormalizationVersion: "v2" }),
    query({ deliveryAddressDigest: null }),
    query({ currentAddressDigest: null }),
    query({ deliveryAddressDigest: "digest-b" }),
    query({ currentAddressDigest: "digest-b" }),
  ];
  for (const input of cases) {
    const reason = cohortMismatchReason(input);
    assert.equal(
      cohortRefusal(input),
      reason === null ? null : "approval_member_mismatch"
    );
  }
});

test("each way out of the cohort has its own reason", () => {
  assert.equal(cohortMismatchReason(query()), null);
  assert.equal(cohortMismatchReason(query({ userId: null })), "no_account");
  assert.equal(cohortMismatchReason(query({ member: null })), "not_a_member");
  assert.equal(
    cohortMismatchReason(query({ member: member("other", "digest-a") })),
    "not_a_member"
  );
  assert.equal(
    cohortMismatchReason(query({ addressNormalizationVersion: "v2" })),
    "normalization_version_changed"
  );
  assert.equal(
    cohortMismatchReason(query({ deliveryAddressDigest: null })),
    "no_delivery_address"
  );
  assert.equal(
    cohortMismatchReason(query({ currentAddressDigest: null })),
    "account_has_no_address"
  );
  assert.equal(
    cohortMismatchReason(query({ deliveryAddressDigest: "digest-b" })),
    "pinned_address_changed"
  );
  assert.equal(
    cohortMismatchReason(query({ currentAddressDigest: "digest-b" })),
    "current_address_changed"
  );
});

test("a rule change is never reported as an address the recipient changed", () => {
  // Both digests still match the member row; only the rule that produced them
  // moved. Calling that `pinned_address_changed` would blame the recipient.
  assert.equal(
    cohortMismatchReason(
      query({ addressNormalizationVersion: "v2" })
    ),
    "normalization_version_changed"
  );
});

// --- the approval itself -------------------------------------------------
//
// There is no `approvalStandingRefusal()` any more. It checked the seal and
// the withdrawal, and `approvalScopeRefusal()` in the ledger core already
// checked those plus the type, the policy version and the purpose -- so having
// both meant the send used the one that skipped three of the five.
// `tests/emailPermissionLedgerCore.test.mjs` covers the surviving function.
