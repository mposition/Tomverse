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
  marketingGuardDraftDigest,
  MARKETING_TEMPLATE_PROOF_MAX_AGE_MS,
  marketingTemplateWriteConditions,
  MARKETING_REJECT_CODES,
  guardDraft,
  guardTemplateForApproval,
  sealMarketingTemplateProof,
} from "../lib/marketingGuardCore.ts";

const TEMPLATE_TEXT = "Three answers to one question, side by side.";
const CHANNEL_ID = "chn_linkedin_en";

const TEMPLATE_DIGEST = createHash("sha256")
  .update(TEMPLATE_TEXT, "utf8")
  .digest("hex");

const context = (overrides = {}) => ({
  priceFallbackAlertReady: false,
  incidentOrSecurity: "proved_false",
  testimonial: "proved_false",
  legalOrPolicy: "proved_false",
  ...overrides,
});

const input = (overrides = {}) => ({
  draft: {
    renderedText: "Three answers to one question, side by side.",
    locale: "en",
    channel: "linkedin",
    channelId: CHANNEL_ID,
    claimIds: [],
    assetIds: [],
    ...(overrides.draft ?? {}),
  },
  facts: { claims: [], assets: [], ...(overrides.facts ?? {}) },
  templates: overrides.templates ?? [],
  context: context(overrides.context),
});

/** A draft that would be autonomous if every other input allowed it. */
const autonomousReady = (overrides = {}) => {
  const facts = {
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
  };
  return input({
    draft: {
      templateId: "template.compare",
      renderedText: TEMPLATE_TEXT,
      // Derived, because the Guard refuses a draft whose declared ids are not
      // the facts it was given -- which is the point of that check.
      claimIds: facts.claims.map((claim) => claim.claimId),
      assetIds: facts.assets.map((asset) => asset.assetId),
      ...(overrides.draft ?? {}),
    },
    facts,
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
        approvedDigest: TEMPLATE_DIGEST,
        slotsFromRegistry: true,
        // The ids the loader read off the approved post. The Guard compares
        // the draft's against these rather than against facts from the same
        // caller, which is what closes the "empty claim list" hole.
        claimIds: facts.claims.map((claim) => claim.claimId),
        assetIds: facts.assets.map((asset) => asset.assetId),
      }),
    ],
    context: { priceFallbackAlertReady: true, ...(overrides.context ?? {}) },
  });
};

test("a reject beats an approval, whatever else is true", () => {
  // Precedence is the shape of the whole function: one refused rule is
  // enough, and the approval reasons beside it do not soften it.
  const decision = guardDraft(
    input({
      draft: { renderedText: "The best workspace, guaranteed." },
      context: { incidentOrSecurity: "proved_true", testimonial: "proved_true" },
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
  // The digest is computed here from the text, so "does not match" means the
  // words changed -- not that a caller supplied a different number.
  const decision = guardDraft(
    autonomousReady({ draft: { renderedText: "Completely different words." } }),
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
    autonomousReady({ draft: { channel: "rednote" } }),
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

  // A declared id with no resolved fact behind it, and the other way round.
  collect(guardDraft(input({ draft: { claimIds: ["claim.undeclared"] } })));

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
  assert.equal(decision.templateBinding.approvedDigest, TEMPLATE_DIGEST);
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
    approvedDigest: TEMPLATE_DIGEST,
    envelopeDigest: TEMPLATE_DIGEST,
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
    assert.equal(decision.verdict, "reject", renderedText);
    assert.ok(decision.codes.includes("free_wording_without_condition"));
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
  assert.equal(wrongClaim.verdict, "reject", JSON.stringify(wrongClaim));
  assert.ok(wrongClaim.codes.includes("free_wording_without_condition"));

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
  assert.equal(notRendered.verdict, "reject", JSON.stringify(notRendered));
  assert.ok(notRendered.codes.includes("free_wording_without_condition"));

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
  assert.equal(acrossASentence.verdict, "reject", JSON.stringify(acrossASentence));
  assert.ok(acrossASentence.codes.includes("free_wording_without_condition"));
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
