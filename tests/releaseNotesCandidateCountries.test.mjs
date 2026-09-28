// Which countries a release-notes verdict is taken over.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.3, and
// `marketingJurisdictionVerdict()` in lib/emailJurisdictionCore.ts, which is the
// rule actually in force.
//
// Section 5.3 describes a *list* of candidates whose display obligations compose
// as a union -- and says in the same paragraph that this needs the S0 amendment
// to email-notifications.md sections 6.1 and 6.2 and to AGENTS.md, all three of
// which say IP alone does not decide a jurisdiction. That amendment has not been
// made, so the list is not the rule yet.
//
// This file exists because the list was implemented first and an independent
// review found what it cost. It imports the real function rather than restating
// it: a test that pins a copy of a rule passes for ever after the rule moves,
// which is the failure this repository keeps meeting.

import assert from "node:assert/strict";
import test from "node:test";

import { marketingJurisdictionVerdict } from "../lib/emailJurisdictionCore.ts";
import { candidateCountries } from "../lib/releaseNotesSendAuthorization.ts";

const resolved = (overrides) => ({
  countryCode: "KR",
  profileKey: "KR",
  confidence: "high",
  source: "billing",
  conflicts: [],
  ...overrides,
});

test("a high-confidence country is the one candidate", () => {
  assert.deepEqual(candidateCountries(resolved()), ["KR"]);
});

test("a conflict is no candidate at all", () => {
  // The defect this pins. A conflict resolves to `ZZ`, which is what the
  // delivery row pins and what the send renders from -- while a union contract
  // would have been composed from the two conflicting countries. The verdict
  // would approve a footer with a Korean telephone number and the message would
  // print ZZ's, which has none, and record it as satisfied.
  assert.deepEqual(
    candidateCountries(
      resolved({ countryCode: "ZZ", profileKey: "ZZ", confidence: "conflict", conflicts: ["KR", "SG"] })
    ),
    []
  );
});

test("a low-confidence inference is no candidate", () => {
  // Language plus time zone, with no billing country, no declaration and no
  // consent-time country. The ordinary marketing path refuses it; accepting it
  // here would have sent release notes under Korean rules on the strength of a
  // browser's locale.
  assert.deepEqual(candidateCountries(resolved({ confidence: "low", source: "inferred" })), []);
  assert.deepEqual(candidateCountries(resolved({ confidence: "unknown" })), []);
  assert.deepEqual(candidateCountries(resolved({ confidence: "none" })), []);
});

test("ZZ is no candidate even at high confidence", () => {
  assert.deepEqual(candidateCountries(resolved({ countryCode: "ZZ", profileKey: "ZZ" })), []);
});

test("the two gates agree on every case", () => {
  // The property that matters: wherever the ordinary marketing path would refuse
  // for a jurisdiction reason, the release-notes verdict has no candidate and
  // refuses as `country_undetermined`. A case where one allows and the other
  // does not is the exemption having changed what goes out rather than which
  // word it is recorded under.
  //
  // `marketing_country_not_allowed` is the one asymmetry, and it is the
  // marketing path's own list rather than a jurisdiction question: a country
  // that resolves confidently but is not in `MARKETING_ALLOWED_COUNTRIES` has a
  // candidate here and is refused by its own country rule -- `no_country_rule`
  // -- rather than by having no candidate.
  const cases = [
    resolved(),
    resolved({ countryCode: "US", profileKey: "US" }),
    resolved({ confidence: "low" }),
    resolved({ confidence: "unknown" }),
    resolved({ countryCode: "ZZ", profileKey: "ZZ", confidence: "conflict", conflicts: ["KR", "US"] }),
    resolved({ countryCode: "ZZ", profileKey: "ZZ", confidence: "unknown" }),
    resolved({ countryCode: "JP", profileKey: "JP" }),
  ];
  for (const jurisdiction of cases) {
    const marketing = marketingJurisdictionVerdict(jurisdiction);
    const candidates = candidateCountries(jurisdiction);
    if (candidates.length === 0) {
      assert.equal(
        marketing.allowed,
        false,
        `${jurisdiction.countryCode}/${jurisdiction.confidence}: no candidate but marketing allows`
      );
      continue;
    }
    assert.ok(
      marketing.allowed || marketing.skipReason === "marketing_country_not_allowed",
      `${jurisdiction.countryCode}/${jurisdiction.confidence}: a candidate where marketing refuses for a jurisdiction reason`
    );
  }
});
