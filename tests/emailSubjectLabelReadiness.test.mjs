import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COUNTRIES_WITH_SUBJECT_LABEL_DUTY,
  REQUIRED_SUBJECT_PREFIX,
  SUBJECT_LABEL_OBLIGATIONS,
} from "../lib/emailSubjectLabelReadiness.ts";
import {
  obligationsFor,
  releaseNotesObligationSeed,
} from "../lib/releaseNotesObligationCore.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";

// The subject labels a statute requires, and the duties that rest on them.
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7, 7.8.
//
// The readiness function itself needs a database and is exercised in
// tests/integration/. What is checkable here is the thing most likely to drift:
// whether the list of labels this check confirms still covers the duties that
// name it, and whether the seed agrees about which countries have one.

test("every country with a subject-label duty has a required prefix to confirm", () => {
  // The drift this exists for: a duty recorded as `implemented` against this
  // check, with nothing here that looks at that country's prefix. The duty
  // would read as confirmed by a check that never considers it.
  assert.deepEqual(
    COUNTRIES_WITH_SUBJECT_LABEL_DUTY.filter(
      (countryCode) => !(countryCode in REQUIRED_SUBJECT_PREFIX)
    ),
    ["KR"],
    "a country's subject-label duty is not covered by this check, and is not Korea's waived one"
  );
});

test("Korea is deliberately absent, because its label is waived rather than required", () => {
  // Section 7.7 records the owner's decision not to print `(광고)`. Expecting it
  // here would make that waiver unenforceable: the duty would be both waived
  // and failing. The seed still carries the prefix, because the decision is a
  // waiver in the ledger and not the absence of a value.
  assert.ok(!("KR" in REQUIRED_SUBJECT_PREFIX));
  assert.ok(COUNTRIES_WITH_SUBJECT_LABEL_DUTY.includes("KR"));
  const korea = JURISDICTION_PROFILE_SEED.find((profile) => profile.profileKey === "KR");
  assert.equal(korea?.subjectPrefix, "(광고)");
});

test("each required prefix is the one that country's profile carries", () => {
  // The seed and this check have to agree about the value, or a deployment
  // whose rows match the seed would be reported as missing its label.
  for (const [profileKey, prefix] of Object.entries(REQUIRED_SUBJECT_PREFIX)) {
    const profile = JURISDICTION_PROFILE_SEED.find(
      (entry) => entry.profileKey === profileKey
    );
    assert.ok(profile, `${profileKey} has no seeded profile`);
    // Trimmed, for the reason the module gives: the space after the label is
    // separation, not part of the statutory token.
    assert.equal(profile.subjectPrefix?.trim(), prefix, `${profileKey}'s prefix`);
  }
});

test("the duties this check answers for are the ones it can answer for", () => {
  for (const [countryCode, keys] of Object.entries(SUBJECT_LABEL_OBLIGATIONS)) {
    assert.ok(keys.length > 0, `${countryCode} has a required prefix but no duty naming it`);
    for (const key of keys) {
      assert.ok(obligationsFor(countryCode).includes(key));
    }
  }
});

test("a duty recorded against this check belongs to a country it covers", () => {
  // The seed is where an `implemented` duty names its check, so this is where a
  // duty pointed at this check for a country it does not look at would show up.
  for (const duty of releaseNotesObligationSeed()) {
    if (duty.readinessCheck !== "emailSubjectLabels") continue;
    assert.ok(
      duty.countryCode in REQUIRED_SUBJECT_PREFIX,
      `${duty.countryCode}.${duty.obligationKey} rests on a check that does not look at ${duty.countryCode}`
    );
  }
});
