// The decision: precedence, the claim checks, and the one route to autonomy.
//
// Contract: docs/policy/marketing-automation.md §7.2 and §7.4, and the S1
// plan's S1f section. The corpus next door is about what the words say; this is
// about everything else the Guard is given.

import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import {
  MARKETING_APPROVAL_CODES,
  sealMarketingFacts,
  sealMarketingGuardContext,
  marketingGuardDraftDigest,
  MARKETING_TEMPLATE_PROOF_MAX_AGE_MS,
  marketingTemplateWriteConditions,
  MARKETING_REJECT_CODES,
  guardDraft,
  guardTemplateForApproval,
  sealMarketingTemplateProof,
} from "../lib/marketingGuardCore.ts";
import { resolveMarketingGuardContext } from "../lib/marketingGuardContext.ts";

const TEMPLATE_TEXT = "Three answers to one question, side by side.";
const CHANNEL_ID = "chn_linkedin_en";

/** Stands for the envelope digest, which is not of the text alone. */
const ENVELOPE_DIGEST = "e".repeat(64);

const TEMPLATE_DIGEST = createHash("sha256")
  .update(TEMPLATE_TEXT, "utf8")
  .digest("hex");

const context = (overrides = {}) =>
  sealMarketingGuardContext({
    priceFallbackAlertReady: false,
    incidentOrSecurity: "proved_false",
    testimonial: "proved_false",
    legalOrPolicy: "proved_false",
    ...overrides,
  });

/**
 * A sealed facts bundle, which is the only kind the Guard takes.
 *
 * Tests are outside the protected-writer check's scan, which is why they may
 * call the sealer directly: what the rule governs is the production surface,
 * where the only file allowed to say a fact was resolved is the resolver.
 */
const facts = (overrides = {}) =>
  sealMarketingFacts({
    channelId: CHANNEL_ID,
    channel: "linkedin",
    locale: "en",
    claims: [],
    assets: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshotDigest: null,
    ...overrides,
  });

const input = (overrides = {}) => {
  const draft = {
    renderedText: "Three answers to one question, side by side.",
    locale: "en",
    channel: "linkedin",
    channelId: CHANNEL_ID,
    claimIds: [],
    assetIds: [],
    ...(overrides.draft ?? {}),
  };
  return {
    draft,
    facts: overrides.sealedFacts ??
      facts({
        channelId: draft.channelId,
        channel: draft.channel,
        locale: draft.locale,
        claims: [],
        assets: [],
        ...(overrides.facts ?? {}),
      }),
    templates: overrides.templates ?? [],
    context: context(overrides.context),
  };
};

/** A draft that would be autonomous if every other input allowed it. */
const autonomousReady = (overrides = {}) => {
  const draftOverrides = overrides.draft ?? {};
  const draftScope = {
    channelId: draftOverrides.channelId ?? CHANNEL_ID,
    channel: draftOverrides.channel ?? "linkedin",
    locale: draftOverrides.locale ?? "en",
  };
  const rawFacts = {
    ...draftScope,
    claims: [
      {
        claimId: "claim.compare",
        type: "feature",
        known: true,
        featurePublic: true,
        evidenceStatement: TEMPLATE_TEXT,
        usedBefore: true,
      },
    ],
    assets: [{ assetId: "asset.hero", known: true, usedBefore: true }],
    ...(overrides.facts ?? {}),
  };
  const sealed = facts(rawFacts);
  return input({
    draft: {
      templateId: "template.compare",
      renderedText: TEMPLATE_TEXT,
      // Derived, because the Guard refuses a draft whose declared ids are not
      // the facts it was given -- which is the point of that check.
      claimIds: sealed.claims.map((claim) => claim.claimId),
      assetIds: sealed.assets.map((asset) => asset.assetId),
      ...draftOverrides,
    },
    sealedFacts: sealed,
    templates: overrides.templates ?? [
      sealMarketingTemplateProof({
        templateId: "template.compare",
        // The scope the approval was given in. A proof that carried only a
        // digest let one account's approval publish from another, and one
        // carrying the id alone let a RedNote account's approval be presented
        // as LinkedIn -- which is a channel §7.4 always sends to a person.
        channelId: CHANNEL_ID,
        channel: "linkedin",
        locale: "en",
        historyVersion: 7,
        status: "approved",
        // Two digests, two questions: the envelope column says the approved
        // post is still the approved post, and this one says the words the
        // Guard was handed are the approved words.
        approvedDigest: ENVELOPE_DIGEST,
        renderedTextDigest: TEMPLATE_DIGEST,
        slotsFromRegistry: true,
        // The ids the loader read off the approved post. The Guard compares
        // the draft's against these rather than against facts from the same
        // caller, which is what closes the "empty claim list" hole.
        claimIds: sealed.claims.map((claim) => claim.claimId),
        assetIds: sealed.assets.map((asset) => asset.assetId),
      }),
    ],
    context: { priceFallbackAlertReady: true, ...(overrides.context ?? {}) },
  });
};

