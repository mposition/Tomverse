// The send compares a delivery's address with a sealed cohort member's, so the
// two have to be digests from one function.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 5.6 and
// 7.6.
//
// They were not. Members are sealed with `approvalAddressDigest()` (hex SHA-256
// over the normalised address), and the verdict was handed
// `consentAddressDigest()` (a prefixed base64url digest built for consent
// links). Both carried normalisation version `v1`, so the version check passed
// and the bytes never matched: the approved `risk_accepted` cohort was refused on
// every send, and each refusal was recorded as the person revoking permission.
// The unit tests fed both sides the same literal string, so nothing could see it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { approvalAddressDigest } from "../lib/emailSendApprovalCohort.ts";
import { normalizeSuppressionAddress } from "../lib/emailSuppression.ts";
import { consentAddressDigest } from "../lib/emailConsentToken.ts";

const ADDRESS = "  Person.Name+tag@Example.COM ";

test("the digest the send computes is the digest a member was sealed with", () => {
  // The send normalises first and then digests; the seal digests the raw value
  // and normalises inside. The same mailbox has to come out the same either way.
  const sealed = approvalAddressDigest(ADDRESS);
  const atSend = approvalAddressDigest(normalizeSuppressionAddress(ADDRESS));
  assert.equal(atSend, sealed);
});

test("the consent-link digest is a different function, and must not be used here", () => {
  // Kept as a test rather than a comment: this is the substitution that broke
  // the override, and it compiles.
  assert.notEqual(consentAddressDigest(normalizeSuppressionAddress(ADDRESS)), approvalAddressDigest(ADDRESS));
});

test("both writers of a release-notes verdict use the cohort digest", () => {
  for (const file of ["lib/standardEmailLane.ts", "lib/releaseNotesEnqueueDecision.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /deliveryAddressDigest: approvalAddressDigest\(/, file);
    assert.doesNotMatch(source, /consentAddressDigest/, file);
  }
});
