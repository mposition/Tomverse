// The policy boundary for provisional language diagnostics.
//
// Contract: docs/policy/marketing-automation.md §7.1. Pattern matching may
// notice copy that deserves a person, but it may not refuse that copy. Giving
// it refusal authority again requires replacing it with a tokeniser and
// morphology-aware analysis and changing this reviewed test.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  guardDraft,
  MARKETING_REJECT_CODES,
  sealMarketingFacts,
  sealMarketingGuardContext,
  sealMarketingTemplateProof,
} from "../lib/marketingGuardCore.ts";
import {
  MARKETING_GUARD_RULES,
  MARKETING_RULE_CATEGORIES,
} from "../lib/marketingGuardRules.ts";

const CHANNEL_ID = "chn_language_policy";
const LANGUAGE_FLAG = "provisional_language_flag";
const FREE_WORDING_RULE_ID = "rule.free-wording";
const languageRuleIds = new Set([
  ...MARKETING_GUARD_RULES.map((rule) => rule.id),
  FREE_WORDING_RULE_ID,
]);

const context = () =>
  sealMarketingGuardContext({
    priceFallbackAlertReady: true,
    incidentOrSecurity: "proved_false",
    testimonial: "proved_false",
    legalOrPolicy: "proved_false",
  });

const claimsOf = (entry) =>
  (entry.claims ?? []).map((type, index) => ({
    claimId: `${entry.id}.${index}`,
    type,
    known: true,
    priceSourcesAllStored: true,
    statesCreditAllowance: type === "plan",
    allowanceStatement: type === "plan" ? entry.allowanceStatement : undefined,
    usedBefore: true,
  }));

const decideCorpusCase = (entry) => {
  const claims = claimsOf(entry);
  return guardDraft({
    draft: {
      renderedText: entry.input,
      locale: "en",
      channel: "linkedin",
      channelId: CHANNEL_ID,
      claimIds: claims.map((claim) => claim.claimId),
      assetIds: [],
    },
    facts: sealMarketingFacts({
      channelId: CHANNEL_ID,
      channel: "linkedin",
      locale: "en",
      claims,
      assets: [],
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshotDigest: null,
    }),
    templates: [],
    context: context(),
  });
};

test("a provisional language flag makes autonomous-ready copy require approval", () => {
  const renderedText = "The best workspace for comparing answers.";
  const templateId = "template.language-policy";
  const facts = sealMarketingFacts({
    channelId: CHANNEL_ID,
    channel: "linkedin",
    locale: "en",
    claims: [],
    assets: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshotDigest: null,
  });

  const decision = guardDraft({
    draft: {
      renderedText,
      locale: "en",
      channel: "linkedin",
      channelId: CHANNEL_ID,
      claimIds: [],
      assetIds: [],
      templateId,
    },
    facts,
    templates: [
      sealMarketingTemplateProof({
        templateId,
        channelId: CHANNEL_ID,
        channel: "linkedin",
        locale: "en",
        historyVersion: 1,
        status: "approved",
        approvedDigest: "a".repeat(64),
        renderedTextDigest: createHash("sha256")
          .update(renderedText, "utf8")
          .digest("hex"),
        slotsFromRegistry: true,
        claimIds: [],
        assetIds: [],
      }),
    ],
    context: context(),
  });

  assert.equal(decision.verdict, "approval_required", JSON.stringify(decision));
  assert.deepEqual(decision.codes, [LANGUAGE_FLAG]);
  assert.ok(decision.ruleIds.includes("rule.superlative"));
});

test("the provisional language judge cannot contribute a reject code across the bypass corpus", () => {
  const bypass = JSON.parse(
    readFileSync(
      new URL("./fixtures/marketingGuard/bypass.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(bypass.cases.length, 141, "the reproduced bypass corpus is intact");
  assert.equal(MARKETING_RULE_CATEGORIES.length, 9);

  const seenLanguageRuleIds = new Set();
  for (const entry of bypass.cases) {
    const decision = decideCorpusCase(entry);

    if (languageRuleIds.has(entry.ruleId)) {
      seenLanguageRuleIds.add(entry.ruleId);
      assert.equal(
        decision.verdict,
        "approval_required",
        `${entry.id}: ${JSON.stringify(decision)}`,
      );
      assert.ok(decision.codes.includes(LANGUAGE_FLAG), entry.id);
      assert.ok(decision.ruleIds.includes(entry.ruleId), entry.id);
      assert.equal(
        decision.codes.some((code) => MARKETING_REJECT_CODES.includes(code)),
        false,
        `${entry.id} produced a reject code: ${JSON.stringify(decision)}`,
      );
      continue;
    }

    assert.match(entry.ruleId, /^hygiene\./u, entry.id);
    assert.equal(decision.verdict, "reject", entry.id);
    assert.ok(decision.codes.includes("hygiene"), entry.id);
    assert.ok(decision.ruleIds.includes(entry.ruleId), entry.id);
  }

  assert.deepEqual(
    [...seenLanguageRuleIds].sort(),
    [...languageRuleIds].sort(),
    "all nine language rules and rule.free-wording are exercised",
  );
});