test("a reject beats an approval, whatever else is true", () => {
  // Precedence is the shape of the whole function: one refused rule is
  // enough, and the approval reasons beside it do not soften it. Hygiene is a
  // byte fact, not one of the provisional language judgements.
  const decision = guardDraft(
    input({
      draft: { renderedText: "Thanks @openai -- the best workspace." },
      context: { incidentOrSecurity: "proved_true", testimonial: "proved_true" },
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("hygiene"));
  assert.ok(decision.ruleIds.includes("rule.superlative"));
});

test("free copy is never autonomous, whatever the draft says about itself", () => {
  // There is no input a draft can carry that makes new words publishable
  // without a person. A draft claiming to be safe is asserting the thing being
  // checked.
  const decision = guardDraft(
    autonomousReady({
      draft: { templateId: undefined, renderedDigest: undefined, isNewCopy: false },
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a template whose digest does not match is not a template", () => {
  // The digest is computed here from the text, so "does not match" means the
  // words changed -- not that a caller supplied a different number.
  const decision = guardDraft(
    autonomousReady({ draft: { renderedText: `${TEMPLATE_TEXT} Extra.` } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a template the loader never proved is not a template", () => {
  const decision = guardDraft(
    autonomousReady({
      templates: [],
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a template with a slot filled from free text is not a template", () => {
  const decision = guardDraft(
    autonomousReady({
      templates: [
        sealMarketingTemplateProof({
          templateId: "template.compare",
          approvedDigest: TEMPLATE_DIGEST,
          slotsFromRegistry: false,
          claimIds: ["claim.compare"],
          assetIds: ["asset.hero"],
        }),
      ],
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a claim used for the first time needs a person", () => {
  const decision = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.compare",
            type: "feature",
            known: true,
            featurePublic: true,
            evidenceStatement: TEMPLATE_TEXT,
            usedBefore: false,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("first_use_of_claim"));
});

test("everything lined up reaches autonomous, so the path is not dead code", () => {
  // Unreachable in production during S1 -- nothing writes the audit rows a
  // template needs, and the alert path does not exist -- but reachable here,
  // because a branch no test can enter is a branch nobody has checked.
  const decision = guardDraft(autonomousReady());
  assert.equal(decision.verdict, "autonomous_eligible", JSON.stringify(decision));
  assert.equal(decision.templateId, "template.compare");
  assert.equal(decision.templateDigest, ENVELOPE_DIGEST);
});

test("raw caller context cannot choose the autonomous verdict", () => {
  const ready = autonomousReady();
  const decision = guardDraft({
    ...ready,
    context: {
      priceFallbackAlertReady: true,
      incidentOrSecurity: "proved_false",
      testimonial: "proved_false",
      legalOrPolicy: "proved_false",
    },
  });
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("context_not_resolved"));
  assert.ok(decision.codes.includes("alert_path_not_ready"));
  assert.ok(decision.codes.includes("category_unreadable"));
  assert.ok(decision.ruleIds.includes("context.not-resolved"));
});

test("a copy of resolved context reports that its provenance was lost", () => {
  const ready = autonomousReady();
  const decision = guardDraft({
    ...ready,
    context: { ...ready.context },
  });
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("context_not_resolved"));
  assert.ok(decision.ruleIds.includes("context.not-resolved"));
});

test("the S1 server context is pinned closed", () => {
  const resolved = resolveMarketingGuardContext();
  assert.deepEqual(
    {
      priceFallbackAlertReady: resolved.priceFallbackAlertReady,
      incidentOrSecurity: resolved.incidentOrSecurity,
      testimonial: resolved.testimonial,
      legalOrPolicy: resolved.legalOrPolicy,
    },
    {
      priceFallbackAlertReady: false,
      incidentOrSecurity: "unreadable",
      testimonial: "unreadable",
      legalOrPolicy: "unreadable",
    },
  );
  const decision = guardDraft({ ...autonomousReady(), context: resolved });
  assert.equal(decision.verdict, "approval_required");
});

test("facts resolved for channel A in en cannot judge channel B in ko", () => {
  const decision = guardDraft(
    input({
      draft: { channelId: "chn_other", locale: "ko" },
      sealedFacts: facts(),
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("facts_scope_mismatch"));
});

test("without the alert path, the same draft is an approval", () => {
  // The S1 plan's B2 amendment: the Guard is not used for real drafts before
  // somebody would hear about a price-source refusal. Its S1 value is false.
  const decision = guardDraft(
    autonomousReady({ context: { priceFallbackAlertReady: false } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("alert_path_not_ready"));
});

// --- §7.2, the claim checks ------------------------------------------------

test("a price claim on anything but stored values is refused", () => {
  for (const priceSourcesAllStored of [false, undefined]) {
    const decision = guardDraft(
      autonomousReady({
        facts: {
          claims: [
            {
              claimId: "claim.pro-price",
              type: "pricing",
              known: true,
              priceSourcesAllStored,
              usedBefore: true,
            },
          ],
          assets: [],
        },
      }),
    );
    assert.equal(decision.verdict, "reject", String(priceSourcesAllStored));
    assert.ok(decision.codes.includes("price_source_not_stored"));
  }
});

test("an Australian price with no stored GST flag is refused", () => {
  // S1 plan, B2 amendment. A stored AUD amount is not enough: Australian
  // Consumer Law requires a single price inclusive of GST, and whether these
  // numbers include it is not derivable from the numbers. The catalogue
  // carries no such flag today, so this is where every Australian price lands.
  const decision = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.pro-price-au",
            type: "pricing",
            known: true,
            priceSourcesAllStored: true,
            targetsAustralia: true,
            currency: "AUD",
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("au_price_gst_unverifiable"));
});

test("an Australian price in the wrong currency is refused too", () => {
  const decision = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.pro-price-au",
            type: "pricing",
            known: true,
            priceSourcesAllStored: true,
            targetsAustralia: true,
            currency: "USD",
            gstInclusiveStored: true,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("au_price_gst_unverifiable"));
});

test("no input lifts the Australian price refusal", () => {
  // The refusal is unconditional while `billingPriceCatalogSchema` has no
  // GST-inclusive field. An earlier version took `gstInclusiveStored` from the
  // caller -- a stored proof of something the catalogue cannot store, which is
  // a boolean standing in for evidence that does not exist.
  for (const extra of [
    {},
    { gstInclusiveStored: true },
    { gstInclusive: true },
    { currency: "AUD", gstInclusiveStored: true },
  ]) {
    const decision = guardDraft(
      autonomousReady({
        facts: {
          claims: [
            {
              claimId: "claim.pro-price-au",
              type: "pricing",
              known: true,
              priceSourcesAllStored: true,
              targetsAustralia: true,
              currency: "AUD",
              usedBefore: true,
              ...extra,
            },
          ],
          assets: [],
        },
      }),
    );
    assert.equal(decision.verdict, "reject", JSON.stringify(extra));
    assert.ok(decision.codes.includes("au_price_gst_unverifiable"));
  }
});

test("a model claim the registry does not agree with is refused", () => {
  const decision = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.luna-free",
            type: "model",
            known: true,
            modelMatches: false,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("model_claim_false"));
});

test("a feature that is not public is refused", () => {
  for (const type of ["feature", "availability"]) {
    const decision = guardDraft(
      autonomousReady({
        facts: {
          claims: [
            {
              claimId: `claim.${type}`,
              type,
              known: true,
              featurePublic: false,
              usedBefore: true,
            },
          ],
          assets: [],
        },
      }),
    );
    assert.equal(decision.verdict, "reject", type);
    assert.ok(decision.codes.includes("feature_not_public"));
  }
});

test("a comparison needs its evidence, and then still needs a person", () => {
  const without = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.vs",
            type: "comparison",
            known: true,
            comparisonEvidence: false,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(without.verdict, "reject");
  assert.ok(without.codes.includes("comparison_without_evidence"));

  const withEvidence = guardDraft(
    autonomousReady({
      facts: {
        claims: [
          {
            claimId: "claim.vs",
            type: "comparison",
            known: true,
            comparisonEvidence: true,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(withEvidence.verdict, "approval_required");
  assert.ok(withEvidence.codes.includes("competitor_named"));
});

test("a claim or asset the registry does not hold is refused", () => {
  const claim = guardDraft(
    autonomousReady({
      facts: {
        claims: [{ claimId: "claim.invented", type: "feature", known: false, usedBefore: true }],
        assets: [],
      },
    }),
  );
  assert.equal(claim.verdict, "reject");
  assert.ok(claim.codes.includes("claim_unknown"));

  const asset = guardDraft(
    autonomousReady({
      facts: {
        claims: [],
        assets: [{ assetId: "asset.invented", known: false, usedBefore: true }],
      },
    }),
  );
  assert.equal(asset.verdict, "reject");
  assert.ok(asset.codes.includes("asset_unknown"));
});

test("a figure that is not money with no claim behind it goes to a person, not to a refusal", () => {
  // §7.2 rule 8: what cannot be verified is an approval. The failure is the
  // extraction's, and a person can read the sentence. (An English *price* is
  // held to the stored amount instead, since 2026-11-02: see the tests below.)
  const decision = guardDraft(
    input({ draft: { renderedText: "Compare answers from 3 models, and save 20% of your time." } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("undeclared_fact"));
});

// --- owner decision 2026-11-02: English prices and price comparisons --------

/** A stored Pro price: 15.00 USD a month. */
const PRO_PRICE = {
  claimId: "claim.pro-monthly-price",
  type: "pricing",
  known: true,
  priceSourcesAllStored: true,
  currency: "USD",
  targetsAustralia: false,
  priceMinor: 1500,
  planName: "Pro",
  usedBefore: true,
};
const MAX_PRICE = { ...PRO_PRICE, claimId: "claim.max-monthly-price", priceMinor: 4500, planName: "Max" };

const priceDecision = (renderedText, claims = [PRO_PRICE], locale = "en") =>
  guardDraft(
    input({
      draft: { renderedText, locale, claimIds: claims.map((claim) => claim.claimId) },
      facts: { locale, claims, assets: [] },
    }),
  );

test("an English price equal to the stored amount, currency and plan is a person's decision, not a refusal", () => {
  for (const text of [
    "Pro is USD 15.00 per month.",
    "Pro costs 15 USD a month.",
    "Pro: $15 USD per month.",
    "Pro is US$15 a month.",
    "Pro is 15 US dollars a month.",
  ]) {
    const decision = priceDecision(text);
    // Always the approval queue (§7.4), never autonomous and never refused.
    assert.equal(decision.verdict, "approval_required", text);
    assert.ok(decision.codes.includes("price_or_promotion"), text);
  }
});

test("two plan prices in one post are each held to their own plan", () => {
  const ok = priceDecision("Pro is USD 15.00 per month and Max is USD 45.00 per month.", [PRO_PRICE, MAX_PRICE]);
  assert.equal(ok.verdict, "approval_required");
  const swapped = priceDecision("Pro is USD 45.00 per month and Max is USD 15.00 per month.", [PRO_PRICE, MAX_PRICE]);
  assert.equal(swapped.verdict, "reject");
  assert.ok(swapped.codes.includes("price_text_mismatch"));
});

test("an English price that is not the stored amount is refused", () => {
  for (const text of [
    "Pro is USD 20.00 per month.", // another amount
    "Pro is EUR 15.00 per month.", // another currency
    "Pro is USD 15.00 per month and USD 9 for the first month.", // a second amount nothing stores
    "Team is USD 15.00 per month.", // not the plan the claim is about
    "Pro is USD 15.00 or EUR 15.00 per month.", // a second amount in another currency
    "Pro is USD 15.00 per year.", // the right amount for another billing period
    "Pro annual price: USD 15.",
    "Pro costs USD 15 per 12 months.",
    "Pro is USD 15.00.", // no billing period said
    "Pro users can upgrade: Max costs USD 15 per month.", // the amount belongs to a plan nothing declares
    "Pro users can upgrade: max costs USD 15 per month.",
    "Pro costs USD 15 per month, billed annually.", // a monthly figure with a yearly condition
    "Pro is USD 15 per month; billed annually.",
    "Pro is USD 15 per month, billed every 12 months.",
    "Pro monthly price is USD 15.", // the period is not attached to the figure
    "Pro costs USD 15 per week.",
    "Pro costs USD 15 per month, billed every 4 weeks.",
    "Pro costs USD 15 per month, billed every 7 days.",
    "Pro costs USD 15 per month, billed every twelve months.",
    "Pro costs USD 15.004 per month.", // more decimals than money has
    "Pro is .15 USD per month.", // a leading dot is part of the amount
    "Pro is USD 15.00 per month, billed semiannually.",
    "Pro is USD 15.00 per month, billed every other day.",
    "Pro is USD 15.00 per month, billed weekly.",
    "Pro is USD 15 per month, billed every week.",
    "Pro is USD 15 per month, payable weekly.",
    "Pro is USD 15 per month, debited weekly.",
    "Pro is USD 15 per month, collected daily.",
    "Pro is USD 15 per month, billed every quarter.",
    "Pro is USD 15 per month, billed every second month.",
    "Pro is USD 15 per month, renews automatically.",
    "Pro is USD 15 per month, charged each day.",
    "Pro is USD 15.00/yr.",
    "Pro is USD 15.00 for the first year.",
    "Pro is USD 15.00 billed yearly.",
    "Pro is USD 15.00 per month, or USD 15.00 per year.",
    "Starting at USD 15.00 per month.", // no plan named
  ]) {
    const decision = priceDecision(text);
    assert.equal(decision.verdict, "reject", text);
    assert.ok(decision.codes.includes("price_text_mismatch"), text);
  }
});

test("a figure with a billing period is a price even with no currency, and a limit is not", () => {
  for (const text of [
    "Pro is 99 per month.",
    "Pro is 99/mo.",
    "Pro is 99 a month.",
    "Pro is 99 monthly.",
    "Pro monthly price is 99.", // a figure ending the sentence right after the plan
    "Pro costs 99 per week.",
  ]) {
    const decision = priceDecision(text);
    assert.equal(decision.verdict, "reject", text);
    assert.ok(decision.codes.includes("price_currency_missing"), text);
  }
  // Whitespace of any kind between the code and the amount is still that amount.
  for (const text of ["Pro is USD  15.00 per month.", "Pro is USD\n15.00 per month."]) {
    assert.equal(priceDecision(text).verdict, "approval_required", text);
  }
  assert.equal(priceDecision("Pro is USD  20.00 per month.").verdict, "reject");
  // "20 a day" is not a billing period, and "100 messages per month" has a noun
  // between the figure and the period.
  assert.ok(!priceDecision("Save 20 a day of busywork.", []).codes.includes("price_currency_missing"));
  // Time words that are not billing leave a correct price alone.
  for (const text of ["Pro costs USD 15.00 per month. Save hours every day.", "Pro is USD 15.00 per month; see results in days."]) {
    assert.equal(priceDecision(text).verdict, "approval_required", text);
  }
  assert.ok(!priceDecision("Pro has been here since 2026.").codes.includes("price_currency_missing"));
  // A model version ending a clause beside a plan name is not a price with no currency.
  for (const text of ["Choose Pro for GPT-5.", "Pro compares GPT-5, Claude 4.5 and Gemini 3."]) {
    assert.ok(!priceDecision(text, []).codes.includes("price_currency_missing"), text);
  }
  const limit = priceDecision("Pro includes 100 messages per month.", []);
  assert.ok(!limit.codes.includes("price_currency_missing"));
  assert.ok(!limit.codes.includes("price_text_mismatch"));
});

test("an English price with no declared price claim has nothing to match and is refused", () => {
  const decision = priceDecision("Compare answers from 3 models for USD 15 a month.", []);
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("price_text_mismatch"));
});

test("an English price with no currency is refused, even when the amount is right", () => {
  for (const text of [
    "Pro is $15 a month.",
    "Pro is 15 dollars a month.",
    "Pro is 15 bucks a month.",
    "Compare answers from 3 models for $20 a month.",
  ]) {
    const decision = priceDecision(text);
    assert.equal(decision.verdict, "reject", text);
    assert.ok(decision.codes.includes("price_currency_missing"), text);
  }
});

test("an Australian price stays refused: stated in AUD, or stored in AUD", () => {
  const stated = priceDecision("Pro is AUD 15.00 per month.");
  assert.equal(stated.verdict, "reject");
  assert.ok(stated.codes.includes("au_price_gst_unverifiable"));
  for (const text of ["Pro is A$15 a month.", "Pro is 15 Australian dollars a month."]) {
    const decision = priceDecision(text);
    assert.ok(decision.codes.includes("au_price_gst_unverifiable"), text);
  }
  const storedInAud = priceDecision("Pro is USD 15.00 per month.", [
    { ...PRO_PRICE, currency: "AUD", targetsAustralia: true },
  ]);
  assert.equal(storedInAud.verdict, "reject");
  assert.ok(storedInAud.codes.includes("au_price_gst_unverifiable"));
  // Stored in AUD without the flag: the words still do not match.
  const mismatch = priceDecision("Pro is USD 15.00 per month.", [{ ...PRO_PRICE, currency: "AUD" }]);
  assert.equal(mismatch.verdict, "reject");
  assert.ok(mismatch.codes.includes("price_text_mismatch"));
});

test("a price that did not come from stored values is not something an English amount can match", () => {
  const decision = priceDecision("Pro is USD 15.00 per month.", [{ ...PRO_PRICE, priceSourcesAllStored: false }]);
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("price_source_not_stored"));
  assert.ok(decision.codes.includes("price_text_mismatch"));
});

test("other languages are not held to the English money rule", () => {
  // Korean and Traditional Chinese posts keep their earlier behaviour: the
  // owner's decision of 2026-11-02 is about English posts.
  const decision = priceDecision("Pro는 월 $20입니다.", [PRO_PRICE], "ko");
  assert.equal(decision.verdict, "approval_required");
  assert.ok(!decision.codes.includes("price_text_mismatch"));
});

test("a comparative or superlative price expression is refused, in every language", () => {
  for (const [locale, text] of [
    ["en", "The cheapest way to compare three AI models."],
    ["en", "Tomverse has the lowest price for side by side answers."],
    ["en", "Always the lowest-priced option."],
    ["en", "Get the best price on AI answers."],
    ["en", "Cheaper than ChatGPT Plus."],
    ["en", "Cheaper-than-anything review plans."],
    ["en", "The only free way to see three answers."],
    ["en", "Cheapest — free to start."],
    ["ko", "세 모델 답변을 비교하는 최저가 방법입니다."],
    ["ko", "가장 저렴한 AI 비교 서비스입니다."],
    ["ko", "다른 서비스보다 저렴합니다."],
    ["ko", "유일한 무료 비교 서비스입니다."],
    ["zh-Hant", "最便宜的 AI 回答比較。"],
    ["zh-Hans", "最低价的 AI 回答对比。"],
  ]) {
    const decision = priceDecision(text, [], locale);
    assert.equal(decision.verdict, "reject", text);
    assert.ok(decision.codes.includes("price_comparison_claim"), text);
    assert.ok(decision.ruleIds.includes("rule.price-comparison"), text);
  }
});

test("price wording that is not a comparison is left to the earlier rules", () => {
  for (const text of [
    "Start free with monthly credits included.", // "free" keeps its section 7.2 rule 4 handling
    "Cheap thrills are not our thing; clear answers are.", // "cheap" alone is not a comparison
    "Choose a cheaper model for simple questions.", // "cheaper" without "than" is about models
    "Our best answers come from comparing three models.", // "best" is the superlative rule's, an approval
  ]) {
    const decision = priceDecision(text, []);
    assert.ok(!decision.codes.includes("price_comparison_claim"), text);
  }
  const free = priceDecision("Start free with monthly credits included.", []);
  assert.equal(free.verdict, "approval_required");
  assert.ok(free.codes.includes("provisional_language_flag"));
});

test("RedNote is an approval whatever the post says", () => {
  const decision = guardDraft(
    autonomousReady({ draft: { channel: "rednote" } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("rednote_channel"));
});

test("a template is checked once, when it is approved", () => {
  // §7.2. Otherwise a rule added later would silently stop applying to the
  // posts that matter most.
  const decision = guardTemplateForApproval(
    {
      renderedText: "The best model, guaranteed.",
      locale: "en",
      channel: "linkedin",
      channelId: CHANNEL_ID,
    },
    facts({ claims: [], assets: [] }),
    context({ priceFallbackAlertReady: true }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("provisional_language_flag"));
  assert.ok(decision.ruleIds.includes("rule.superlative"));
  assert.ok(decision.ruleIds.includes("rule.guarantee"));
});

test("the code lists are closed and frozen", () => {
  assert.equal(Object.isFrozen(MARKETING_REJECT_CODES), true);
  assert.equal(Object.isFrozen(MARKETING_APPROVAL_CODES), true);
  assert.throws(
    () => {
      "use strict";
      MARKETING_REJECT_CODES.push("invented");
    },
    TypeError,
  );
});

test("every reject code is reachable", () => {
  // A code nothing can produce is a code that describes nothing.
  const reached = new Set();
  const collect = (decision) => {
    if (decision.verdict === "reject") {
      for (const code of decision.codes) reached.add(code);
    }
  };

  collect(guardDraft(input({ draft: { renderedText: "thanks @openai" } })));
  // A declared id with no resolved fact behind it, and the other way round.
  collect(guardDraft(input({ draft: { claimIds: ["claim.undeclared"] } })));

  // A bundle the resolver never made. Every check below reads `known` and the
  // rest out of it, so a caller that could build one could declare a claim
  // nobody registered to be true.
  collect(
    guardDraft({
      ...input(),
      facts: {
        claims: [],
        assets: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshotDigest: null,
      },
    }),
  );

  // An English amount with no currency, one that is not the stored price, and a
  // comparison of prices.
  collect(guardDraft(input({ draft: { renderedText: "Pro is $15 a month." } })));
  collect(guardDraft(input({ draft: { renderedText: "Pro is USD 15 a month." } })));
  collect(guardDraft(input({ draft: { renderedText: "The cheapest way to compare models." } })));

  const claims = [
    { claimId: "a", type: "pricing", known: true, priceSourcesAllStored: false, usedBefore: true },
    {
      claimId: "a",
      type: "pricing",
      known: true,
      priceSourcesAllStored: true,
      targetsAustralia: true,
      currency: "AUD",
      usedBefore: true,
    },
    { claimId: "a", type: "model", known: true, modelMatches: false, usedBefore: true },
    { claimId: "a", type: "feature", known: true, featurePublic: false, usedBefore: true },
    { claimId: "a", type: "comparison", known: true, comparisonEvidence: false, usedBefore: true },
    { claimId: "a", type: "feature", known: false, usedBefore: true },
    { claimId: "a", type: "invented", known: true, usedBefore: true },
  ];
  for (const claim of claims) {
    collect(
      guardDraft(
        input({ draft: { claimIds: ["a"] }, facts: { claims: [claim], assets: [] } }),
      ),
    );
  }
  collect(
    guardDraft(
      input({
        draft: { assetIds: ["x"] },
        facts: { claims: [], assets: [{ assetId: "x", known: false, usedBefore: true }] },
      }),
    ),
  );

  assert.deepEqual([...reached].sort(), [...MARKETING_REJECT_CODES].sort());
});

// --- the proof's scope, its age, and what a template does not exempt --------

test("a proof carries the account and the language it was approved for", () => {
  // One approval, one account, one language. Without this the Guard compared a
  // digest and nothing else, so the same words approved for the LinkedIn
  // English account published from the zh-Hant Instagram one -- a different
  // audience, a different jurisdiction and a different graduation record.
  for (const draft of [
    { channelId: "chn_instagram_zh" },
    { locale: "zh-Hant" },
  ]) {
    const decision = guardDraft(autonomousReady({ draft }));
    assert.equal(decision.verdict, "approval_required", JSON.stringify(draft));
    assert.ok(decision.codes.includes("new_copy"), JSON.stringify(decision));
  }
});

test("a proof is worth nothing once it is old", () => {
  // A proof is evidence about a row as it was read, and the row can be edited
  // or un-marked a second later. The binding below makes the write conditional
  // on the row not having moved; this is what stops the proof itself being
  // kept and presented later as a standing permission.
  const ready = autonomousReady();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + MARKETING_TEMPLATE_PROOF_MAX_AGE_MS + 1;
    const decision = guardDraft(ready);
    assert.equal(decision.verdict, "approval_required", JSON.stringify(decision));
    assert.ok(decision.codes.includes("new_copy"));
  } finally {
    Date.now = realNow;
  }
});

test("an autonomous decision hands back the row state it was made against", () => {
  const decision = guardDraft(autonomousReady());
  assert.equal(decision.verdict, "autonomous_eligible", JSON.stringify(decision));
  assert.equal(decision.templateBinding.templateId, "template.compare");
  assert.equal(decision.templateBinding.channelId, CHANNEL_ID);
  assert.equal(decision.templateBinding.locale, "en");
  assert.equal(decision.templateBinding.approvedDigest, ENVELOPE_DIGEST);
  assert.equal(decision.templateBinding.historyVersion, 7);
  assert.equal(decision.templateBinding.reusableAsTemplate, true);
  assert.equal(
    decision.templateBinding.expiresAt,
    decision.templateBinding.provenAt + MARKETING_TEMPLATE_PROOF_MAX_AGE_MS,
  );
});

test("a binding is a write condition with an expiry, not a permission", () => {
  // The age bound stopped a *proof* being kept. The decision carried the same
  // permission with no expiry on it, so a caller could hold a fresh decision
  // and use it as a row predicate a minute later. Turning a binding into a
  // write goes through here, and here refuses an expired one.
  const decision = guardDraft(autonomousReady());
  assert.equal(decision.verdict, "autonomous_eligible");
  const binding = decision.templateBinding;

  const inTime = marketingTemplateWriteConditions(binding, new Date(binding.provenAt));
  assert.equal(inTime.ok, true, JSON.stringify(inTime));
  assert.deepEqual(inTime.where, {
    id: "template.compare",
    channelId: CHANNEL_ID,
    locale: "en",
    approvedDigest: ENVELOPE_DIGEST,
    envelopeDigest: ENVELOPE_DIGEST,
    historyVersion: 7,
    reusableAsTemplate: true,
    status: "approved",
    // The retention purge empties the content without moving the history
    // version, so neither of these would have been noticed by the version.
    contentPurgedAt: null,
    deletedAt: null,
  });

  // A binding this module did not make is not a write condition, whatever its
  // fields say. This was the whole of it: an object with a future `expiresAt`
  // was accepted.
  const forged = marketingTemplateWriteConditions(
    { ...binding },
    new Date(binding.provenAt),
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.refusal, "binding_not_sealed");

  for (const at of [
    new Date(binding.expiresAt + 1),
    // A clock behind the mint is a clock nobody agreed on.
    new Date(binding.provenAt - 1),
    new Date(Number.NaN),
  ]) {
    const refused = marketingTemplateWriteConditions(binding, at);
    assert.equal(refused.ok, false, String(at));
    assert.equal(refused.refusal, "binding_expired");
  }
});

test("a proof for one platform does not stand for another", () => {
  // A real RedNote proof presented with channel "linkedin" was autonomous, and
  // RedNote is a channel §7.4 always sends to a person.
  const decision = guardDraft(autonomousReady({ draft: { channel: "rednote" } }));
  assert.equal(decision.verdict, "approval_required", JSON.stringify(decision));
  assert.ok(decision.codes.includes("new_copy"));
});

test("the always-approving categories are re-read for a template rendering", () => {
  // §7.4 says a price, a promotion or a named competitor always needs a
  // person. An earlier version derived those from the *declared* claim types
  // and skipped the fact scan whenever a template stood, so a template
  // rendering that stated a discount and declared nothing at all was
  // autonomous -- with a valid seal and empty id lists.
  const cases = [
    ["Save 20% with our September discount.", "price_or_promotion"],
    ["Our September promotion is live.", "price_or_promotion"],
    ["Compare ChatGPT and Claude side by side.", "competitor_named"],
  ];

  for (const [renderedText, code] of cases) {
    const digest = createHash("sha256").update(renderedText, "utf8").digest("hex");
    const decision = guardDraft(
      autonomousReady({
        draft: { renderedText, claimIds: [], assetIds: [] },
        facts: { claims: [], assets: [] },
        templates: [
          sealMarketingTemplateProof({
            templateId: "template.compare",
            channelId: CHANNEL_ID,
            locale: "en",
            historyVersion: 7,
            approvedDigest: digest,
            slotsFromRegistry: true,
            claimIds: [],
            assetIds: [],
          }),
        ],
      }),
    );
    assert.equal(decision.verdict, "approval_required", renderedText);
    assert.ok(decision.codes.includes(code), `${renderedText}: ${JSON.stringify(decision)}`);
  }
});

test("free wording needs the allowance as a claim, not as a word", () => {
  // §7.2 rule 4 wants the condition in the post. The condition is the credit
  // allowance, and "credits" appearing in a sentence that says the opposite of
  // a limit is not it.
  for (const renderedText of [
    "Start free. Credits never run out.",
    "Free forever; credits power the service.",
  ]) {
    const decision = guardDraft(input({ draft: { renderedText } }));
    assert.equal(decision.verdict, "approval_required", renderedText);
    assert.ok(decision.codes.includes("provisional_language_flag"));
    assert.ok(decision.ruleIds.includes("rule.free-wording"));
  }

  // The same words with the allowance declared and stated.
  const ALLOWANCE = "monthly credits included";
  const withClaim = guardDraft(
    input({
      draft: {
        renderedText: `Start free with ${ALLOWANCE}.`,
        claimIds: ["claim.free-tier"],
      },
      facts: {
        claims: [
          {
            claimId: "claim.free-tier",
            type: "plan",
            known: true,
            priceSourcesAllStored: true,
            statesCreditAllowance: true,
            allowanceStatement: ALLOWANCE,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(withClaim.verdict, "approval_required", JSON.stringify(withClaim));
  assert.ok(withClaim.codes.includes("price_or_promotion"));

  // A price claim about something else is not the allowance. "Start free.
  // Credits never run out. Pro costs AUD 20 per month." passed on the strength
  // of the Pro price.
  const wrongClaim = guardDraft(
    input({
      draft: {
        renderedText: "Start free. Credits never run out.",
        claimIds: ["claim.pro-price"],
      },
      facts: {
        claims: [
          {
            claimId: "claim.pro-price",
            type: "pricing",
            known: true,
            priceSourcesAllStored: true,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(wrongClaim.verdict, "approval_required", JSON.stringify(wrongClaim));
  assert.ok(wrongClaim.codes.includes("provisional_language_flag"));
  assert.ok(wrongClaim.ruleIds.includes("rule.free-wording"));

  // And "free" inside a compound that is not about a price says nothing about
  // one. This was refused for stating a price it does not state.
  // The allowance claim declared but its sentence never rendered. An id in a
  // list is not the condition §7.2 rule 4 asks for; the words are.
  const notRendered = guardDraft(
    input({
      draft: {
        renderedText: "Start free today.",
        claimIds: ["claim.free-tier"],
      },
      facts: {
        claims: [
          {
            claimId: "claim.free-tier",
            type: "plan",
            known: true,
            priceSourcesAllStored: true,
            statesCreditAllowance: true,
            allowanceStatement: ALLOWANCE,
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(notRendered.verdict, "approval_required", JSON.stringify(notRendered));
  assert.ok(notRendered.codes.includes("provisional_language_flag"));
  assert.ok(notRendered.ruleIds.includes("rule.free-wording"));

  // "free" in a compound that is not about a price says nothing about one.
  // The shape, not a list: "distraction-free" is not in any list and was
  // refused, while the "free form" entry matched across a full stop and let
  // "Start free. form habits that last." out with no price check at all.
  for (const renderedText of [
    "Use free-form prompts to describe the task.",
    "A distraction-free writing space.",
    "An ad-free reading view.",
    "Free from the usual clutter.",
  ]) {
    const compound = guardDraft(input({ draft: { renderedText } }));
    assert.equal(compound.verdict, "approval_required", renderedText);
    assert.ok(!compound.codes.includes("price_or_promotion"), renderedText);
  }

  const acrossASentence = guardDraft(
    input({ draft: { renderedText: "Start free. form habits that last." } }),
  );
  assert.equal(acrossASentence.verdict, "approval_required", JSON.stringify(acrossASentence));
  assert.ok(acrossASentence.codes.includes("provisional_language_flag"));
  assert.ok(acrossASentence.ruleIds.includes("rule.free-wording"));
});

// --- the decision is about this draft, and cannot be edited afterwards -----

test("every decision carries the digest of the draft it was made about", () => {
  // Provenance says a Guard made it. It does not say what about, and a writer
  // that checked only the seal attached a decision made for "Three answers side
  // by side." to a row that said "The best AI, guaranteed."
  const decision = guardDraft(input());
  assert.equal(
    decision.draftDigest,
    marketingGuardDraftDigest({
      renderedText: "Three answers to one question, side by side.",
      locale: "en",
      channel: "linkedin",
      channelId: CHANNEL_ID,
      claimIds: [],
      assetIds: [],
    }),
  );

  // Any field of the draft changes it.
  const other = guardDraft(
    input({ draft: { renderedText: "Something else entirely." } }),
  );
  assert.notEqual(other.draftDigest, decision.draftDigest);
  const elsewhere = guardDraft(input({ draft: { channelId: "chn_other" } }));
  assert.notEqual(elsewhere.draftDigest, decision.draftDigest);
});

test("a sealed decision cannot be given a different answer afterwards", () => {
  // The seal is a `WeakSet`, which says where the object came from and nothing
  // about what it says now. An accessor installed after the fact returned
  // `approval_required` to the check and `autonomous_eligible` to the line
  // that wrote the row, so the object is frozen as well as registered.
  const decision = guardDraft(input());
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.ruleIds), true);
  assert.equal(Object.isFrozen(decision.codes), true);

  assert.throws(() => {
    Object.defineProperty(decision, "verdict", { get: () => "autonomous_eligible" });
  });
  assert.equal(decision.verdict, "approval_required");

  const autonomous = guardDraft(autonomousReady());
  assert.equal(autonomous.verdict, "autonomous_eligible");
  assert.equal(Object.isFrozen(autonomous.templateBinding), true);
  assert.throws(() => {
    Object.defineProperty(autonomous.templateBinding, "templateId", {
      value: "template.other",
    });
  });
});

test("the Guard reads its input once", () => {
  // A field is a property and a property can be an accessor. One that answered
  // "The best AI, guaranteed." to the digest and something harmless to the
  // rules produced a decision bound to the first and made about the second.
  let reads = 0;
  const draft = {
    locale: "en",
    channel: "linkedin",
    channelId: CHANNEL_ID,
    claimIds: [],
    assetIds: [],
    get renderedText() {
      reads += 1;
      return reads === 1
        ? "The best AI, guaranteed."
        : "Three answers to one question, side by side.";
    },
  };

  const decision = guardDraft({
    draft,
    facts: facts(),
    templates: [],
    context: context(),
  });

  // Whatever the first read said is what was checked *and* what was bound.
  assert.equal(decision.verdict, "approval_required", JSON.stringify(decision));
  assert.ok(decision.codes.includes("provisional_language_flag"));
  assert.ok(decision.ruleIds.includes("rule.superlative"));
  assert.ok(decision.ruleIds.includes("rule.guarantee"));
  assert.equal(
    decision.draftDigest,
    marketingGuardDraftDigest({
      renderedText: "The best AI, guaranteed.",
      locale: "en",
      channel: "linkedin",
      channelId: CHANNEL_ID,
      claimIds: [],
      assetIds: [],
    }),
  );
});

test("a proof is not copied, so a caller cannot hand one on", () => {
  // `templates` is the one input the Guard does not copy. A proof is
  // identified by being in this module's own `WeakSet`, and a copy of one --
  // a spread, a clone, an object with the same fields -- is not in it.
  const ready = autonomousReady();
  const [proof] = ready.templates;

  for (const impostor of [
    { ...proof },
    Object.freeze({ ...proof }),
    Object.create(proof),
  ]) {
    const decision = guardDraft({ ...ready, templates: [impostor] });
    assert.equal(decision.verdict, "approval_required", JSON.stringify(impostor));
    assert.ok(decision.codes.includes("new_copy"));
  }
});
