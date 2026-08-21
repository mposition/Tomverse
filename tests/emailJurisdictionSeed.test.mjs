import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOOTER_BLOCKS,
  JURISDICTION_POLICY_SEED_VERSION,
  JURISDICTION_PROFILE_SEED,
  jurisdictionCountryMapSeed,
  jurisdictionSeedProblems,
} from "../lib/emailJurisdictionSeed.ts";
import {
  JURISDICTION_PROFILES,
  profileForCountry,
} from "../lib/emailJurisdictionCore.ts";

// The seeded jurisdiction profiles.
// Contract: docs/policy/email-notifications.md §5.2, §8.7, §12.5.

test("the seed is usable as written", () => {
  assert.deepEqual(jurisdictionSeedProblems(), []);
});

test("every profile the resolver can return has a row", () => {
  // profileForCountry() returns one of these eight and nothing else. A profile
  // it can name with no row behind it is a send with no labelling rules at
  // all, which fails at render time rather than at review time.
  const seeded = JURISDICTION_PROFILE_SEED.map((profile) => profile.profileKey);
  assert.deepEqual([...seeded].sort(), [...JURISDICTION_PROFILES].sort());
});

test("the country map agrees with the resolver, country by country", () => {
  // These are the two halves of one decision: the map is what an operator will
  // edit, profileForCountry is what decides today. Seeding them from one
  // function is what stops a footer describing one jurisdiction while the send
  // decision was made under another.
  for (const row of jurisdictionCountryMapSeed()) {
    assert.equal(
      profileForCountry(row.countryCode),
      row.profileKey,
      `${row.countryCode} maps to ${row.profileKey} but resolves to ${profileForCountry(row.countryCode)}`
    );
  }
});

test("no country is mapped to the fallback", () => {
  // ZZ is reached by absence. A row saying ZZ would read as a finding about
  // that country rather than the absence of one, and the map would then have
  // to claim to enumerate every country there is.
  for (const row of jurisdictionCountryMapSeed()) {
    assert.notEqual(row.profileKey, "ZZ");
  }
});

test("a country appears at most once", () => {
  const seen = new Set();
  for (const row of jurisdictionCountryMapSeed()) {
    assert.equal(seen.has(row.countryCode), false, `${row.countryCode} twice`);
    seen.add(row.countryCode);
  }
});

test("the two subject prefixes are the two the contract names", () => {
  // E1 and E2. Every other jurisdiction surveyed requires none, and inventing
  // one would put an advertising label on mail no law asked to label.
  const prefixed = Object.fromEntries(
    JURISDICTION_PROFILE_SEED.filter((profile) => profile.subjectPrefix).map(
      (profile) => [profile.profileKey, profile.subjectPrefix]
    )
  );
  assert.deepEqual(prefixed, { KR: "(광고)", SG: "<ADV> " });
});

test("no unsubscribe SLA is longer than the shortest statutory deadline", () => {
  // C3: Australia's five business days is the shortest of any jurisdiction
  // surveyed, so it is the ceiling everywhere. A profile quoting ten days
  // would be quoting a promise we would break in Australia -- the copy has to
  // describe what actually happens, and what happens is the same everywhere.
  for (const profile of JURISDICTION_PROFILE_SEED) {
    if (profile.profileKey === "US" || profile.profileKey === "CA" || profile.profileKey === "SG") {
      // The three that quote their own statutory ten days. Quoting a longer
      // deadline than we honour is allowed; quoting a shorter one is not.
      assert.equal(profile.unsubscribeSlaBusinessDays, 10);
      continue;
    }
    assert.ok(
      profile.unsubscribeSlaBusinessDays <= 5,
      `${profile.profileKey} quotes ${profile.unsubscribeSlaBusinessDays} business days`
    );
  }
});

test("only Korea carries a consent notice interval, and it is a notice", () => {
  // §5.5. The interval is how often the recipient must be *told*, not how long
  // the consent lasts -- a person who never answers keeps their consent.
  const intervals = JURISDICTION_PROFILE_SEED.filter(
    (profile) => profile.consentNoticeIntervalMonths !== null
  );
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].profileKey, "KR");
  assert.equal(intervals[0].consentNoticeIntervalMonths, 24);
});

test("only Korea suppresses at night, and the window names its own zone", () => {
  const quiet = JURISDICTION_PROFILE_SEED.filter((profile) => profile.quietHours);
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].profileKey, "KR");
  // Without a zone the window would be evaluated in whatever the server
  // happens to be set to, which is nobody's night.
  assert.equal(quiet[0].quietHours.tz, "Asia/Seoul");
});

test("Canada records the implied-consent windows it does not use", () => {
  // E6. The field describes CASL truthfully; C8 declines implied consent
  // everywhere, so nothing reads it. A profile that omitted it would be
  // describing us rather than the jurisdiction.
  const canada = JURISDICTION_PROFILE_SEED.find((p) => p.profileKey === "CA");
  assert.deepEqual(canada.impliedConsentDays, { transaction: 730, enquiry: 183 });
  for (const profile of JURISDICTION_PROFILE_SEED) {
    if (profile.profileKey !== "CA") assert.equal(profile.impliedConsentDays, null);
  }
});

test("the American and Australian footers carry what their statutes require", () => {
  const us = JURISDICTION_PROFILE_SEED.find((p) => p.profileKey === "US");
  // 15 U.S.C. 7704(a)(5)(A)(iii).
  assert.ok(us.footerBlocks.includes("postal_address"));
  const au = JURISDICTION_PROFILE_SEED.find((p) => p.profileKey === "AU");
  // Spam Act s. 17: the sender has to be identifiable, and an ABN is how.
  assert.ok(au.footerBlocks.includes("abn"));
  const kr = JURISDICTION_PROFILE_SEED.find((p) => p.profileKey === "KR");
  assert.ok(kr.footerBlocks.includes("business_registration"));
  assert.ok(kr.footerBlocks.includes("mail_order_registration"));
});

test("every footer block named is one the renderer knows", () => {
  for (const profile of JURISDICTION_PROFILE_SEED) {
    for (const block of profile.footerBlocks) {
      assert.ok(FOOTER_BLOCKS.includes(block), `${block} is not a footer block`);
    }
  }
});

test("every profile says what its values are based on", () => {
  // §12.5 requires the sources beside the fields, because an operator changing
  // a value cannot judge the change without them.
  for (const profile of JURISDICTION_PROFILE_SEED) {
    assert.ok(profile.notes.trim().length > 80, `${profile.profileKey} notes too thin`);
  }
});

test("the seed version is a fixed string", () => {
  // It is the idempotency key of the draft: two calls must not produce two
  // versions, and a version derived from the clock would.
  assert.match(JURISDICTION_POLICY_SEED_VERSION, /^\d{4}-\d{2}-\d{2}\./);
});
