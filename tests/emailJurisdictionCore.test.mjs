import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JURISDICTION_MAPPED_COUNTRY_CODES,
  JURISDICTION_PROFILES,
  MARKETING_ALLOWED_COUNTRY_CODES,
  isMarketingAllowedCountry,
  marketingOptInCountryDecision,
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

test("a later declaration resolves an earlier billing-country conflict", () => {
  const resolved = resolveEmailJurisdiction({
    billingCountry: "SG",
    billingCountryUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    selfDeclaredCountry: "KR",
    selfDeclaredCountryUpdatedAt: new Date("2026-09-14T00:00:00.000Z"),
  });

  // The person has just answered where they live now. A card remaining
  // registered in Singapore does not make that answer ambiguous forever.
  assert.equal(resolved.countryCode, "KR");
  assert.equal(resolved.confidence, "high");
  assert.equal(resolved.source, "self_declared");
  assert.deepEqual(resolved.conflicts, []);
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
  // The EEA non-EU three (NO, IS, LI) are here because the Directive reaches
  // them through the EEA Agreement.
  for (const country of ["DE", "FR", "IE", "PT", "NO", "IS", "LI"]) {
    assert.equal(profileForCountry(country), "EU", `${country} should be EU`);
  }

  // The seven with their own rules keep their own profile.
  for (const country of ["KR", "US", "CA", "AU", "GB", "SG", "CH"]) {
    assert.equal(profileForCountry(country), country);
  }
});

test("Switzerland is not in the EEA profile", () => {
  // It was until 2026-09-14. Its rule is Swiss UWG art. 3(1)(o) rather than the
  // ePrivacy Directive, the revFADP applies with its own supervisory authority,
  // and the transfer analysis is separate -- so the values matching the EU
  // profile is exactly the case where two rows have to exist, or a change
  // justified by one body of law silently moves the other.
  // docs/policy/email-eea-marketing-review-2026-09-14.md section 4.5.
  assert.equal(profileForCountry("CH"), "CH");
  assert.notEqual(profileForCountry("CH"), "EU");
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

test("new marketing consent accepts only an allowlisted country", () => {
  assert.deepEqual(marketingOptInCountryDecision(null), {
    allowed: false,
    reason: "country_required",
  });
  assert.deepEqual(marketingOptInCountryDecision("JP"), {
    allowed: false,
    reason: "country_unsupported",
  });
  assert.deepEqual(marketingOptInCountryDecision("de"), {
    allowed: true,
    countryCode: "DE",
    profileKey: "EU",
  });

  for (const country of MARKETING_ALLOWED_COUNTRY_CODES) {
    assert.equal(marketingOptInCountryDecision(country).allowed, true, country);
  }
});

// Decided 2026-09-15: docs/policy/email-eea-marketing-review-2026-09-14.md §7 condition 7. The list is pinned in full so
// a country cannot be added by editing one constant without this test and the
// review record moving with it.
test("the marketing allowlist is the ten countries with a country-level record", () => {
  assert.deepEqual(
    [...MARKETING_ALLOWED_COUNTRY_CODES].sort(),
    ["AT", "AU", "CA", "CH", "DE", "FR", "GB", "KR", "SG", "US"]
  );
});

test("every allowlisted country has a real profile", () => {
  const mapped = new Set(JURISDICTION_MAPPED_COUNTRY_CODES);
  for (const country of MARKETING_ALLOWED_COUNTRY_CODES) {
    assert.ok(mapped.has(country), country);
    assert.notEqual(profileForCountry(country), "ZZ", country);
  }
});

test("the rendering map still covers all thirty-seven countries", () => {
  // The allowlist narrows marketing only. Transactional and legal mail keep
  // rendering under the EU profile for the twenty-seven EEA states outside it,
  // and the activation runbook's answer sheet counts thirty-seven.
  assert.equal(JURISDICTION_MAPPED_COUNTRY_CODES.length, 37);
  assert.equal(profileForCountry("NL"), "EU");
  const excludedEea = JURISDICTION_MAPPED_COUNTRY_CODES.filter(
    (country) => profileForCountry(country) === "EU" && !isMarketingAllowedCountry(country)
  );
  assert.equal(excludedEea.length, 27);
});

test("a mapped EEA country outside the allowlist is refused at opt-in and at send", () => {
  for (const country of ["NL", "IT", "ES", "IE", "PL", "NO"]) {
    assert.equal(isMarketingAllowedCountry(country), false, country);
    assert.deepEqual(marketingOptInCountryDecision(country), {
      allowed: false,
      reason: "country_unsupported",
    });

    // Consent stored before the list existed resolves through the consent
    // country with high confidence. It is skipped, not grandfathered.
    for (const signals of [
      { selfDeclaredCountry: country },
      { billingCountry: country },
      { consentCountry: country },
    ]) {
      const resolved = resolveEmailJurisdiction(signals);
      assert.equal(resolved.confidence, "high");
      assert.equal(resolved.profileKey, "EU");
      assert.deepEqual(marketingJurisdictionVerdict(resolved), {
        allowed: false,
        skipReason: "marketing_country_not_allowed",
      });
    }
  }
});

test("a declared allowlisted country resolves a conflict with a later billing signal", () => {
  const resolved = resolveEmailJurisdiction({
    billingCountry: "NL",
    billingCountryUpdatedAt: new Date("2026-09-01T00:00:00Z"),
    selfDeclaredCountry: "DE",
    selfDeclaredCountryUpdatedAt: new Date("2026-09-15T00:00:00Z"),
  });
  assert.deepEqual(marketingJurisdictionVerdict(resolved), { allowed: true });

  const stale = resolveEmailJurisdiction({
    billingCountry: "NL",
    billingCountryUpdatedAt: new Date("2026-09-16T00:00:00Z"),
    selfDeclaredCountry: "DE",
    selfDeclaredCountryUpdatedAt: new Date("2026-09-15T00:00:00Z"),
  });
  assert.equal(marketingJurisdictionVerdict(stale).allowed, false);

  // The same instant says nothing about which came second, so two different
  // countries stamped together remain a conflict rather than the declaration.
  const simultaneous = resolveEmailJurisdiction({
    billingCountry: "NL",
    billingCountryUpdatedAt: new Date("2026-09-15T00:00:00Z"),
    selfDeclaredCountry: "DE",
    selfDeclaredCountryUpdatedAt: new Date("2026-09-15T00:00:00Z"),
  });
  assert.deepEqual(marketingJurisdictionVerdict(simultaneous), {
    allowed: false,
    skipReason: "jurisdiction_conflict",
  });
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

  const unsupported = resolveEmailJurisdiction({
    selfDeclaredCountry: "JP",
  });
  assert.equal(unsupported.confidence, "high");
  assert.deepEqual(marketingJurisdictionVerdict(unsupported), {
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
    { selfDeclaredCountry: "JP" },
    { selfDeclaredCountry: "NL" },
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
