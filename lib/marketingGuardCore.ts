/**
 * What may be published, what needs a person, and what is refused.
 *
 * Contract: docs/policy/marketing-automation.md §7, and the S1 plan's S1f
 * section with its B2 amendments. This is the decision; the data it decides
 * against is in `lib/marketingGuardRules.ts`, and the facts it checks a claim
 * against come from `lib/marketingFactSources.ts`.
 *
 * Three verdicts, and the precedence between them is the whole shape:
 *
 * 1. any reject rule fires -> `reject`;
 * 2. else any approval reason applies -> `approval_required`;
 * 3. else `autonomous_eligible`, which is reachable only through a template.
 *
 * **Free copy is never autonomous.** Not "usually not" -- there is no input a
 * draft can carry that makes new words publishable without a person. The third
 * verdict requires the rendered text to hash to the digest a proved template
 * carries, with every slot filled from a registry id, and every claim and asset
 * already used on this account.
 *
 * **What the Guard decides for itself, and what it is told.** An earlier
 * version took the §7.4 categories as plain booleans, so a caller passing
 * `false` published a price post without a person. Everything derivable is
 * derived here -- the channel from the draft, the price and comparison
 * categories from the resolved claim types, "free" from the folded text -- and
 * the few categories that need a reader are three-valued, where "not checked"
 * means approval rather than permission.
 *
 * Pure: no server-only import, no network, no Prisma. Every fact it needs is an
 * input, which is what lets the corpus state a case without a database.
 */

import { createHash } from "node:crypto";

import {
  MARKETING_GUARD_RULES,
  type MarketingGuardRule,
} from "@/lib/marketingGuardRules";
import {
  marketingTermPattern,
  marketingTextForms,
  marketingTextHygiene,
  type MarketingHygieneCode,
} from "@/lib/marketingGuardNormalise";

/** Why a draft is refused. Closed, because a post records the code. */
export const MARKETING_REJECT_CODES = Object.freeze([
  "hygiene",
  "banned_claim",
  "price_source_not_stored",
  "au_price_gst_unverifiable",
  "free_wording_without_condition",
  "model_claim_false",
  "feature_not_public",
  "comparison_without_evidence",
  "claim_unknown",
  "claim_type_unknown",
  "claim_not_declared",
  "asset_unknown",
] as const);
export type MarketingRejectCode = (typeof MARKETING_REJECT_CODES)[number];

/** Why a draft needs a person. Closed, for the same reason. */
export const MARKETING_APPROVAL_CODES = Object.freeze([
  "new_copy",
  "first_use_of_claim",
  "first_use_of_asset",
  "competitor_named",
  "price_or_promotion",
  "australian_price",
  "incident_or_security",
  "testimonial",
  "legal_or_policy",
  "rednote_channel",
  "undeclared_fact",
  "category_unreadable",
  "alert_path_not_ready",
] as const);
export type MarketingApprovalCode = (typeof MARKETING_APPROVAL_CODES)[number];

/** The claim kinds §7.2 knows how to check. Anything else fails closed. */
export const MARKETING_CLAIM_KINDS = Object.freeze([
  "pricing",
  "plan",
  "model",
  "feature",
  "availability",
  "comparison",
] as const);
export type MarketingClaimKind = (typeof MARKETING_CLAIM_KINDS)[number];

/**
 * A category a reader has to determine, in three states.
 *
 * `unreadable` is not a synonym for `no`. An earlier version took booleans, and
 * a caller that had not looked passed `false` -- which published a post about
 * an incident without a person. Whatever nobody checked goes to the approval
 * queue, which is §7.2 rule 8 applied to §7.4.
 */
export type MarketingCategoryVerdict = "proved_true" | "proved_false" | "unreadable";

export type MarketingGuardDecision =
  | { verdict: "reject"; codes: MarketingRejectCode[]; ruleIds: string[] }
  | {
      verdict: "approval_required";
      codes: MarketingApprovalCode[];
      ruleIds: string[];
    }
  | {
      verdict: "autonomous_eligible";
      templateId: string;
      templateDigest: string;
      ruleIds: string[];
    };

/**
 * A claim the draft declares, already resolved against the registries.
 *
 * The Guard does not look claims up: `lib/marketingClaims.ts` owns the registry
 * and refuses to be handed another one, so the caller resolves and passes the
 * answer. That also means the corpus can state "a pricing claim whose fields
 * are not all stored" without a billing table.
 */
