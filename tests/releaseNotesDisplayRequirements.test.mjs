// What a country requires the message to show, and which duties decide it.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
//
// The partition is the point. `RELEASE_NOTES_OBLIGATIONS` holds every duty a
// country carries, and only some of them decide what is printed; a *filter*
// would let a duty added there fall out of the display contract without anybody
// deciding it should, so the hash would stand still while the thing it stood for
// changed.

import assert from "node:assert/strict";
import test from "node:test";

import { RELEASE_NOTES_OBLIGATIONS } from "../lib/releaseNotesObligationCore.ts";
import {
  ALL_OBLIGATION_COUNTRIES,
  DISPLAY_OBLIGATIONS,
  NON_DISPLAY_OBLIGATIONS,
  UNSUBSCRIBE_NOTICE_LANGUAGES,
  displayRequirementsFor,
  obligationPartitionProblems,
} from "../lib/releaseNotesDisplayRequirements.ts";

test("every declared duty is classified exactly once", () => {
  const problems = ALL_OBLIGATION_COUNTRIES.flatMap((countryCode) =>
    obligationPartitionProblems(countryCode)
  );
  assert.deepEqual(problems, []);
});

test("the partition covers every country that has duties", () => {
  // A country added to `RELEASE_NOTES_OBLIGATIONS` and to neither table would
  // have every duty unclassified, which the test above catches -- but only if
  // this list reaches it.
  for (const countryCode of Object.keys(RELEASE_NOTES_OBLIGATIONS)) {
    assert.ok(ALL_OBLIGATION_COUNTRIES.includes(countryCode), countryCode);
  }
});

test("each non-display duty says why it is not displayed", () => {
  // A bare list would let a duty be excluded with no argument on the page, and
  // the next reader would have to work out whether it was a decision or a
  // typing error.
  for (const [countryCode, entries] of Object.entries(NON_DISPLAY_OBLIGATIONS)) {
    for (const [key, reason] of Object.entries(entries)) {
      assert.equal(typeof reason, "string", `${countryCode}/${key}`);
      assert.ok(reason.length > 20, `${countryCode}/${key} gives no reason`);
    }
  }
});

const rule = (countryCode) => ({
  countryCode,
  ruleKey: `${countryCode.toLowerCase()}-release-notes`,
  ruleVersion: 1,
});

const profile = (overrides = {}) => ({
  subjectPrefix: null,
  footerBlocks: ["business_name", "postal_address"],
  unsubscribeSlaBusinessDays: 10,
  ...overrides,
});

const settled = (obligationKey) => ({
  obligationKey,
  state: "implemented",
  readinessCheck: "emailFooterDisclosures",
  dueBy: null,
  warnDaysBefore: null,
  waiverApprovalId: null,
});

test("a country's requirement carries its own profile and its own duties", () => {
  const { requirements, gaps } = displayRequirementsFor({
    countries: ["US"],
    rules: [rule("US")],
    obligations: { US: [settled("postal_address")] },
    profiles: { US: profile() },
  });
  assert.deepEqual(gaps, []);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].countryCode, "US");
  assert.equal(requirements[0].unsubscribeSlaBusinessDays, 10);
  assert.deepEqual(requirements[0].displayObligations, [
    { obligationKey: "postal_address", state: "implemented", waiverApprovalId: null },
  ]);
  // No languages of its own: the notice is in the message's language, which is a
  // property of the delivery rather than of the country.
  assert.deepEqual(requirements[0].unsubscribeLanguages, []);
});

test("Korea's notice languages come from the table, not from the message", () => {
  const { requirements } = displayRequirementsFor({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: [settled("bilingual_unsubscribe_notice")] },
    profiles: { KR: profile({ subjectPrefix: "(ad) " }) },
  });
  assert.deepEqual(requirements[0].unsubscribeLanguages, UNSUBSCRIBE_NOTICE_LANGUAGES.KR);
  assert.equal(requirements[0].subjectPrefix, "(ad) ");
});

