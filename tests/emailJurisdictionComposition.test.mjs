import assert from "node:assert/strict";
import test from "node:test";

import { composeJurisdictionalMessage } from "../lib/emailJurisdictionComposition.ts";
import { FOOTER_LANGUAGES } from "../lib/emailFooterRenderer.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";

// The step between the template rendering and the provider being called.
//
// Contract: docs/policy/email-notifications.md §5.2 E1-E3, §8.5, §8.6.
//
// EM-04: renderJurisdictionFooter() was called from nothing but its own test,
// and subjectPrefix was read by the seed and the policy reader and by nothing
// that sends. A Korean recipient's marketing mail would have arrived with no
// (광고) in its subject, which 정보통신망법 제50조제4항 requires and which
// cannot be taken back once the message has landed.
//
// What must hold:
//
//  - the advertising label goes on advertising and on nothing else. A receipt
//    prefixed (광고) is a false statement about what the message is;
//  - a marketing message that cannot be labelled is not sent. A transactional
//    one whose identity footer cannot be built is sent, loudly, because
//    holding an account-deletion notice for an unset variable is worse;
//  - an unsubscribe block never reaches a message with no unsubscribe link;
//  - every seeded profile renders in every supported language.

const IDENTITY = {
  legalName: "Tomverse Pty Ltd",
  postalAddress: "1 Example Street, Brisbane QLD 4000, Australia",
  contactEmail: "support@tomverse.app",
  businessRegistrationNumber: "000-00-00000",
  mailOrderRegistrationNumber: "2026-Seoul-00000",
  abn: "00 000 000 000",
};

const profileFor = (key) => {
  const seeded = JURISDICTION_PROFILE_SEED.find((row) => row.profileKey === key);
  assert.ok(seeded, `no seeded profile for ${key}`);
  return {
    profileKey: seeded.profileKey,
    subjectPrefix: seeded.subjectPrefix,
    footerBlocks: seeded.footerBlocks,
    unsubscribeSlaBusinessDays: seeded.unsubscribeSlaBusinessDays,
  };
};

const rendered = (subject = "Your weekly digest") => ({
  subject,
  html: "<p>Body</p>",
  text: "Body",
});

const compose = (overrides = {}) =>
  composeJurisdictionalMessage({
    classification: "marketing",
    requiresUnsubscribe: true,
    profile: profileFor("KR"),
    identity: IDENTITY,
    language: "ko",
    unsubscribeUrl: "https://tomverse.app/unsubscribe?t=token",
    rendered: rendered(),
    ...overrides,
  });

test("a Korean marketing subject starts with the advertising label", () => {
  const result = compose();
  assert.equal(result.ok, true);
  assert.equal(result.appliedPrefix, true);
  assert.ok(result.rendered.subject.startsWith("(광고)"));
});

test("the same template to a US recipient is not labelled", () => {
  const result = compose({ profile: profileFor("US"), language: "en" });
  assert.equal(result.ok, true);
  assert.equal(result.appliedPrefix, false);
  assert.equal(result.rendered.subject, "Your weekly digest");
});

test("Singapore's prefix keeps the space the statute's wording needs", () => {
  const result = compose({ profile: profileFor("SG"), language: "en" });
  assert.equal(result.ok, true);
  assert.ok(result.rendered.subject.startsWith("<ADV> "));
});

test("transactional mail is never labelled, in any jurisdiction", () => {
  for (const seeded of JURISDICTION_PROFILE_SEED) {
    for (const classification of ["transactional", "legal", "service"]) {
      const result = compose({
        classification,
        requiresUnsubscribe: false,
        profile: profileFor(seeded.profileKey),
      });
      assert.equal(result.ok, true, `${seeded.profileKey}/${classification} refused`);
      assert.equal(
        result.appliedPrefix,
        false,
        `${seeded.profileKey}/${classification} was labelled`
      );
      assert.equal(result.rendered.subject, "Your weekly digest");
    }
  }
});