export type MarketingGuardClaimFact = {
  readonly claimId: string;
  /** Checked against the closed list; an unrecognised kind is refused. */
  readonly type: string;
  /** `false` when the claim id is not in the registry at all. */
  readonly known: boolean;
  /** For `pricing` and `plan`: whether every field it uses is `stored`. */
  readonly priceSourcesAllStored?: boolean;
  /** For a price claim: the stored currency. */
  readonly currency?: string;
  readonly targetsAustralia?: boolean;
  /** For `model`: the runtime row agreed with the claim. */
  readonly modelMatches?: boolean;
  /** For `feature` and `availability`: the gate is on and the evidence resolves. */
  readonly featurePublic?: boolean;
  /** For `comparison`: a URL and a scope were recorded. */
  readonly comparisonEvidence?: boolean;
  /** Whether this account has published this claim before. */
  readonly usedBefore: boolean;
};

export type MarketingGuardAssetFact = {
  readonly assetId: string;
  readonly known: boolean;
  readonly usedBefore: boolean;
};

export type MarketingGuardDraft = {
  /** What the post will say. The only text the Guard reads. */
  readonly renderedText: string;
  readonly locale: string;
  readonly channel: string;
  /** The ids the draft declares. Checked against the resolved facts. */
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  /** The template this text claims to render, if any. Checked, not believed. */
  readonly templateId?: string;
};

/**
 * A template the loader proved, sealed so it cannot be assembled by a caller.
 *
 * `lib/marketingTemplates.ts` walks the approval chain and mints this; the
 * Guard accepts nothing else. Two earlier versions were not enough, and both
 * failures are worth keeping written down:
 *
 * - a plain object, so a caller supplying `{ approvedDigest: <sha256 of my own
 *   text>, slotsFromRegistry: true }` published whatever it liked;
 * - a `WeakSet` with an **exported** factory, which proves the object was made
 *   by this function and says nothing about who called it. The review put it
 *   plainly: with an exported factory the `WeakSet` alone is not enough.
 *
 * So the call sites are counted by
 * `scripts/check-protected-table-writers.mjs`, the way the repository already
 * restricts who may write an audit row. The seal is what stands between a
 * caller and a publication nobody approved, so who may mint one is a fact the
 * build checks rather than a comment.
 *
 * The proof also carries **what the loader verified**, not just that it did:
 * the claim and asset ids the approved post actually holds. The Guard compares
 * the draft's declared ids against these rather than against another set the
 * same caller supplied, which is how `"Pro costs $20 per month."` with empty
 * claim lists was reaching `autonomous_eligible` with no price check at all.
 */
const sealedProofs = new WeakSet<object>();

declare const TEMPLATE_PROOF_BRAND: unique symbol;

export type MarketingTemplateProof = {
  readonly templateId: string;
  /** The digest the approval chain proved. */
  readonly approvedDigest: string;
  /** Whether every slot was filled from a registry id rather than free text. */
  readonly slotsFromRegistry: boolean;
  /** The claim ids the approved post holds. */
  readonly claimIds: readonly string[];
  /** The asset ids the approved post holds. */
  readonly assetIds: readonly string[];
  readonly [TEMPLATE_PROOF_BRAND]?: true;
};

export function sealMarketingTemplateProof(proof: {
  templateId: string;
  approvedDigest: string;
  slotsFromRegistry: boolean;
  claimIds: readonly string[];
  assetIds: readonly string[];
}): MarketingTemplateProof {
  const sealed = Object.freeze({
    templateId: proof.templateId,
    approvedDigest: proof.approvedDigest,
    slotsFromRegistry: proof.slotsFromRegistry,
    claimIds: Object.freeze([...proof.claimIds]),
    assetIds: Object.freeze([...proof.assetIds]),
  }) as MarketingTemplateProof;
  sealedProofs.add(sealed);
  return sealed;
}

export type MarketingGuardContext = {
  /**
   * Whether the operator alert path for a price-source fallback exists yet.
   *
   * S1 plan, B2 amendment: `draftIntake` and `approvalPublish` require it, so
   * the Guard is not used for real drafts before somebody would hear about a
   * refusal. Its S1 value is `false`, which is why every real draft is at best
   * `approval_required` today.
   */
  readonly priceFallbackAlertReady: boolean;
  /**
   * The §7.4 categories that need a reader rather than a field.
   *
   * Three-valued, and `unreadable` sends the draft to a person. The categories
   * that can be derived -- the channel, prices, competitors -- are derived
   * below and are not here.
   */
  readonly incidentOrSecurity: MarketingCategoryVerdict;
  readonly testimonial: MarketingCategoryVerdict;
  readonly legalOrPolicy: MarketingCategoryVerdict;
};

