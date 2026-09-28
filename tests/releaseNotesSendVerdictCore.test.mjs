// The one verdict four callers share, and what each part of it will not do.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 5.3, 5.6,
// 7.6, 7.7, 7.8.
//
// The parts are tested where they live -- the authorities in
// tests/releaseNotesCountryRuleCore.test.mjs, the duties in
// tests/releaseNotesObligationCore.test.mjs. What is tested here is the
// composition: that the three answers stay three answers, that an override
// crosses a refusal and not a blocker, and that every blocker in the closed list
// is one this function can actually produce.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SEND_BLOCKERS,
  releaseNotesSendVerdict,
} from "../lib/releaseNotesSendVerdictCore.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const POLICY = "policy-1";
const PURPOSE = "product_news";

const rule = (countryCode, overrides = {}) => ({
  countryCode,
  ruleKey: `release-notes:${countryCode}`,
  ruleVersion: 1,
  basis: "express_consent",
  status: "open",
  ...overrides,
});

const settledDuty = (obligationKey) => ({
  obligationKey,
  state: "implemented",
  readinessCheck: "emailBusinessIdentity",
  dueBy: null,
  warnDaysBefore: null,
  waiverApprovalId: null,
});

/** Korea's three duties, all settled, so a Korean case can be about one thing. */
const koreanDuties = [
  settledDuty("body_disclosures"),
  settledDuty("bilingual_unsubscribe_notice"),
  settledDuty("no_login_for_unsubscribe"),
  settledDuty("consent_result_notice_14_days"),
  settledDuty("biennial_consent_notice"),
  settledDuty("advertising_subject_label"),
];

const approval = (overrides = {}) => ({
  approvalType: "risk_accepted",
  sealedAt: new Date("2026-09-20T00:00:00.000Z"),
  revoked: false,
  policyVersionId: POLICY,
  ruleKey: null,
  ruleVersion: null,
  country: null,
  obligationKey: null,
  purposeKey: "*",
  ...overrides,
});

const override = ({ approval: approvalOverrides, ...rest } = {}) => ({
  approvalId: "approval-1",
  approval: approval(approvalOverrides),
  member: { userId: "user-1", addressDigest: "digest-1", addressNormalizationVersion: "v1" },
  userId: "user-1",
  deliveryAddressDigest: "digest-1",
  currentAddressDigest: "digest-1",
  addressNormalizationVersion: "v1",
  standing: { hasObjected: false, consentWithdrawn: false, shownNoUnrequestedSendPromise: false },
  ...rest,
});

const verdict = (overrides = {}) =>
  releaseNotesSendVerdict({
    purpose: PURPOSE,
    policyVersionId: POLICY,
    countries: ["AU"],
    rules: [rule("AU")],
    obligations: {},
    readiness: { emailBusinessIdentity: true },
    waivers: [],
    recipient: { suppressed: false, objected: false, consent: { express: true, evidenceIds: ["c1"] } },
    flags: { marketingEnabled: true, releaseNotesEnabled: true },
    display: { pinnedDisplayContractHash: "hash-1", requiredDisplayContractHash: "hash-1" },
    override: null,
    phase: "send",
    now: NOW,
    ...overrides,
  });

test("an express consent in an open country with nothing against it sends", () => {
  const result = verdict();
  assert.equal(result.legalAllowed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.allowed, true);
  assert.equal(result.sharedBasis, "express_consent");
  assert.deepEqual(result.ruleVersions, [{ ruleKey: "release-notes:AU", ruleVersion: 1 }]);
  // No override was needed, so nothing is claimed about one.
  assert.equal(result.overrideApplied, null);
  assert.equal(result.overrideRefusal, null);
});

test("every candidate country has to allow, not one of them", () => {
  const result = verdict({
    countries: ["AU", "KR"],
    rules: [rule("AU"), rule("KR", { status: "closed" })],
    obligations: { KR: koreanDuties },
  });
  assert.equal(result.legalAllowed, false);
  assert.equal(result.allowed, false);
  assert.equal(
    result.authorities.find((entry) => entry.country === "KR").reason,
    "country_closed"
  );
  // And the duties of that country were still read: the record says everything
  // that was true, not the first thing that stopped it.
  assert.equal(result.obligations.KR.allSettled, true);
});

