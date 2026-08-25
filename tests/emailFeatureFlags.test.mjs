import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CAMPAIGNS_DISABLED_MESSAGE,
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_CONSENT_RECONFIRM_FLAG_KEY,
  EMAIL_FEATURE_FLAG_KEYS,
  EMAIL_MARKETING_FLAG_KEY,
  ENQUEUE_REFUSALS,
  ENQUEUE_REFUSAL_MESSAGE,
  campaignActionRefusal,
  emailFeatureEnabledFromValue,
  marketingFlagApplies,
} from "../lib/emailFeatureFlags.ts";

// The three flags the ADR named and the code did not have (EM-05).
//
// Contract: docs/policy/email-notifications.md §15.2.
//
// The finding was not that marketing could be sent — it cannot, for reasons
// stronger than a flag — but that a person reading §15.2 went looking for a
// switch that had never been built. So the first thing worth pinning is that
// the names in the document are the names in the code.

test("the ADR's three flag names are the keys the code reads", () => {
  const adr = readFileSync(
    "docs/policy/email-notifications.md",
    "utf8"
  );
  for (const key of EMAIL_FEATURE_FLAG_KEYS) {
    assert.ok(
      adr.includes(key),
      `${key} is read by the code but named nowhere in the ADR`
    );
  }
  // And the other direction: the document names exactly these three.
  assert.deepEqual([...EMAIL_FEATURE_FLAG_KEYS], [
    "feature.emailMarketingEnabled",
    "feature.emailCampaignsEnabled",
    "feature.emailConsentReconfirmEnabled",
  ]);
});

test("only the exact string true enables a flag", () => {
  assert.equal(emailFeatureEnabledFromValue("true"), true);
  // Everything else is off, including the near-misses an operator might type.
  // The direction that fails safely is the one where a marketing send does not
  // happen, so there is no leniency here at all.
  for (const value of ["TRUE", "True", "1", "yes", "on", "", " true", null, undefined]) {
    assert.equal(
      emailFeatureEnabledFromValue(value),
      false,
      `${JSON.stringify(value)} must not enable a flag`
    );
  }
});

test("the marketing flag reaches marketing and nothing else", () => {
  assert.equal(marketingFlagApplies("marketing"), true);
  // A switch that could stop transactional mail would be a second route to
  // login codes not arriving — the same reasoning that keeps the send-health
  // kill switch marketing-only.
  for (const classification of ["transactional", "service", "legal"]) {
    assert.equal(marketingFlagApplies(classification), false);
  }
});

test("marketing and campaigns are separate flags, because they are separate questions", () => {
  assert.notEqual(EMAIL_MARKETING_FLAG_KEY, EMAIL_CAMPAIGNS_FLAG_KEY);
  // A campaign is a fan-out mechanism, not a classification: a model retirement
  // notice is `service`, goes out through the same waves and is not marketing.
  // One flag for both would either switch off retirement notices along with
  // marketing, or switch marketing on along with them.
  assert.equal(marketingFlagApplies("service"), false);
});

test("a refused enqueue names its reason, and every reason has a sentence", () => {
  for (const refusal of ENQUEUE_REFUSALS) {
    const message = ENQUEUE_REFUSAL_MESSAGE[refusal];
    assert.ok(message && message.length > 0, `${refusal} has no message`);
    // The message says what happened, not just that something did. A bare
    // `null` was the old answer and it said neither.
    assert.ok(
      /queue|address|switched off/i.test(message),
      `${refusal}'s message does not say what happened: ${message}`
    );
  }
});

test("the campaign refusal is null when enabled and a stated reason when not", () => {
  assert.equal(campaignActionRefusal(true), null);
  const refused = campaignActionRefusal(false);
  assert.equal(refused?.refusal, "campaigns_disabled");
  // Reading is still allowed, and the message says so: an operator who cannot
  // see what the feature already did cannot tell it apart from broken.
  assert.match(CAMPAIGNS_DISABLED_MESSAGE, /[Rr]eading/);
});

test("the consent re-confirmation key exists even though nothing reads it", () => {
  // Declared on purpose: the batch does not exist, and the EM-05 finding was
  // that the ADR's name resolved to nothing. A key with an explanation attached
  // is strictly better than a search with no results — and wiring it to a
  // no-op consumer would be worse, because a switch that does nothing teaches
  // an operator that switches do nothing.
  assert.equal(
    EMAIL_CONSENT_RECONFIRM_FLAG_KEY,
    "feature.emailConsentReconfirmEnabled"
  );
  const source = readFileSync("lib/emailFeatureFlags.ts", "utf8");
  assert.match(source, /the batch does not exist yet/i);
});
