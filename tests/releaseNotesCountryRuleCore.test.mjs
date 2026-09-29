import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  MARKETING_ALLOWED_COUNTRY_CODES,
  JURISDICTION_MAPPED_COUNTRY_CODES,
} from "../lib/emailJurisdictionCore.ts";
import {
  auSenderAuthority,
  recipientAuthority,
  releaseNotesAuthorityVerdict,
  releaseNotesCountryRuleSeed,
  releaseNotesRuleKey,
  releaseNotesRuleSeedProblems,
} from "../lib/releaseNotesCountryRuleCore.ts";

// The recipient-authority rules and the verdict over them.
// Contract: docs/policy/email-notifications.md section 5.1.1; draft sections
// 4.1-4.3 and 7.6.

/**
 * The seeded rules as they stood when JURISDICTION_POLICY_SEED_VERSION was last
 * moved. Recorded, not computed: see the profile digest in
 * tests/emailJurisdictionSeed.test.mjs for why.
 */
const SEEDED_RULE_DIGEST = "471ac4504bfde4e6";

const ruleFor = (countryCode) => {
  const seed = releaseNotesCountryRuleSeed().find((row) => row.countryCode === countryCode);
  if (!seed) return null;
  return {
    countryCode,
    ruleKey: releaseNotesRuleKey(countryCode),
    ruleVersion: seed.ruleVersion,
    basis: seed.basis,
    status: seed.status,
  };
};

const noConsent = { express: false, evidenceIds: [] };
const consent = { express: true, evidenceIds: ["cr_1"] };

test("the seed is usable as written", () => {
  assert.deepEqual(releaseNotesRuleSeedProblems(), []);
});

test("every mapped country has exactly one rule", () => {
  const countries = releaseNotesCountryRuleSeed().map((row) => row.countryCode);
  assert.deepEqual([...countries].sort(), [...JURISDICTION_MAPPED_COUNTRY_CODES].sort());
  assert.equal(new Set(countries).size, countries.length);
});

test("the open rules are exactly today's allowlist", () => {
  // Section 4.1 moves the allowlist into the rule's status. Until S9's verdict
  // reads the rows, MARKETING_ALLOWED_COUNTRY_CODES is still the live gate; the
  // two must not disagree while both exist.
  const open = releaseNotesCountryRuleSeed()
    .filter((row) => row.status === "open")
    .map((row) => row.countryCode);
  assert.deepEqual([...open].sort(), [...MARKETING_ALLOWED_COUNTRY_CODES].sort());
});

test("the bases are section 5.1.1's starting values", () => {
  const basis = Object.fromEntries(
    releaseNotesCountryRuleSeed().map((row) => [row.countryCode, row.basis])
  );
  assert.equal(basis.US, "opt_out");
  assert.equal(basis.AU, "inferred_consent");
  for (const country of ["SG", "KR", "GB", "DE", "FR", "AT", "IE", "CH", "CA", "IT", "NL"]) {
    assert.equal(basis[country], "express_consent", country);
  }
  // Only US and AU differ from express consent.
  assert.deepEqual(
    Object.entries(basis)
      .filter(([, value]) => value !== "express_consent")
      .map(([country]) => country)
      .sort(),
    ["AU", "US"]
  );
});

test("no seeded rule has moved without a version bump", () => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        releaseNotesCountryRuleSeed().map((row) => [
          row.countryCode,
          row.ruleVersion,
          row.basis,
          row.status,
          row.releaseConditions,
          row.activationGates,
        ])
      )
    )
    .digest("hex")
    .slice(0, 16);
  assert.equal(
    digest,
    SEEDED_RULE_DIGEST,
    "The seeded country rules changed. Bump the rule's ruleVersion (the table refuses " +
      "one version naming two contents), bump JURISDICTION_POLICY_SEED_VERSION, and " +
      `record the new digest here as "${digest}".`
  );
});

test("Australia's conditions are the contract's column and approval C's gates, apart", () => {
  // The field said it was section 5.1.1's third column and held approval C's
  // prerequisites instead, which are a different question: one is what would
  // release the country, the other is what must exist before the approved
  // basis may be acted on at all.
  const au = releaseNotesCountryRuleSeed().find((row) => row.countryCode === "AU");
  assert.deepEqual(au.releaseConditions, [
    "relationship_start_event",
    "relationship_kept_alive",
    "relationship_end_event",
    "dormant_and_free_accounts",
    "related_content_scope",
    "immediate_switch_on_end",
  ]);
  assert.deepEqual(au.activationGates, [
    "relationship_model_built",
    "policy_amendment_e_in_force",
  ]);

  // Only the basis a gate holds back carries one.
  for (const rule of releaseNotesCountryRuleSeed()) {
    assert.equal(
      rule.activationGates.length > 0,
      rule.basis === "inferred_consent",
      rule.countryCode
    );
  }
});