test("a duty that is not a display duty stays out of the contract", () => {
  // The Korean biennial notice is a duty to send a *different* message. Folding
  // it in would move this message's hash when a separate product's readiness
  // changed, and re-render something identical.
  const { requirements } = displayRequirementsFor({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: {
      KR: [settled("body_disclosures"), settled("biennial_consent_notice")],
    },
    profiles: { KR: profile() },
  });
  assert.deepEqual(
    requirements[0].displayObligations.map((entry) => entry.obligationKey),
    ["body_disclosures"]
  );
});

test("a duty with no row at all is left out rather than reported as settled", () => {
  // It blocks as `obligation_undecided` in the verdict. Composing it here as
  // though it had a state would put a claim in the contract that no row makes.
  const { requirements } = displayRequirementsFor({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: [settled("body_disclosures")] },
    profiles: { KR: profile() },
  });
  assert.deepEqual(
    requirements[0].displayObligations.map((entry) => entry.obligationKey),
    ["body_disclosures"]
  );
});

test("a duty this build does not know is not honoured", () => {
  // A row naming something nothing can describe cannot be printed, so it is not
  // in the contract; `obligationsVerdict()` reports it.
  const { requirements } = displayRequirementsFor({
    countries: ["US"],
    rules: [rule("US")],
    obligations: {
      US: [settled("postal_address"), settled("a_duty_from_the_future")],
    },
    profiles: { US: profile() },
  });
  assert.deepEqual(
    requirements[0].displayObligations.map((entry) => entry.obligationKey),
    ["postal_address"]
  );
});

test("a missing profile is a gap, not a requirement with defaults", () => {
  // A default here would compose a contract claiming a footer and an unsubscribe
  // deadline this policy version never seeded. The verdict refuses it as
  // `display_unsatisfiable` instead.
  const { requirements, gaps } = displayRequirementsFor({
    countries: ["KR", "US"],
    rules: [rule("KR"), rule("US")],
    obligations: {},
    profiles: { US: profile() },
  });
  assert.deepEqual(gaps, [{ countryCode: "KR", reason: "no_profile" }]);
  assert.deepEqual(
    requirements.map((entry) => entry.countryCode),
    ["US"]
  );
});

test("a country with no rule is neither a requirement nor a gap", () => {
  // The authority verdict already refuses it as `no_country_rule`, and naming
  // the same absence twice would have an operator settling two things.
  const { requirements, gaps } = displayRequirementsFor({
    countries: ["KR", "US"],
    rules: [rule("US")],
    obligations: {},
    profiles: { KR: profile(), US: profile() },
  });
  assert.deepEqual(gaps, []);
  assert.deepEqual(
    requirements.map((entry) => entry.countryCode),
    ["US"]
  );
});

test("the duties are in the declared order however the rows come back", () => {
  // Two reads of the same rows have to compose the same contract, or the hash
  // moves on nothing and every message is re-enqueued once.
  const rows = [
    settled("advertising_subject_label"),
    settled("body_disclosures"),
    settled("no_login_for_unsubscribe"),
    settled("bilingual_unsubscribe_notice"),
  ];
  const first = displayRequirementsFor({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: rows },
    profiles: { KR: profile() },
  });
  const second = displayRequirementsFor({
    countries: ["KR"],
    rules: [rule("KR")],
    obligations: { KR: [...rows].reverse() },
    profiles: { KR: profile() },
  });
  assert.deepEqual(first.requirements, second.requirements);
  assert.deepEqual(
    first.requirements[0].displayObligations.map((entry) => entry.obligationKey),
    [...DISPLAY_OBLIGATIONS.KR]
  );
});

test("candidates are composed in one order whatever order they arrive in", () => {
  const forwards = displayRequirementsFor({
    countries: ["US", "KR"],
    rules: [rule("KR"), rule("US")],
    obligations: {},
    profiles: { KR: profile(), US: profile() },
  });
  const backwards = displayRequirementsFor({
    countries: ["KR", "US"],
    rules: [rule("US"), rule("KR")],
    obligations: {},
    profiles: { US: profile(), KR: profile() },
  });
  assert.deepEqual(forwards.requirements, backwards.requirements);
  assert.deepEqual(
    forwards.requirements.map((entry) => entry.countryCode),
    ["KR", "US"]
  );
});
