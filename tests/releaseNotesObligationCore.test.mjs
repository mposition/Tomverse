import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OBLIGATION_STATES,
  RELEASE_NOTES_OBLIGATIONS,
  obligationsFor,
  obligationsVerdict,
  releaseNotesObligationSeed,
  releaseNotesObligationSeedProblems,
} from "../lib/releaseNotesObligationCore.ts";
import { releaseNotesRuleKey } from "../lib/releaseNotesCountryRuleCore.ts";

// Whether a country's statutory duties are settled.
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7, 7.8.

const NOW = new Date("2026-09-28T00:00:00.000Z");
const DAY = 86_400_000;

const scope = {
  countryCode: "KR",
  ruleKey: releaseNotesRuleKey("KR"),
  ruleVersion: 1,
  policyVersionId: "pv_1",
};

const implemented = (obligationKey, readinessCheck = "check") => ({
  obligationKey,
  state: "implemented",
  readinessCheck,
  dueBy: null,
  warnDaysBefore: null,
  waiverApprovalId: null,
});

const waived = (obligationKey, waiverApprovalId = "ap_1") => ({
  obligationKey,
  state: "waived",
  readinessCheck: null,
  dueBy: null,
  warnDaysBefore: null,
  waiverApprovalId,
});

const deferred = (obligationKey, dueBy, warnDaysBefore = null) => ({
  obligationKey,
  state: "deferred",
  readinessCheck: null,
  dueBy,
  warnDaysBefore,
  waiverApprovalId: null,
});

const goodWaiver = (overrides = {}) => ({
  id: "ap_1",
  approvalType: "obligation_waiver",
  sealedAt: new Date("2026-09-20T00:00:00.000Z"),
  revoked: false,
  policyVersionId: "pv_1",
  ruleKey: releaseNotesRuleKey("KR"),
  ruleVersion: 1,
  country: "KR",
  obligationKey: "advertising_subject_label",
  ...overrides,
});

/** Every Korean duty settled by a passing check, which nothing real does. */
const allImplemented = () =>
  obligationsFor("KR").map((key) => implemented(key, "check"));

const verdict = (overrides = {}) =>
  obligationsVerdict({
    ...scope,
    stored: [],
    readiness: { check: true },
    waivers: [],
    now: NOW,
    ...overrides,
  });

test("the seed is usable as written", () => {
  assert.deepEqual(releaseNotesObligationSeedProblems(), []);
});

test("every seeded duty is one this build declares", () => {
  for (const duty of releaseNotesObligationSeed()) {
    assert.ok(
      obligationsFor(duty.countryCode).includes(duty.obligationKey),
      `${duty.countryCode}.${duty.obligationKey}`
    );
  }
});

test("the seed settles no duty by waiving it", () => {
  // An approval is a person's act. A seed that invented one would be inventing
  // the decision, so the duties section 7.7 records as waived are left
  // unsettled here and their rule does not send until the approval exists.
  for (const duty of releaseNotesObligationSeed()) {
    assert.notEqual(duty.state, "waived", `${duty.countryCode}.${duty.obligationKey}`);
  }
  const korean = releaseNotesObligationSeed()
    .filter((duty) => duty.countryCode === "KR")
    .map((duty) => duty.obligationKey);
  assert.ok(!korean.includes("advertising_subject_label"));
});

test("the duties this build does not do have no row", () => {
  // A seeded state is a claim that the duty is done, so the ones that are not
  // are absent and their rule does not send. Two of Korea's are in that state
  // for different reasons, and both are the mechanism working:
  //
  // - `bilingual_unsubscribe_notice`: the footer renders one language, never
  //   both, so the duty is simply not done.
  // - `consent_result_notice_14_days`: the notice needs the wording approved
  //   in S2 section 4, which is not in this tree, so there is nothing to
  //   confirm yet.
  // - `advertising_subject_label`: waived by the owner, and a waiver is an
  //   approval that only a person can write.
  const korean = releaseNotesObligationSeed()
    .filter((duty) => duty.countryCode === "KR")
    .map((duty) => duty.obligationKey);
  assert.deepEqual(
    obligationsFor("KR").filter((key) => !korean.includes(key)),
    [
      "bilingual_unsubscribe_notice",
      "consent_result_notice_14_days",
      "advertising_subject_label",
    ]
  );
});

test("a duty with no row blocks its rule", () => {
  // The whole mechanism: the duties live in code, the states live in rows, and
  // one nobody has settled stops the send rather than passing quietly.
  const result = verdict();
  assert.equal(result.allSettled, false);
  assert.deepEqual(result.blockers, [...obligationsFor("KR")]);
  assert.deepEqual(
    result.obligations.map((entry) => [entry.state, entry.reason]),
    obligationsFor("KR").map(() => [null, "no_state"])
  );
});

test("a country with no declared duties has nothing to settle", () => {
  const result = verdict({ countryCode: "DE", ruleKey: releaseNotesRuleKey("DE") });
  assert.deepEqual(result.obligations, []);
  assert.equal(result.allSettled, true);
});