test("an express consent with no evidence is a caller error, not a refusal", () => {
  // `legalAllowed: true` with nothing to cite is the shape of a consent nobody
  // can prove, and the ledger's contract is that a verdict names the rows it
  // rested on. Loud rather than silent: a caller that has the consent and
  // forgot its ids would otherwise read an ordinary refusal.
  const empty = { express: true, evidenceIds: [] };
  assert.throws(
    () => recipientAuthority({ country: "KR", rule: ruleFor("KR"), consent: empty }),
    /must name the ConsentRecord ids/
  );
  assert.throws(() => auSenderAuthority({ consent: empty }), /must name the ConsentRecord ids/);
  assert.throws(
    () => releaseNotesAuthorityVerdict({ countries: ["KR"], rules: [ruleFor("KR")], consent: empty }),
    /must name the ConsentRecord ids/
  );

  // And evidence without a consent is the same kind of mistake.
  assert.throws(
    () => auSenderAuthority({ consent: { express: false, evidenceIds: ["cr_1"] } }),
    /not given/
  );
});

test("the rule key names its own country", () => {
  assert.equal(releaseNotesRuleKey("KR"), "release_notes.KR");
});

// --- the recipient authority ---------------------------------------------

test("an undetermined country, a missing rule and a closed rule are refused", () => {
  assert.equal(recipientAuthority({ country: null, rule: null, consent }).reason, "country_undetermined");
  assert.equal(recipientAuthority({ country: "ZZ", rule: null, consent }).reason, "country_undetermined");
  assert.equal(recipientAuthority({ country: "JP", rule: null, consent }).reason, "no_country_rule");
  const italy = recipientAuthority({ country: "IT", rule: ruleFor("IT"), consent });
  assert.equal(italy.verdict, "deny");
  assert.equal(italy.reason, "country_closed");
  // A closed rule is refused even with consent: the allowlist is not a basis.
});

test("opt_out allows without consent; express consent needs it", () => {
  const us = recipientAuthority({ country: "US", rule: ruleFor("US"), consent: noConsent });
  assert.equal(us.verdict, "allow");
  assert.equal(us.basis, "opt_out");

  const kr = recipientAuthority({ country: "KR", rule: ruleFor("KR"), consent: noConsent });
  assert.equal(kr.verdict, "deny");
  assert.equal(kr.reason, "no_express_consent");

  const krConsented = recipientAuthority({ country: "KR", rule: ruleFor("KR"), consent });
  assert.equal(krConsented.verdict, "allow");
  assert.equal(krConsented.basis, "express_consent");
  assert.deepEqual(krConsented.evidenceIds, ["cr_1"]);
});

test("Australian inferred consent is not relied on until it is in effect", () => {
  const au = recipientAuthority({ country: "AU", rule: ruleFor("AU"), consent: noConsent });
  assert.equal(au.verdict, "deny");
  assert.equal(au.reason, "inferred_consent_not_in_effect");
  assert.equal(au.basis, "inferred_consent");

  // Express consent is the stronger basis and satisfies the rule regardless,
  // and the verdict records the basis it actually rested on.
  const auConsented = recipientAuthority({ country: "AU", rule: ruleFor("AU"), consent });
  assert.equal(auConsented.verdict, "allow");
  assert.equal(auConsented.basis, "express_consent");
});

test("a rule passed for another country is a caller error", () => {
  assert.throws(() => recipientAuthority({ country: "KR", rule: ruleFor("US"), consent }));
});

// --- the Australian sender authority --------------------------------------

test("the Australian sender authority needs express consent today", () => {
  assert.equal(auSenderAuthority({ consent: noConsent }).reason, "no_au_sender_consent");
  const allowed = auSenderAuthority({ consent });
  assert.equal(allowed.verdict, "allow");
  assert.equal(allowed.authority, "au_sender");
  assert.equal(allowed.country, null);
});

// --- the combined verdict --------------------------------------------------