export type MarketingGuardInput = {
  readonly draft: MarketingGuardDraft;
  readonly facts: {
    readonly claims: readonly MarketingGuardClaimFact[];
    readonly assets: readonly MarketingGuardAssetFact[];
  };
  readonly templates: readonly MarketingTemplateProof[];
  readonly context: MarketingGuardContext;
};

/** §7.4: the channel that always needs a person, read from the draft. */
const ALWAYS_APPROVING_CHANNELS: readonly string[] = Object.freeze(["rednote"]);

/**
 * Patterns that mean the text is asserting a fact.
 *
 * Deliberately crude. The point is not to extract the fact -- that is the
 * generator's job and the claim registry's -- but to notice that one is being
 * stated, which §7.2 rule 8 sends to a person unless a template approval has
 * already checked it.
 */
const FACT_PATTERNS: readonly { source: string; flags: string }[] = Object.freeze(
  [
    Object.freeze({ source: "[$₩¥€£]\\s?\\d", flags: "u" }),
    Object.freeze({
      source: "\\b\\d+(?:[.,]\\d+)?\\s?(?:usd|aud|krw|cny|%)\\b",
      flags: "iu",
    }),
    Object.freeze({
      source: "\\b(?:gpt|claude|gemini|llama|mistral|grok|qwen)\\b",
      flags: "iu",
    }),
    Object.freeze({
      source: "\\b\\d+\\s?(?:x|times)\\s+(?:faster|cheaper|more)\\b",
      flags: "iu",
    }),
  ],
);

/** The credit condition a "free" post has to carry with it (§7.2 rule 4). */
/**
 * Each term with the boundary rule its script needs.
 *
 * "freedom" is not "free" and "creditor" is not "credit", so the English terms
 * are matched as words; Korean and Chinese have no boundaries to match on.
 */
const FREE_CONDITION: readonly (readonly [string, "word" | "substring"])[] =
  Object.freeze([
    Object.freeze(["credit", "word"] as const),
    Object.freeze(["credits", "word"] as const),
    Object.freeze(["크레딧", "substring"] as const),
    Object.freeze(["额度", "substring"] as const),
    Object.freeze(["积分", "substring"] as const),
  ]);

const FREE_WORDING: readonly (readonly [string, "word" | "substring"])[] =
  Object.freeze([
    Object.freeze(["free", "word"] as const),
    Object.freeze(["무료", "substring"] as const),
    Object.freeze(["免费", "substring"] as const),
  ]);

const anyTermMatches = (
  forms: readonly string[],
  terms: readonly (readonly [string, "word" | "substring"])[],
): boolean =>
  terms.some(([term, match]) => {
    const pattern = marketingTermPattern(term, match);
    return forms.some((form) => pattern.test(form));
  });

const anyPatternMatches = (
  forms: readonly string[],
  patterns: readonly { source: string; flags: string }[],
): boolean =>
  patterns.some((entry) => {
    const expression = new RegExp(entry.source, entry.flags);
    return forms.some((form) => expression.test(form));
  });

/**
 * Whether a rule fires on any of the folded forms.
 *
 * Every variant, whatever the draft's locale claims: a Korean draft can carry
 * an English ban word, and the locale field is the author's assertion rather
 * than a fact about the bytes.
 */
const ruleFires = (rule: MarketingGuardRule, forms: readonly string[]): boolean => {
  // An exception is a longer string that contains a term and is not the claim.
  // Removed from the forms before matching, so 최고기온 stops 최고 firing while
  // "최고기온과 최고 모델" still fires on the second one.
  const cleaned = forms.map((form) =>
    rule.exceptions.reduce((text, exception) => {
      const pattern = marketingTermPattern(exception, "substring");
      return text.replace(new RegExp(pattern.source, "gu"), " ");
    }, form),
  );

  for (const term of rule.terms) {
    const pattern = marketingTermPattern(term.text, term.match);
    if (cleaned.some((form) => pattern.test(form))) return true;
  }

  if (anyPatternMatches(cleaned, rule.patterns)) return true;

  // Every form, not just the readable one. The memory detector is
  // sentence-aware and reads the text as a person would, but "We cl0ne your
  // memories." is a person's sentence too once the digit is folded -- and an
  // earlier version handed the detector only `forms[0]`, so it was not.
  return rule.detectors.some((detector) =>
    forms.some((form) => detector(form)),
  );
};

