// The corpus, and the meta-test that keeps it honest.
//
// Contract: the S1 plan's S1f section. Two properties matter equally. A rule
// has to catch what it is for, including the spellings somebody reaches for
// when it is in the way — that is `bypass.json`. And it has to leave alone the
// words that merely contain it — that is `benign.json`, and a filter tested
// only on what it should catch is a filter that catches everything.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKETING_GUARD_RULE_IDS,
  MARKETING_GUARD_RULES,
} from "../lib/marketingGuardRules.ts";
import { MARKETING_HYGIENE_CODES } from "../lib/marketingGuardNormalise.ts";
import { guardDraft } from "../lib/marketingGuardCore.ts";

const corpus = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/marketingGuard/${name}`, import.meta.url), "utf8"),
  );

const bypass = corpus("bypass.json");
const benign = corpus("benign.json");

/**
 * A draft carrying its text, and the claims the case says it declares.
 *
 * Almost every case declares none: the corpus is about what the words say, and
 * every other input is exercised by `tests/marketingGuardCore.test.mjs`. The
 * exception is a post that says "free", because
 * docs/policy/marketing-automation.md §7.2 rule 4 wants the credit
 * allowance *as a claim* rather than as a word somebody typed -- so a case
 * about free wording has to be able to state that the allowance is there.
 *
 * `priceFallbackAlertReady` is false, which is its S1 value, so free copy that
 * passes every rule still lands on `approval_required` — which is what the
 * benign cases assert.
 */
const decide = (input, claims = []) =>
  guardDraft({
    draft: {
      renderedText: input,
      locale: "en",
      channel: "linkedin",
      channelId: "chn_corpus",
      claimIds: claims.map((claim) => claim.claimId),
      assetIds: [],
    },
    facts: { claims, assets: [] },
    templates: [],
    context: {
      priceFallbackAlertReady: false,
      incidentOrSecurity: "proved_false",
      testimonial: "proved_false",
      legalOrPolicy: "proved_false",
    },
  });

/** The claims a case declares, spelled out from its `claims` shorthand. */
const claimsOf = (entry) =>
  (entry.claims ?? []).map((type, index) => ({
    claimId: `${entry.id}.${index}`,
    type,
    known: true,
    priceSourcesAllStored: true,
    usedBefore: true,
  }));

test("every bypass case is refused, with the codes it states", () => {
  for (const entry of bypass.cases) {
    const decision = decide(entry.input, claimsOf(entry));
    assert.equal(
      decision.verdict,
      entry.expect.verdict,
      `${entry.id}: ${JSON.stringify(decision)}`,
    );
    assert.deepEqual(
      [...decision.codes].sort(),
      [...entry.expect.codes].sort(),
      entry.id,
    );
  }
});

test("a bypass case names the rule that catches it", () => {
  // Otherwise a case can pass because a different rule fired, and the rule it
  // was written for is untested while looking tested.
  for (const entry of bypass.cases) {
    const decision = decide(entry.input, claimsOf(entry));
    assert.ok(
      decision.ruleIds.includes(entry.ruleId),
      `${entry.id} expected ${entry.ruleId}, got ${JSON.stringify(decision.ruleIds)}`,
    );
  }
});

test("every benign case survives, and none is refused for a ban word", () => {
  for (const entry of benign.cases) {
    const decision = decide(entry.input, claimsOf(entry));
    assert.equal(
      decision.verdict,
      entry.expect.verdict,
      `${entry.id} (${entry.note}): ${JSON.stringify(decision)}`,
    );
    if (decision.verdict === "reject") {
      assert.ok(
        !decision.codes.includes("banned_claim"),
        `${entry.id} was refused as a banned claim`,
      );
    }
  }
});

test("every rule has a bypass case and a benign case", () => {
  // The meta-test the plan asks for. A rule with no bypass case is one nobody
  // has tried to defeat; a rule with no benign case is one nobody has checked
  // for false positives.
  const expected = [...MARKETING_GUARD_RULE_IDS, "rule.free-wording"].sort();
  const bypassIds = new Set(bypass.cases.map((entry) => entry.ruleId));
  const benignIds = new Set(benign.cases.map((entry) => entry.ruleId));

  for (const ruleId of expected) {
    assert.ok(bypassIds.has(ruleId), `${ruleId} has no bypass case`);
    assert.ok(benignIds.has(ruleId), `${ruleId} has no benign case`);
  }
});

test("every hygiene code has a bypass case and a benign case", () => {
  for (const code of MARKETING_HYGIENE_CODES) {
    const ruleId = `hygiene.${code}`;
    assert.ok(
      bypass.cases.some((entry) => entry.ruleId === ruleId) ||
        benign.cases.some((entry) => entry.ruleId === ruleId),
      `${ruleId} appears in neither file`,
    );
  }
});

test("the corpus addresses rules that exist", () => {
  // The other direction: a case naming a rule that has been renamed or removed
  // would sit there passing for a reason nobody intended.
  const known = new Set([
    ...MARKETING_GUARD_RULE_IDS,
    "rule.free-wording",
    ...MARKETING_HYGIENE_CODES.map((code) => `hygiene.${code}`),
  ]);
  for (const entry of [...bypass.cases, ...benign.cases]) {
    assert.ok(known.has(entry.ruleId), `${entry.id} names unknown ${entry.ruleId}`);
  }
});

test("the rules and their ids are frozen", () => {
  assert.equal(Object.isFrozen(MARKETING_GUARD_RULES), true);
  assert.equal(Object.isFrozen(MARKETING_GUARD_RULE_IDS), true);
  for (const rule of MARKETING_GUARD_RULES) {
    assert.equal(Object.isFrozen(rule), true, rule.id);
    assert.equal(Object.isFrozen(rule.patterns), true, rule.id);
    assert.equal(Object.isFrozen(rule.terms), true, rule.id);
  }
});

test("no rule exports a RegExp object", () => {
  // A RegExp carries its own mutable matcher, and `.compile()` replaces the
  // pattern in place. Every pattern here is source and flags, compiled per
  // call.
  for (const rule of MARKETING_GUARD_RULES) {
    for (const entry of rule.patterns) {
      assert.equal(typeof entry.source, "string", rule.id);
      assert.equal(typeof entry.flags, "string", rule.id);
      assert.ok(!(entry instanceof RegExp), rule.id);
    }
  }
});
