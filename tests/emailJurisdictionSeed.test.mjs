import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

/**
 * The seeded profiles as they stood when JURISDICTION_POLICY_SEED_VERSION was
 * last moved. Recorded, not computed: a digest the test derives from whatever
 * it is handed proves only that sha256 is deterministic.
 */
const SEEDED_BEHAVIOUR_DIGEST = "8e96166a83c803db";

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

test("no profile suppresses at night, because no profile's law asks email to", () => {
  // Q4, resolved 2026-09-16: the Network Act's night-time restriction (제50조
  // 제3항) applies to media prescribed by decree, and 시행령 제61조제2항
  // excludes electronic mail. Korea carried the window while that was
  // unconfirmed; it does not carry it now.
  //
  // The lane keeps the mechanism, so a profile that ever needs a window sets
  // one and a new policy version carries it. What this asserts is that no
  // window is claimed without a rule behind it: a held message nobody can
  // explain is the failure this replaces.
  assert.deepEqual(
    JURISDICTION_PROFILE_SEED.filter((profile) => profile.quietHours).map(
      (profile) => profile.profileKey
    ),
    []
  );
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
  // 시행령 별표 6이 요구하는 것은 명칭·연락처·수신거부 방법입니다. 등록번호
  // 두 개는 전자상거래법상 통신판매업자의 표시 의무에서 온 것이고, 발송 주체가
  // 한국 통신판매업 신고 대상이 아니어서 존재하지 않습니다(2026-09-14). 값을
  // 가질 수 없는 block을 이름 대면 renderer가 footer 전체를 버려 한국 수신자
  // marketing이 영구히 거부되므로, 되살리는 것은 신고 번호가 생긴 뒤입니다.
  assert.ok(!kr.footerBlocks.includes("business_registration"));
  assert.ok(!kr.footerBlocks.includes("mail_order_registration"));
  assert.ok(kr.footerBlocks.includes("legal_name"));
  assert.ok(kr.footerBlocks.includes("contact_email"));
  // 제거된 것은 E3의 값 집합뿐입니다. 제50조가 요구하는 나머지는 그대로입니다.
  assert.equal(kr.subjectPrefix, "(광고)");
  assert.equal(kr.consentNoticeIntervalMonths, 24);
  assert.equal(kr.quietHours, null);
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

test("a profile change moves the seed version with it", () => {
  // The defect this fixes, found 2026-09-15: KR's footerBlocks and the new CH
  // profile were edited and deployed while the version string stayed at
  // 2026-08-21.jurisdictions.1. ensureJurisdictionPolicyDraft() is idempotent
  // by that string, so the row the send path reads never learned about either
  // change -- the tree said one thing and the mailbox got another.
  //
  // notes are excluded on purpose. They are stored on the row and §12.5 wants
  // them there, but they change nothing a recipient receives, and a guard that
  // fires on a typo fix is one people learn to bump past without reading.
  const behaviour = JURISDICTION_PROFILE_SEED.map((profile) => [
    profile.profileKey,
    profile.marketingBasis,
    profile.subjectPrefix,
    profile.footerBlocks,
    profile.unsubscribeSlaBusinessDays,
    profile.consentNoticeIntervalMonths,
    profile.quietHours ?? null,
    profile.impliedConsentDays ?? null,
  ]);
  const countries = jurisdictionCountryMapSeed().map((row) => [
    row.countryCode,
    row.profileKey,
  ]);
  const digest = createHash("sha256")
    .update(JSON.stringify({ behaviour, countries }))
    .digest("hex")
    .slice(0, 16);

  assert.equal(
    digest,
    SEEDED_BEHAVIOUR_DIGEST,
    "The seeded profiles changed. Bump JURISDICTION_POLICY_SEED_VERSION, say " +
      "what moved in JURISDICTION_POLICY_SEED_SUMMARY, and record the new " +
      `digest here as "${digest}". Without the bump the change reaches no ` +
      "delivery, because the policy version row is never edited in place."
  );
});
