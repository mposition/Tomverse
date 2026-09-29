// The release-notes flag gates something.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.6 and
// 12; docs/policy/email-notifications.md section 15.2.
//
// The first draft of `RELEASE_NOTES_PURPOSES` held the redesign document's own
// name for the product, which matches no template, so the gate was dead code and
// both enqueue paths were ungated. Nothing failed: a predicate that is never
// true looks exactly like a predicate nobody has broken. This is the test that
// tells the difference.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_FEATURE_FLAG_KEYS,
  EMAIL_RELEASE_NOTES_FLAG_KEY,
  RELEASE_NOTES_PURPOSES,
  releaseNotesFlagApplies,
} from "../lib/emailFeatureFlags.ts";
import {
  EMAIL_TEMPLATE_KEYS,
  emailTemplateDefinition,
} from "../lib/emailTemplateDefinitions.ts";
import { CONSENT_REQUIRED_PURPOSES } from "../lib/emailPreferenceCore.ts";

test("every gated purpose is one a template actually carries", () => {
  // The drift this exists for. A purpose no template has is a flag that cannot
  // refuse anything, and an operator who turned it off would be told the
  // product was off while it sent.
  const templatePurposes = new Set(
    EMAIL_TEMPLATE_KEYS.map((key) => emailTemplateDefinition(key).purpose).filter(
      (purpose) => typeof purpose === "string"
    )
  );
  for (const purpose of RELEASE_NOTES_PURPOSES) {
    assert.ok(
      templatePurposes.has(purpose),
      `${purpose} is gated by the release-notes flag and no template carries it`
    );
  }
});

test("the gated purposes are consent-required, which is what makes them the product's", () => {
  // Not a coincidence worth leaving unstated: release notes are marketing, and
  // marketing purposes are the ones that need consent. A purpose in this list
  // that needed no consent would be a transactional message behind a marketing
  // switch.
  for (const purpose of RELEASE_NOTES_PURPOSES) {
    assert.ok(
      CONSENT_REQUIRED_PURPOSES.has(purpose),
      `${purpose} is gated as release notes but needs no consent`
    );
  }
});

test("the predicate answers for those purposes and nothing else", () => {
  for (const purpose of RELEASE_NOTES_PURPOSES) {
    assert.equal(releaseNotesFlagApplies(purpose), true, purpose);
  }
  // A login code has no purpose at all, and the database insists on that.
  assert.equal(releaseNotesFlagApplies(null), false);
  assert.equal(releaseNotesFlagApplies(undefined), false);
  assert.equal(releaseNotesFlagApplies(""), false);
  assert.equal(releaseNotesFlagApplies("newsletter"), false);
  assert.equal(releaseNotesFlagApplies("promotions"), false);
});

test("the flag is one of the email flags, so it is read the same way", () => {
  // The same `AppSetting` shape as the others: default off, and only the exact
  // string "true" enables. A key that were not in this list would be read by a
  // reader nobody wrote.
  assert.ok(EMAIL_FEATURE_FLAG_KEYS.includes(EMAIL_RELEASE_NOTES_FLAG_KEY));
  assert.match(EMAIL_RELEASE_NOTES_FLAG_KEY, /^feature\.email/);
});