test("the person's own answers are blockers, not refusals of the law", () => {
  for (const [field, blocker] of [
    ["suppressed", "suppressed"],
    ["objected", "objected"],
  ]) {
    const result = verdict({
      recipient: {
        suppressed: false,
        objected: false,
        consent: { express: true, evidenceIds: ["c1"] },
        [field]: true,
      },
    });
    assert.equal(result.legalAllowed, true, `${field} should not change the authorities`);
    assert.deepEqual(result.blockers, [blocker]);
    assert.equal(result.allowed, false);
  }
});

test("an undecided duty blocks the send, and names the country it is in", () => {
  const result = verdict({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: koreanDuties.slice(1) },
  });
  assert.deepEqual(result.blockers, ["obligation_undecided"]);
  assert.equal(result.obligations.KR.allSettled, false);
  assert.equal(result.allowed, false);
  // The authorities are untouched by it: the law allowed this send, and a duty
  // this build has not settled is our problem rather than the recipient's basis.
  assert.equal(result.legalAllowed, true);
});

test("a country with no rule is refused by the authority and its duties are not invented", () => {
  const result = verdict({ countries: ["AU", "JP"], rules: [rule("AU")] });
  assert.equal(
    result.authorities.find((entry) => entry.country === "JP").reason,
    "no_country_rule"
  );
  assert.equal(Object.hasOwn(result.obligations, "JP"), false);
  assert.equal(result.allowed, false);
});

test("either flag being off is one blocker with one name", () => {
  for (const flags of [
    { marketingEnabled: false, releaseNotesEnabled: true },
    { marketingEnabled: true, releaseNotesEnabled: false },
    { marketingEnabled: false, releaseNotesEnabled: false },
  ]) {
    assert.deepEqual(verdict({ flags }).blockers, ["feature_disabled"]);
  }
});

test("no country, or one that could not be settled, is a blocker an override cannot cross", () => {
  for (const countries of [[], ["ZZ"], ["AU", "ZZ"]]) {
    const result = verdict({
      countries,
      recipient: { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } },
      override: override(),
    });
    assert.ok(result.blockers.includes("country_undetermined"), JSON.stringify(countries));
    // And the override does not even apply. `overrideBlockers()` -- the approved
    // list S9 inherits -- refuses it for an undetermined country, so the refusal
    // names that rather than recording an override as applied to a send that
    // could not go.
    assert.equal(result.overrideApplied, null);
    assert.match(result.overrideRefusal ?? "", /country_undetermined/);
    assert.equal(result.allowed, false);
  }
});

test("an override is refused for the standing overrideBlockers() names", () => {
  // S8's approved list, which the first version of this verdict never called.
  // Each of these is a person the override may not reach, however the approval
  // is scoped.
  const noConsent = { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } };
  const cases = [
    [{ hasObjected: true }, "objected"],
    [{ consentWithdrawn: true }, "consent_withdrawn"],
    [{ shownNoUnrequestedSendPromise: true }, "promised_no_unrequested_send"],
  ];
  for (const [standing, reason] of cases) {
    const result = verdict({
      recipient: noConsent,
      override: override({
        standing: {
          hasObjected: false,
          consentWithdrawn: false,
          shownNoUnrequestedSendPromise: false,
          ...standing,
        },
      }),
    });
    assert.equal(result.overrideApplied, null, reason);
    assert.match(result.overrideRefusal ?? "", new RegExp(reason));
    assert.ok(result.blockers.includes("approval_member_mismatch"), reason);
    assert.equal(result.allowed, false);
  }

  // A country with no reviewed rule is a refusal about the destination, which no
  // override lifts -- and `overrideBlockers()` would refuse it too, since
  // `profileForCountry()` answers ZZ. The first of the two is the one named.
  const unreviewed = verdict({
    countries: ["JP"],
    rules: [],
    recipient: noConsent,
    override: override(),
  });
  assert.equal(unreviewed.overrideApplied, null);
  assert.match(unreviewed.overrideRefusal ?? "", /authority_not_liftable:.*no_country_rule/);
  assert.equal(unreviewed.allowed, false);

  // And with nothing against the person, the override applies.
  const clean = verdict({ recipient: noConsent, override: override() });
  assert.notEqual(clean.overrideApplied, null);
  assert.equal(clean.allowed, true);
});