const uniqueInOrder = <T>(values: readonly T[]): T[] => [...new Set(values)];

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The decision.
 *
 * Collects every reason rather than stopping at the first: an operator
 * rewriting a refused draft wants all of them, and a post records the whole
 * list.
 */
export function guardDraft(input: MarketingGuardInput): MarketingGuardDecision {
  const { draft, facts, templates, context } = input;

  const rejectCodes: MarketingRejectCode[] = [];
  const approvalCodes: MarketingApprovalCode[] = [];
  const ruleIds: string[] = [];

  // --- 1. the bytes -------------------------------------------------------
  const hygiene: MarketingHygieneCode[] = marketingTextHygiene(draft.renderedText);
  if (hygiene.length > 0) {
    rejectCodes.push("hygiene");
    ruleIds.push(...hygiene.map((code) => `hygiene.${code}`));
  }

  // --- 2. what it says ----------------------------------------------------
  const forms = marketingTextForms(draft.renderedText);
  for (const rule of MARKETING_GUARD_RULES) {
    if (ruleFires(rule, forms)) {
      rejectCodes.push("banned_claim");
      ruleIds.push(rule.id);
    }
  }

  // --- 3. the ids the draft declares are the facts it was given -----------
  // An earlier version never read `claimIds` at all, so a draft could declare
  // a claim nobody resolved and publish it.
  const resolvedClaimIds = facts.claims.map((claim) => claim.claimId);
  const resolvedAssetIds = facts.assets.map((asset) => asset.assetId);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));

  if (!sameSet([...draft.claimIds], resolvedClaimIds)) {
    rejectCodes.push("claim_not_declared");
    ruleIds.push("claim.set-mismatch");
  }
  if (!sameSet([...draft.assetIds], resolvedAssetIds)) {
    rejectCodes.push("claim_not_declared");
    ruleIds.push("asset.set-mismatch");
  }

  // --- 4. the claims ------------------------------------------------------
  for (const claim of facts.claims) {
    if (!claim.known) {
      rejectCodes.push("claim_unknown");
      ruleIds.push(`claim.${claim.claimId}`);
      continue;
    }

    if (!(MARKETING_CLAIM_KINDS as readonly string[]).includes(claim.type)) {
      // Fail closed: a kind §7.2 has no check for is a kind nothing checked.
      rejectCodes.push("claim_type_unknown");
      ruleIds.push(`claim.${claim.claimId}`);
      continue;
    }

    if (claim.type === "pricing" || claim.type === "plan") {
      if (claim.priceSourcesAllStored !== true) {
        rejectCodes.push("price_source_not_stored");
        ruleIds.push(`claim.${claim.claimId}`);
      } else if (claim.targetsAustralia === true) {
        // S1 plan, B2 amendment: an Australian price needs a stored AUD amount
        // *and* a stored flag proving the displayed price includes GST.
        //
        // Unconditional, and it takes no argument that could lift it. An
        // earlier version accepted a `gstInclusiveStored` boolean from the
        // caller -- a stored proof of something `billingPriceCatalogSchema`
        // has no field for, which `lib/marketingFactSources.ts` says in as
        // many words. When the catalogue gains a typed field, its reader and
        // this branch change in one commit.
        rejectCodes.push("au_price_gst_unverifiable");
        ruleIds.push(`claim.${claim.claimId}`);
      }
      approvalCodes.push("price_or_promotion");
    }

    if (claim.type === "model" && claim.modelMatches !== true) {
      rejectCodes.push("model_claim_false");
      ruleIds.push(`claim.${claim.claimId}`);
    }

    if (
      (claim.type === "feature" || claim.type === "availability") &&
      claim.featurePublic !== true
    ) {
      rejectCodes.push("feature_not_public");
      ruleIds.push(`claim.${claim.claimId}`);
    }

    if (claim.type === "comparison") {
      if (claim.comparisonEvidence !== true) {
        rejectCodes.push("comparison_without_evidence");
        ruleIds.push(`claim.${claim.claimId}`);
      } else {
        approvalCodes.push("competitor_named");
      }
    }

    if (!claim.usedBefore) approvalCodes.push("first_use_of_claim");
  }

  for (const asset of facts.assets) {
    if (!asset.known) {
      rejectCodes.push("asset_unknown");
      ruleIds.push(`asset.${asset.assetId}`);
      continue;
    }
    if (!asset.usedBefore) approvalCodes.push("first_use_of_asset");
  }

  // --- 5. "free" needs its condition in the same post ---------------------
  // Checked on the folded forms, so "frее" with Cyrillic е is the same word.
  // §7.4 lists "무료" among the categories that always need a person, so the
  // word is an approval whether or not its condition is there. An earlier
  // version only refused the unconditional case, which made
  // "Start free with monthly credits included." autonomous.
  if (anyTermMatches(forms, FREE_WORDING)) {
    approvalCodes.push("price_or_promotion");
    if (!anyTermMatches(forms, FREE_CONDITION)) {
      rejectCodes.push("free_wording_without_condition");
      ruleIds.push("rule.free-wording");
    }
  }

  // --- 6. §7.4 ------------------------------------------------------------
  // Derived from the draft rather than taken on trust.
  if (ALWAYS_APPROVING_CHANNELS.includes(draft.channel.toLowerCase())) {
    approvalCodes.push("rednote_channel");
  }
  for (const [verdict, code] of [
    [context.incidentOrSecurity, "incident_or_security"],
    [context.testimonial, "testimonial"],
    [context.legalOrPolicy, "legal_or_policy"],
  ] as const) {
    // Exhaustive, and the default is the approval queue. `undefined`, a
    // missing field and a string nobody defined are all "not checked", and an
    // earlier version let every one of them through as though it were
    // `proved_false` -- so a caller who passed nothing at all published.
    switch (verdict) {
      case "proved_true":
        approvalCodes.push(code);
        break;
      case "proved_false":
        break;
      case "unreadable":
      default:
        approvalCodes.push("category_unreadable");
        break;
    }
  }

  // --- 7. the verdict -----------------------------------------------------
  if (rejectCodes.length > 0) {
    return {
      verdict: "reject",
      codes: uniqueInOrder(rejectCodes),
      ruleIds: uniqueInOrder(ruleIds),
    };
  }

  const named = draft.templateId
    ? templates.find((entry) => entry.templateId === draft.templateId)
    : undefined;

  // The seal, the slots, a digest this function computed from the text it was
  // given, and the ids the loader read off the approved post. An earlier
  // version compared two values the caller supplied, and the version after
  // that compared the draft's ids against facts from the same caller.
  const templateStands =
    !!named &&
    sealedProofs.has(named) &&
    named.slotsFromRegistry &&
    named.approvedDigest === sha256(draft.renderedText) &&
    sameSet([...draft.claimIds], [...named.claimIds]) &&
    sameSet([...draft.assetIds], [...named.assetIds]);

  if (!templateStands) approvalCodes.push("new_copy");

  // A fact stated in free copy goes to a person. For a proved template the
  // same check ran when the template was approved, which is §7.2's "템플릿은
  // 템플릿 승인 시".
  if (!templateStands && anyPatternMatches(forms, FACT_PATTERNS)) {
    approvalCodes.push("undeclared_fact");
  }

  // `!== true` rather than `!`: the string "false" is truthy, and a
  // configuration read that produced one would have switched the gate off.
  if (context.priceFallbackAlertReady !== true) {
    approvalCodes.push("alert_path_not_ready");
  }

  if (approvalCodes.length > 0) {
    return {
      verdict: "approval_required",
      codes: uniqueInOrder(approvalCodes),
      ruleIds: uniqueInOrder(ruleIds),
    };
  }

  return {
    verdict: "autonomous_eligible",
    templateId: named!.templateId,
    templateDigest: named!.approvedDigest,
    ruleIds: uniqueInOrder(ruleIds),
  };
}

/**
 * The same checks, run once when a template is approved (§7.2).
 *
 * A template is approved words, and the words are checked then rather than on
 * every post that renders them -- otherwise a rule added later would silently
 * stop applying to the posts that matter most, and the fact patterns would
 * never be checked at all for a template rendering.
 */
export function guardTemplateForApproval(
  template: {
    readonly renderedText: string;
    readonly locale: string;
    readonly channel: string;
  },
  facts: MarketingGuardInput["facts"],
  context: MarketingGuardContext,
): MarketingGuardDecision {
  return guardDraft({
    draft: {
      renderedText: template.renderedText,
      locale: template.locale,
      channel: template.channel,
      claimIds: facts.claims.map((claim) => claim.claimId),
      assetIds: facts.assets.map((asset) => asset.assetId),
    },
    facts,
    templates: [],
    context,
  });
}
