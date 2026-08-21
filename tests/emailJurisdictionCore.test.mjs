import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JURISDICTION_PROFILES,
  marketingJurisdictionVerdict,
  needsCountryConfirmation,
  profileForCountry,
  resolveEmailJurisdiction,
} from "../lib/emailJurisdictionCore.ts";

// Jurisdiction resolution. Contract: docs/policy/email-notifications.md §6.

test("the payment method outranks the profile field when both agree", () => {
  const resolved = resolveEmailJurisdiction({
    billingCountry: "KR",
    selfDeclaredCountry: "kr",
    ipCountry: "US",
  });

  assert.equal(resolved.countryCode, "KR");
  assert.equal(resolved.confidence, "high");
  assert.equal(resolved.source, "billing");
  assert.deepEqual(resolved.conflicts, []);
});

test("high-confidence signals that disagree are held, not ordered", () => {
  const resolved = resolveEmailJurisdiction({
    billingCountry: "KR",
    selfDeclaredCountry: "SG",
  });

  // Korea wants a "(광고)" prefix and Singapore wants "<ADV>". Applying both
  // produces a third string that satisfies neither, so there is nothing to
  // pick and the answer is to ask.
  assert.equal(resolved.confidence, "conflict");
  assert.equal(resolved.source, "conflict");
  assert.deepEqual(resolved.conflicts.sort(), ["KR", "SG"]);
  assert.equal(resolved.countryCode, "ZZ");
});

test("IP is recorded and never decides", () => {
  const fromIpOnly = resolveEmailJurisdiction({ ipCountry: "US" });
  assert.equal(fromIpOnly.confidence, "unknown");
  assert.equal(fromIpOnly.countryCode, "ZZ");
  // A Korean resident reading mail from a hotel in Chicago has not left the
  // reach of the Network Act.
  assert.equal(fromIpOnly.observedIpCountry, "US");

  const travelling = resolveEmailJurisdiction({
    selfDeclaredCountry: "KR",
    ipCountry: "US",
  });
  assert.equal(travelling.countryCode, "KR");
  assert.equal(travelling.observedIpCountry, "US");
});

test("what was true when they consented carries when nothing else is known", () => {
  const resolved = resolveEmailJurisdiction({ consentCountry: "DE" });
  assert.equal(resolved.confidence, "high");
  assert.equal(resolved.source, "consent");
  assert.equal(resolved.profileKey, "EU");
});

test("language and time zone together are circumstantial, never authorising", () => {
  const inferred = resolveEmailJurisdiction({
    language: "ko",
    timeZone: "Asia/Seoul",
  });
  assert.equal(inferred.countryCode, "KR");
  assert.equal(inferred.confidence, "low");

  // Either alone establishes nothing: a language is spoken in many places and
  // a time zone is a setting people carry with them.
  assert.equal(
    resolveEmailJurisdiction({ language: "ko" }).confidence,
    "unknown"
  );
  assert.equal(
    resolveEmailJurisdiction({ timeZone: "Asia/Seoul" }).confidence,
    "unknown"
  );
  // A pair that does not match a known combination is not forced into one.
  assert.equal(
    resolveEmailJurisdiction({ language: "ko", timeZone: "Europe/Paris" })
      .confidence,
    "unknown"
  );
});

test("thirty EEA countries map onto one profile", () => {
  for (const country of ["DE", "FR", "IE", "PT", "NO", "IS", "LI", "CH"]) {
    assert.equal(profileForCountry(country), "EU", `${country} should be EU`);
  }

  // The six with their own rules keep their own profile.
  for (const country of ["KR", "US", "CA", "AU", "GB", "SG"]) {
    assert.equal(profileForCountry(country), country);
  }
});

test("a country with no profile falls back rather than guessing", () => {
  // ZZ carries the business identity footer and no advertising rule, which is
  // safe for transactional mail and not used for marketing at all.
  for (const country of ["JP", "CN", "BR", "ZA", null, "", "nonsense"]) {
    assert.equal(profileForCountry(country), "ZZ");
  }

  for (const profile of JURISDICTION_PROFILES) {
    assert.equal(typeof profile, "string");
  }
});

test("only a confirmed jurisdiction lets marketing go out", () => {
  const confirmed = resolveEmailJurisdiction({ selfDeclaredCountry: "KR" });
  assert.deepEqual(marketingJurisdictionVerdict(confirmed), { allowed: true });

  const conflicted = resolveEmailJurisdiction({
    billingCountry: "KR",
    selfDeclaredCountry: "SG",
  });
  assert.deepEqual(marketingJurisdictionVerdict(conflicted), {
    allowed: false,
    skipReason: "jurisdiction_conflict",
  });

  const nothing = resolveEmailJurisdiction({});
  assert.deepEqual(marketingJurisdictionVerdict(nothing), {
    allowed: false,
    skipReason: "jurisdiction_unconfirmed",
  });
});

test("an inferred country produces a footer but never authorises advertising", () => {
  const inferred = resolveEmailJurisdiction({
    language: "de",
    timeZone: "Europe/Berlin",
  });

  // It is good enough to render a better footer than ZZ with...
  assert.equal(inferred.profileKey, "EU");
  // ...and not good enough to send advertising under a guessed set of
  // labelling rules.
  assert.deepEqual(marketingJurisdictionVerdict(inferred), {
    allowed: false,
    skipReason: "jurisdiction_unconfirmed",
  });
});

test("the preference centre asks whenever marketing could not send", () => {
  // The two answers have to agree, or somebody is held back without being
  // asked, and finds out by not receiving something.
  for (const signals of [
    {},
    { language: "ko", timeZone: "Asia/Seoul" },
    { billingCountry: "KR", selfDeclaredCountry: "SG" },
  ]) {
    const resolved = resolveEmailJurisdiction(signals);
    assert.equal(
      needsCountryConfirmation(resolved),
      !marketingJurisdictionVerdict(resolved).allowed
    );
  }

  assert.equal(
    needsCountryConfirmation(resolveEmailJurisdiction({ billingCountry: "US" })),
    false
  );
});
