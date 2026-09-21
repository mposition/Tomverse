// The purpose classification table, and the two invariants it closes.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.1
// invariants 5 and 7.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BULK_UNSUBSCRIBE_PURPOSES,
  EMAIL_CLASSIFICATIONS,
  EMAIL_PURPOSE_CLASSIFICATION,
  MARKETING_PURPOSES,
  classificationDisagreements,
  emailPurposeClassification,
  emailPurposeEntry,
  isMarketingPurpose,
} from "../lib/emailPurposeClassification.ts";
import {
  CONSENT_REQUIRED_PURPOSES,
  EMAIL_PURPOSES,
  LOCKED_EMAIL_PURPOSES,
} from "../lib/emailPreferenceCore.ts";

test("the table and the two sets that predate it agree", () => {
  assert.deepEqual(classificationDisagreements(), []);
});

test("every purpose appears exactly once", () => {
  const seen = EMAIL_PURPOSE_CLASSIFICATION.map((entry) => entry.purpose);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), [...EMAIL_PURPOSES].sort());
});

test("classification is a separate axis from consent", () => {
  // product_updates is the case that proves it: marketing mail whose consent
  // requirement is decided by the country rule rather than by its class.
  assert.equal(emailPurposeClassification("product_updates"), "marketing");
  assert.ok(CONSENT_REQUIRED_PURPOSES.has("product_updates"));

  // service_status is the opposite corner: switchable, consent-free, and not
  // marketing. Treating "switchable" as "marketing" would put an outage notice
  // behind the marketing kill switch.
  assert.equal(emailPurposeClassification("service_status"), "service");
  assert.ok(!LOCKED_EMAIL_PURPOSES.has("service_status"));
  assert.ok(!CONSENT_REQUIRED_PURPOSES.has("service_status"));
  assert.ok(!isMarketingPurpose("service_status"));
});

test("an unknown purpose has no classification rather than a default", () => {
  assert.equal(emailPurposeClassification("release_notes"), null);
  assert.equal(emailPurposeEntry("release_notes"), null);
  assert.equal(isMarketingPurpose(""), false);
});

test("invariant 5: bulk unsubscribe covers exactly the marketing purposes", () => {
  assert.deepEqual([...BULK_UNSUBSCRIBE_PURPOSES], [...MARKETING_PURPOSES]);
  assert.ok(BULK_UNSUBSCRIBE_PURPOSES.length > 0);
  for (const purpose of BULK_UNSUBSCRIBE_PURPOSES) {
    assert.equal(emailPurposeClassification(purpose), "marketing");
    assert.ok(!LOCKED_EMAIL_PURPOSES.has(purpose));
  }
  // A locked purpose can never be withdrawn in bulk, and a service purpose
  // must not be: one would fail the write, the other would take away an
  // outage notice the account is owed.
  assert.ok(!BULK_UNSUBSCRIBE_PURPOSES.includes("security"));
  assert.ok(!BULK_UNSUBSCRIBE_PURPOSES.includes("billing"));
  assert.ok(!BULK_UNSUBSCRIBE_PURPOSES.includes("service_status"));
});

test("invariant 5: withdrawAllMarketing reads the table, not the consent set", () => {
  const source = readFileSync(
    new URL("../lib/emailPreferences.ts", import.meta.url),
    "utf8"
  );
  const body = source.slice(source.indexOf("export async function withdrawAllMarketing"));
  const loop = body.slice(0, body.indexOf("return results;"));
  assert.ok(
    loop.includes("for (const purpose of BULK_UNSUBSCRIBE_PURPOSES)"),
    "bulk withdrawal must iterate the classification table's list"
  );
  assert.ok(
    !loop.includes("recordsConsent"),
    "bulk withdrawal must not decide its scope from the consent requirement"
  );
});

test("invariant 7: no purpose solicits re-subscription", () => {
  for (const entry of EMAIL_PURPOSE_CLASSIFICATION) {
    assert.equal(
      entry.solicitsResubscription,
      false,
      `${entry.purpose} claims to solicit re-subscription`
    );
  }
});

test("invariant 7: the field is typed false, so adding one is a type change", () => {
  const source = readFileSync(
    new URL("../lib/emailPurposeClassification.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    /readonly solicitsResubscription: false;/.test(source),
    "solicitsResubscription must be the literal false, not boolean"
  );
});

test("the classifications are the three the draft names, in its order", () => {
  assert.deepEqual([...EMAIL_CLASSIFICATIONS], [
    "transactional",
    "service",
    "marketing",
  ]);
});