test("the display contract has three states and the enqueue does not compare", () => {
  const unsatisfiable = verdict({
    display: { pinnedDisplayContractHash: "hash-1", requiredDisplayContractHash: null },
  });
  assert.deepEqual(unsatisfiable.blockers, ["display_unsatisfiable"]);
  assert.equal(unsatisfiable.displayContract.satisfied, false);

  const moved = verdict({
    display: { pinnedDisplayContractHash: "hash-1", requiredDisplayContractHash: "hash-2" },
  });
  assert.deepEqual(moved.blockers, ["display_contract_changed"]);

  // At send a message with no pin cannot be confirmed against what the duties
  // now require, which is the same refusal.
  const unpinned = verdict({
    display: { pinnedDisplayContractHash: null, requiredDisplayContractHash: "hash-2" },
  });
  assert.deepEqual(unpinned.blockers, ["display_contract_changed"]);

  // At enqueue the pinned hash is the value about to be written, so there is
  // nothing to compare it with. Comparing anyway made every first enqueue a
  // `display_contract_changed` -- the blocker that means the opposite.
  const first = verdict({
    phase: "enqueue",
    display: { pinnedDisplayContractHash: null, requiredDisplayContractHash: "hash-2" },
  });
  assert.deepEqual(first.blockers, []);
  assert.equal(first.displayContract.satisfied, true);
  assert.equal(first.allowed, true);

  // And an enqueue whose obligations compose into nothing is still refused.
  const impossible = verdict({
    phase: "enqueue",
    display: { pinnedDisplayContractHash: null, requiredDisplayContractHash: null },
  });
  assert.deepEqual(impossible.blockers, ["display_unsatisfiable"]);
});

test("an override is consulted only where the law refused", () => {
  // A send the law allows does not consult one, however broken it is: putting an
  // approval in the record as the reason for something it was not the reason for
  // is what section 5.6 rule 2 is about.
  const notNeeded = verdict({
    override: override({ approval: { sealedAt: null, revoked: true } }),
  });
  assert.equal(notNeeded.overrideApplied, null);
  assert.equal(notNeeded.overrideRefusal, null);
  assert.deepEqual(notNeeded.blockers, []);
  assert.equal(notNeeded.allowed, true);
});

test("an override that does not apply is a named refusal, not a silent absence", () => {
  const refused = (overrides) =>
    verdict({
      recipient: { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } },
      rules: [rule("AU", { basis: "inferred_consent" })],
      override: override(overrides),
    });

  const cases = [
    [{ approval: { sealedAt: null } }, "approval_not_sealed"],
    [{ approval: { revoked: true } }, "approval_revoked"],
    [{ approval: { approvalType: "obligation_waiver" } }, "approval_type_mismatch"],
    [{ approval: { policyVersionId: "policy-2" } }, "approval_policy_version_mismatch"],
    [{ approval: { purposeKey: "something_else" } }, "approval_purpose_mismatch"],
    [{ member: null }, "approval_member_mismatch"],
    [{ member: { userId: "user-2", addressDigest: "digest-1" } }, "approval_member_mismatch"],
    // The address changed after enqueue: the approval was for a mailbox this
    // person has since stopped using.
    [{ currentAddressDigest: "digest-2" }, "approval_member_mismatch"],
  ];
  for (const [overrides, reason] of cases) {
    const result = refused(overrides);
    assert.equal(result.overrideRefusal, reason, JSON.stringify(overrides));
    assert.equal(result.overrideApplied, null);
    assert.deepEqual(result.blockers, ["approval_member_mismatch"]);
    assert.equal(result.allowed, false);
  }

  // The same refusal, with the override in order: it applies, and the send goes
  // although the law refused it.
  const applied = refused({});
  assert.equal(applied.overrideRefusal, null);
  assert.deepEqual(applied.overrideApplied, { approvalId: "approval-1", type: "risk_accepted" });
  assert.equal(applied.legalAllowed, false);
  assert.equal(applied.allowed, true);
  // And the refusal it crossed is still in the record (section 5.6 rule 2).
  assert.equal(
    applied.authorities.find((entry) => entry.country === "AU").reason,
    "inferred_consent_not_in_effect"
  );
});