test("implemented settles only while its own check passes", () => {
  assert.equal(verdict({ stored: allImplemented() }).allSettled, true);

  const failing = verdict({ stored: allImplemented(), readiness: { check: false } });
  assert.equal(failing.allSettled, false);
  assert.equal(failing.obligations[0].reason, "readiness_check_failing");

  // A check nobody runs is a duty nobody is confirming (invariant 9), so an
  // unknown name blocks rather than passing.
  const unknown = verdict({ stored: allImplemented(), readiness: {} });
  assert.equal(unknown.obligations[0].reason, "readiness_check_unknown");

  const nameless = verdict({
    stored: allImplemented().map((row) => ({ ...row, readinessCheck: null })),
  });
  assert.equal(nameless.obligations[0].reason, "readiness_check_unknown");

  // An inherited property is not an answer. Reading `readiness[name]` reached
  // the prototype, so a duty naming `toString` found a function, read it as
  // truthy, and settled -- the fail-closed rule defeated by a name nobody
  // checked.
  for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    const inherited = verdict({
      stored: allImplemented().map((row) => ({ ...row, readinessCheck: name })),
      readiness: {},
    });
    assert.equal(
      inherited.obligations[0].reason,
      "readiness_check_unknown",
      `${name} settled a duty`
    );
  }

  // And an own property that is not a boolean says nothing either way.
  const notBoolean = verdict({
    stored: allImplemented(),
    readiness: { check: "yes" },
  });
  assert.equal(notBoolean.obligations[0].reason, "readiness_check_unknown");
});

test("a deferral settles until its date, and warns before it", () => {
  const keys = obligationsFor("KR");
  const withDeferral = (dueBy, warnDaysBefore) => [
    deferred(keys[0], dueBy, warnDaysBefore),
    ...keys.slice(1).map((key) => implemented(key)),
  ];

  const future = verdict({ stored: withDeferral(new Date(NOW.getTime() + 30 * DAY), 7) });
  assert.equal(future.allSettled, true);
  assert.deepEqual(future.warnings, []);

  const soon = verdict({ stored: withDeferral(new Date(NOW.getTime() + 5 * DAY), 7) });
  assert.equal(soon.allSettled, true);
  assert.deepEqual(soon.warnings, [keys[0]]);
  assert.equal(soon.obligations[0].warning, "deferral_due_soon");

  const overdue = verdict({ stored: withDeferral(new Date(NOW.getTime() - DAY), 7) });
  assert.equal(overdue.allSettled, false);
  assert.equal(overdue.obligations[0].reason, "deferral_overdue");

  // The instant it falls due, not the day after.
  const exactly = verdict({ stored: withDeferral(new Date(NOW.getTime()), 7) });
  assert.equal(exactly.obligations[0].reason, "deferral_overdue");

  // A deferral with no warning window does not settle. The first version read it
  // as "no warning" and settled -- a duty whose deadline nobody would be told
  // about, which is the one thing section 7.7 asks a deferral to have. The CHECK
  // refuses to store one now, and this is what a row from before it gets.
  const noWindow = verdict({ stored: withDeferral(new Date(NOW.getTime() + DAY), null) });
  assert.equal(noWindow.allSettled, false);
  assert.equal(noWindow.obligations[0].reason, "deferral_not_watched");
  assert.deepEqual(noWindow.warnings, []);
});

test("a waiver settles a duty only when the approval says so, exactly", () => {
  const keys = obligationsFor("KR");
  const stored = keys.map((key) =>
    key === "advertising_subject_label" ? waived(key) : implemented(key)
  );
  const at = keys.indexOf("advertising_subject_label");

  const ok = verdict({ stored, waivers: [goodWaiver()] });
  assert.equal(ok.allSettled, true);
  assert.equal(ok.obligations[at].state, "waived");

  const cases = [
    [{ sealedAt: null }, "waiver_not_sealed"],
    [{ revoked: true }, "waiver_revoked"],
    [{ approvalType: "risk_accepted" }, "waiver_wrong_type"],
    [{ policyVersionId: "pv_2" }, "waiver_scope_mismatch"],
    [{ ruleVersion: 2 }, "waiver_scope_mismatch"],
    [{ ruleKey: releaseNotesRuleKey("SG") }, "waiver_scope_mismatch"],
    [{ country: "SG" }, "waiver_scope_mismatch"],
    [{ obligationKey: "body_disclosures" }, "waiver_scope_mismatch"],
  ];
  for (const [overrides, reason] of cases) {
    const result = verdict({ stored, waivers: [goodWaiver(overrides)] });
    assert.equal(result.obligations[at].reason, reason, JSON.stringify(overrides));
    assert.equal(result.allSettled, false);
  }

  // A link to nothing, and a row claiming the state with no link at all.
  assert.equal(verdict({ stored, waivers: [] }).obligations[at].reason, "waiver_missing");
  assert.equal(
    verdict({ stored: stored.map((row) => (row.state === "waived" ? { ...row, waiverApprovalId: null } : row)) })
      .obligations[at].reason,
    "waiver_missing"
  );
});

test("a stored duty this build does not declare is reported, never obeyed", () => {
  const result = verdict({
    stored: [...allImplemented(), implemented("something_nobody_declared")],
  });
  assert.deepEqual(result.unknown, ["something_nobody_declared"]);
  // It settles nothing and blocks nothing: the declared list is what a send
  // needs, and a row outside it is a leftover for somebody to look at.
  assert.equal(result.allSettled, true);
  assert.deepEqual(result.blockers, []);
});

test("the states are the three the contract names", () => {
  assert.deepEqual([...OBLIGATION_STATES], ["implemented", "deferred", "waived"]);
});

test("Korea's declared duties are section 7.7's six", () => {
  assert.deepEqual(
    [...RELEASE_NOTES_OBLIGATIONS.KR],
    [
      "body_disclosures",
      "bilingual_unsubscribe_notice",
      "no_login_for_unsubscribe",
      "consent_result_notice_14_days",
      "biennial_consent_notice",
      "advertising_subject_label",
    ]
  );
  // Not Korea-only: the same list carries Singapore's label and the United
  // States' postal address (section 7.8).
  assert.deepEqual([...RELEASE_NOTES_OBLIGATIONS.SG], ["adv_subject_label"]);
  assert.deepEqual([...RELEASE_NOTES_OBLIGATIONS.US], ["postal_address"]);
});
