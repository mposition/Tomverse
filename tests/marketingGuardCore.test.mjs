// The decision: precedence, the claim checks, and the one route to autonomy.
//
// Contract: docs/policy/marketing-automation.md §7.2 and §7.4, and the S1
// plan's S1f section. The corpus next door is about what the words say; this is
// about everything else the Guard is given.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_APPROVAL_CODES,
  MARKETING_REJECT_CODES,
  guardDraft,
  guardTemplateForApproval,
} from "../lib/marketingGuardCore.ts";

const TEMPLATE_DIGEST = "a".repeat(64);

const context = (overrides = {}) => ({
  priceFallbackAlertReady: false,
  channelAlwaysApproves: false,
  mentionsCompetitor: false,
  mentionsPriceOrPromotion: false,
  mentionsIncidentOrSecurity: false,
  mentionsTestimonial: false,
  mentionsLegalOrPolicy: false,
  ...overrides,
});

const input = (overrides = {}) => ({
  draft: {
    renderedText: "Three answers to one question, side by side.",
    locale: "en",
    channel: "linkedin",
    claimIds: [],
    assetIds: [],
    ...(overrides.draft ?? {}),
  },
  facts: { claims: [], assets: [], ...(overrides.facts ?? {}) },
  templates: overrides.templates ?? [],
  context: context(overrides.context),
});

/** A draft that would be autonomous if every other input allowed it. */
const autonomousReady = (overrides = {}) =>
  input({
    draft: {
      templateId: "template.compare",
      renderedDigest: TEMPLATE_DIGEST,
      ...(overrides.draft ?? {}),
    },
    facts: {
      claims: [
        {
          claimId: "claim.compare",
          type: "feature",
          known: true,
          featurePublic: true,
          usedBefore: true,
        },
      ],
      assets: [{ assetId: "asset.hero", known: true, usedBefore: true }],
      ...(overrides.facts ?? {}),
    },
    templates: overrides.templates ?? [
      {
        templateId: "template.compare",
        approvedDigest: TEMPLATE_DIGEST,
        slotsFromRegistry: true,
      },
    ],
    context: { priceFallbackAlertReady: true, ...(overrides.context ?? {}) },
  });

test("a reject beats an approval, whatever else is true", () => {
  // Precedence is the shape of the whole function: one refused rule is
  // enough, and the approval reasons beside it do not soften it.
  const decision = guardDraft(
    input({
      draft: { renderedText: "The best workspace, guaranteed." },
      context: { mentionsCompetitor: true, mentionsPriceOrPromotion: true },
    }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("banned_claim"));
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
  const decision = guardDraft(
    autonomousReady({ draft: { renderedDigest: "b".repeat(64) } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a template that did not prove its approval is not a template", () => {
  const decision = guardDraft(
    autonomousReady({
      templates: [
        {
          templateId: "template.compare",
          approvedDigest: null,
          slotsFromRegistry: true,
        },
      ],
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("new_copy"));
});

test("a template with a slot filled from free text is not a template", () => {
  const decision = guardDraft(
    autonomousReady({
      templates: [
        {
          templateId: "template.compare",
          approvedDigest: TEMPLATE_DIGEST,
          slotsFromRegistry: false,
        },
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
  assert.equal(decision.templateDigest, TEMPLATE_DIGEST);
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

test("a stored Australian price is an approval rather than a refusal", () => {
  // §7.4: an Australian price post is always a person's decision, even when
  // every field behind it is stored.
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
            usedBefore: true,
          },
        ],
        assets: [],
      },
    }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("australian_price"));
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

test("a number with no claim behind it goes to a person, not to a refusal", () => {
  // §7.2 rule 8: what cannot be verified is an approval. The failure is the
  // extraction's, and a person can read the sentence.
  const decision = guardDraft(
    input({ draft: { renderedText: "Compare answers from 3 models for $20 a month." } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("undeclared_fact"));
});

test("RedNote is an approval whatever the post says", () => {
  const decision = guardDraft(
    autonomousReady({ context: { channelAlwaysApproves: true } }),
  );
  assert.equal(decision.verdict, "approval_required");
  assert.ok(decision.codes.includes("rednote_channel"));
});

test("a template is checked once, when it is approved", () => {
  // §7.2. Otherwise a rule added later would silently stop applying to the
  // posts that matter most.
  const decision = guardTemplateForApproval(
    { renderedText: "The best model, guaranteed.", locale: "en", channel: "linkedin" },
    { claims: [], assets: [] },
    context({ priceFallbackAlertReady: true }),
  );
  assert.equal(decision.verdict, "reject");
  assert.ok(decision.codes.includes("banned_claim"));
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
  collect(guardDraft(input({ draft: { renderedText: "The best model." } })));
  collect(
    guardDraft(input({ draft: { renderedText: "Start free today with no limits." } })),
  );
  for (const claim of [
    { claimId: "a", type: "pricing", known: true, priceSourcesAllStored: false, usedBefore: true },
    { claimId: "b", type: "model", known: true, modelMatches: false, usedBefore: true },
    { claimId: "c", type: "feature", known: true, featurePublic: false, usedBefore: true },
    { claimId: "d", type: "comparison", known: true, comparisonEvidence: false, usedBefore: true },
    { claimId: "e", type: "feature", known: false, usedBefore: true },
  ]) {
    collect(guardDraft(input({ facts: { claims: [claim], assets: [] } })));
  }
  collect(
    guardDraft(
      input({ facts: { claims: [], assets: [{ assetId: "x", known: false, usedBefore: true }] } }),
    ),
  );

  assert.deepEqual([...reached].sort(), [...MARKETING_REJECT_CODES].sort());
});