test("a subject that already carries the prefix does not get a second one", () => {
  const result = compose({ rendered: rendered("(광고)Already labelled") });
  assert.equal(result.ok, true);
  assert.equal(result.appliedPrefix, false);
  assert.equal(result.rendered.subject, "(광고)Already labelled");
});

test("a message with no unsubscribe link carries no unsubscribe block", () => {
  const result = compose({
    classification: "transactional",
    requiresUnsubscribe: false,
    unsubscribeUrl: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.appliedFooter, true);
  // The identity is still there -- ZZ and KR alike carry it for transactional
  // mail. What is absent is the link and the reason line.
  assert.ok(result.rendered.text.includes("Tomverse Pty Ltd"));
  assert.doesNotMatch(result.rendered.text, /unsubscribe\?t=/);
});

test("marketing keeps the unsubscribe block and the SLA wording", () => {
  const result = compose({ profile: profileFor("AU"), language: "en" });
  assert.equal(result.ok, true);
  assert.ok(result.rendered.text.includes("unsubscribe?t=token"));
  assert.ok(result.rendered.html.includes("unsubscribe?t=token"));
});

test("marketing is refused when the pinned policy has no profile for the key", () => {
  const result = compose({ profile: null });
  assert.equal(result.ok, false);
  assert.equal(result.skipReason, "jurisdiction_profile_missing");
});

test("transactional still sends when the pinned policy has no profile", () => {
  const result = compose({
    classification: "transactional",
    requiresUnsubscribe: false,
    profile: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.appliedFooter, false);
  assert.deepEqual(result.degraded, ["profile_missing"]);
  assert.equal(result.rendered.html, "<p>Body</p>");
});

test("marketing is refused when a required identity value is unset", () => {
  const result = compose({
    identity: { ...IDENTITY, businessRegistrationNumber: null },
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipReason, "jurisdiction_footer_incomplete");
  assert.deepEqual(result.missing, ["business_registration"]);
});

test("transactional degrades rather than being held for the same gap", () => {
  const result = compose({
    classification: "transactional",
    requiresUnsubscribe: false,
    identity: { ...IDENTITY, legalName: null, postalAddress: null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.appliedFooter, false);
  assert.equal(result.degraded.length, 1);
  // Named, so an operator learns every missing value at once rather than one
  // per deploy.
  assert.match(result.degraded[0], /legal_name/);
  assert.match(result.degraded[0], /postal_address/);
});

test("marketing is refused when its unsubscribe link is missing", () => {
  const result = compose({ unsubscribeUrl: null });
  assert.equal(result.ok, false);
  assert.equal(result.skipReason, "jurisdiction_footer_incomplete");
  assert.ok(result.missing.includes("unsubscribe_link"));
});

test("every seeded profile renders in every supported language", () => {
  assert.equal(JURISDICTION_PROFILE_SEED.length, 8);
  assert.equal(FOOTER_LANGUAGES.length, 7);
  for (const seeded of JURISDICTION_PROFILE_SEED) {
    for (const language of FOOTER_LANGUAGES) {
      const result = compose({
        profile: profileFor(seeded.profileKey),
        language,
      });
      assert.equal(
        result.ok,
        true,
        `${seeded.profileKey}/${language}: ${result.ok === false ? result.missing.join(",") : ""}`
      );
      assert.equal(result.appliedFooter, true);
      assert.ok(result.rendered.text.includes(IDENTITY.legalName));
      assert.equal(
        result.appliedPrefix,
        Boolean(seeded.subjectPrefix),
        `${seeded.profileKey}/${language} disagreed about the label`
      );
    }
  }
});

test("the body is left alone; the footer is appended after it", () => {
  const result = compose({ profile: profileFor("US"), language: "en" });
  assert.equal(result.ok, true);
  assert.ok(result.rendered.html.startsWith("<p>Body</p>"));
  assert.ok(result.rendered.text.startsWith("Body\n\n--\n"));
});

test("composing twice produces the same bytes", () => {
  // Every retry re-renders and re-composes from the stored snapshot. If this
  // were false the provider would stop suppressing the duplicate.
  assert.deepEqual(compose(), compose());
});