test("a refused send with no override at all says so without a reason", () => {
  const result = verdict({
    recipient: { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } },
    rules: [rule("AU", { basis: "inferred_consent" })],
    override: null,
  });
  assert.equal(result.overrideApplied, null);
  assert.equal(result.overrideRefusal, null);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.allowed, false);
});

test("everything true is reported, not the first thing that stopped it", () => {
  const result = verdict({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: koreanDuties.slice(1) },
    recipient: { suppressed: true, objected: true, consent: { express: true, evidenceIds: ["c1"] } },
    flags: { marketingEnabled: false, releaseNotesEnabled: true },
    display: { pinnedDisplayContractHash: "hash-1", requiredDisplayContractHash: null },
  });
  assert.deepEqual(result.blockers, [
    "suppressed",
    "objected",
    "obligation_undecided",
    "feature_disabled",
    "display_unsatisfiable",
  ]);
});

test("every blocker in the closed list is one this function produces", () => {
  // A name in the list that nothing can reach is a reason a reader will look up
  // and never see, and the list is the vocabulary a caller reports.
  const produced = new Set();
  const collect = (result) => {
    for (const blocker of result.blockers) produced.add(blocker);
  };
  collect(verdict({ recipient: { suppressed: true, objected: true, consent: { express: true, evidenceIds: ["c1"] } } }));
  collect(verdict({ countries: ["ZZ"] }));
  collect(verdict({ countries: ["KR"], rules: [rule("KR")], obligations: { KR: [] } }));
  collect(verdict({ flags: { marketingEnabled: false, releaseNotesEnabled: false } }));
  collect(verdict({ display: { pinnedDisplayContractHash: "a", requiredDisplayContractHash: "b" } }));
  collect(verdict({ display: { pinnedDisplayContractHash: "a", requiredDisplayContractHash: null } }));
  collect(
    verdict({
      recipient: { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } },
      rules: [rule("AU", { basis: "inferred_consent" })],
      override: override({ approval: { sealedAt: null } }),
    })
  );
  assert.deepEqual([...produced].sort(), [...SEND_BLOCKERS].sort());
});

test("the verdict carries what it was asked, so a record can be read without the request", () => {
  const result = verdict({ phase: "enqueue" });
  assert.equal(result.policyVersionId, POLICY);
  assert.equal(result.phase, "enqueue");
  assert.equal(result.evaluatedAt.toISOString(), NOW.toISOString());
});

test("an override lifts a missing basis and nothing about the destination", () => {
  // docs/policy/email-notifications.md section 5.1.1: an override answers "this
  // person has not agreed", not "this country is closed". The first version
  // treated every legal refusal alike, so a cohort member resolved to a mapped,
  // closed country with no duties and an EU profile was sent to under the
  // override.
  const noConsent = { suppressed: false, objected: false, consent: { express: false, evidenceIds: [] } };

  const closed = verdict({
    countries: ["IT"],
    rules: [rule("IT", { status: "closed" })],
    recipient: noConsent,
    override: override(),
  });
  assert.equal(closed.legalAllowed, false);
  assert.equal(closed.overrideApplied, null);
  assert.match(closed.overrideRefusal ?? "", /authority_not_liftable:.*country_closed/);
  assert.ok(closed.blockers.includes("approval_member_mismatch"));
  assert.equal(closed.allowed, false);

  // The same country open, with the same missing consent, is what the override
  // exists for.
  const open = verdict({
    countries: ["IT"],
    rules: [rule("IT")],
    recipient: noConsent,
    override: override(),
  });
  assert.notEqual(open.overrideApplied, null);
  assert.equal(open.allowed, true);

  // And closing a country later stops the cohort too.
  const closedLater = verdict({
    countries: ["AU"],
    rules: [rule("AU", { status: "closed" })],
    recipient: noConsent,
    override: override(),
  });
  assert.equal(closedLater.allowed, false);
});