test("a US recipient without consent is refused by the sender authority alone", () => {
  const verdict = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules: [ruleFor("US")],
    consent: noConsent,
  });
  assert.equal(verdict.legalAllowed, false);
  assert.deepEqual(
    verdict.authorities.map((entry) => [entry.authority, entry.verdict]),
    [
      ["recipient", "allow"],
      ["au_sender", "deny"],
    ]
  );
  assert.equal(verdict.sharedBasis, null);
});

test("one express consent satisfying both sides is recorded as shared", () => {
  const verdict = releaseNotesAuthorityVerdict({
    countries: ["KR"],
    rules: [ruleFor("KR")],
    consent,
  });
  assert.equal(verdict.legalAllowed, true);
  assert.equal(verdict.sharedBasis, "express_consent");
  assert.deepEqual(verdict.ruleVersions, [{ ruleKey: "release_notes.KR", ruleVersion: 1 }]);

  // US with consent is shared too, and this is the case that was got wrong.
  // Section 4.2 asks whether one basis *satisfies* both authorities, not whether
  // both rested on the same word. CAN-SPAM needs no consent, so an express
  // consent satisfies it as surely as it satisfies the Australian sender
  // authority -- and a US recipient who went through double opt-in is exactly
  // the person 4.2's "for example, an express consent" describes.
  //
  // `recipientAuthority()` still records `opt_out` on that authority, because
  // that is what the rule needed. The two fields answer different questions.
  const us = releaseNotesAuthorityVerdict({ countries: ["US"], rules: [ruleFor("US")], consent });
  assert.equal(us.legalAllowed, true);
  assert.equal(us.sharedBasis, "express_consent");
  assert.equal(
    us.authorities.find((entry) => entry.country === "US")?.basis,
    "opt_out"
  );
});

test("no consent means no shared basis, whatever the rules allow", () => {
  // The other half of section 4.2. Without an express consent the Australian
  // sender authority does not rest on one, so nothing carried both sides even
  // where every recipient rule allowed on its own terms.
  const noConsent = { express: false, evidenceIds: [] };
  const us = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules: [ruleFor("US")],
    consent: noConsent,
  });
  assert.equal(us.sharedBasis, null);

  // And with a consent, a mixed pair is shared: one consent satisfies the
  // opt-out country, the express-consent country and the sender.
  const mixed = releaseNotesAuthorityVerdict({
    countries: ["US", "KR"],
    rules: [ruleFor("US"), ruleFor("KR")],
    consent,
  });
  assert.equal(mixed.legalAllowed, true);
  assert.equal(mixed.sharedBasis, "express_consent");
  assert.deepEqual(mixed.ruleVersions, [
    { ruleKey: "release_notes.KR", ruleVersion: 1 },
    { ruleKey: "release_notes.US", ruleVersion: 1 },
  ]);

  // A refused send shares nothing, because nothing carried both sides.
  const refused = releaseNotesAuthorityVerdict({
    countries: ["KR", "JP"],
    rules: [ruleFor("KR")],
    consent,
  });
  assert.equal(refused.legalAllowed, false);
  assert.equal(refused.sharedBasis, null);
});

test("every candidate country must pass, not just one", () => {
  // Section 5.3: two candidates both pass, not agree. KR allows with consent;
  // JP has no rule; the send is refused.
  const verdict = releaseNotesAuthorityVerdict({
    countries: ["KR", "JP"],
    rules: [ruleFor("KR")],
    consent,
  });
  assert.equal(verdict.legalAllowed, false);
  assert.deepEqual(
    verdict.authorities
      .filter((entry) => entry.authority === "recipient")
      .map((entry) => [entry.country, entry.verdict, entry.reason]),
    [
      ["JP", "deny", "no_country_rule"],
      ["KR", "allow", null],
    ]
  );
});

test("no candidate is ZZ, and ZZ is refused", () => {
  const verdict = releaseNotesAuthorityVerdict({ countries: [], rules: [], consent });
  assert.equal(verdict.legalAllowed, false);
  assert.equal(verdict.authorities[0].reason, "country_undetermined");
});

test("two rules for one country are refused rather than chosen between", () => {
  assert.throws(() =>
    releaseNotesAuthorityVerdict({
      countries: ["KR"],
      rules: [ruleFor("KR"), { ...ruleFor("KR"), ruleVersion: 2 }],
      consent,
    })
  );
});
