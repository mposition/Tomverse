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
 * verdict requires the rendered text to be the server's rendering of a template
 * an approved chain proves, with every slot filled from a registry id, and
 * every claim and asset already used on this account. A draft that says it is
 * safe is a draft asserting the thing being checked, so `isNewCopy` and
 * anything like it is ignored.
 *
 * Pure: no server-only import, no network, no Prisma. Every fact it needs is an
 * input, which is what lets the corpus state a case without a database.
 */

import {
  MARKETING_GUARD_RULES,
  type MarketingGuardRule,
} from "@/lib/marketingGuardRules";
import {
  foldMarketingRuleText,
  marketingTextHygiene,
  marketingTextVariants,
  type MarketingHygieneCode,
  type MarketingTextVariants,
} from "@/lib/marketingGuardNormalise";

/** Why a draft is refused. Closed, because a post records the code. */
export const MARKETING_REJECT_CODES = Object.freeze([
  "hygiene",
  "banned_claim",
  "price_source_not_stored",
  "free_wording_without_condition",
  "model_claim_false",
  "feature_not_public",
  "comparison_without_evidence",
  "claim_unknown",
  "asset_unknown",
  // No `template_digest_mismatch`: a rendering whose digest does not match the
  // template it names is `approval_required` with `new_copy`, not a refusal.
  // The words may be perfectly good and only their provenance is in doubt, and
  // a person is who settles that. A code nothing produces would describe
  // nothing.
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
  "alert_path_not_ready",
] as const);
export type MarketingApprovalCode = (typeof MARKETING_APPROVAL_CODES)[number];

export type MarketingGuardDecision =
  | {
      verdict: "reject";
      codes: MarketingRejectCode[];
      ruleIds: string[];
    }
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
  readonly type: string;
  /** `false` when the claim id is not in the registry at all. */
  readonly known: boolean;
  /** For `pricing` and `plan`: whether every field it uses is `stored`. */
  readonly priceSourcesAllStored?: boolean;
  /** For a price claim aimed at Australia. */
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
  readonly claimIds: readonly string[];
  readonly assetIds: readonly string[];
  /**
   * The template this text claims to be a rendering of, if any.
   *
   * A claim, not a fact: it is checked against `templates`.
   */
  readonly templateId?: string;
  readonly renderedDigest?: string;
};

export type MarketingGuardTemplateFact = {
  readonly templateId: string;
  /** The digest the approval chain proved. `null` when no template resolved. */
  readonly approvedDigest: string | null;
  /** Whether every slot is filled from a registry id rather than free text. */
  readonly slotsFromRegistry: boolean;
};

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
  /** §7.4: RedNote is always an approval, whatever the post says. */
  readonly channelAlwaysApproves: boolean;
  /** §7.4 categories the caller has already determined about this draft. */
  readonly mentionsCompetitor: boolean;
  readonly mentionsPriceOrPromotion: boolean;
  readonly mentionsIncidentOrSecurity: boolean;
  readonly mentionsTestimonial: boolean;
  readonly mentionsLegalOrPolicy: boolean;
};

export type MarketingGuardInput = {
  readonly draft: MarketingGuardDraft;
  readonly facts: {
    readonly claims: readonly MarketingGuardClaimFact[];
    readonly assets: readonly MarketingGuardAssetFact[];
  };
  readonly templates: readonly MarketingGuardTemplateFact[];
  readonly context: MarketingGuardContext;
};

/**
 * Patterns that mean the text is asserting a fact it has not declared.
 *
 * Deliberately crude. The point is not to extract the fact -- that is the
 * generator's job and the claim registry's -- but to notice that one is being
 * stated with no claim id behind it, which §7.2 rule 8 sends to a person.
 */
const UNDECLARED_FACT_PATTERNS: readonly { source: string; flags: string }[] =
  Object.freeze([
    Object.freeze({ source: "[$₩¥€£]\\s?\\d", flags: "u" }),
    Object.freeze({ source: "\\b\\d+(?:[.,]\\d+)?\\s?(?:usd|aud|krw|cny|%)\\b", flags: "iu" }),
    Object.freeze({ source: "\\b(?:gpt|claude|gemini|llama|mistral|grok|qwen)\\b", flags: "iu" }),
    Object.freeze({ source: "\\b\\d+\\s?(?:x|times)\\s+(?:faster|cheaper|more)\\b", flags: "iu" }),
    Object.freeze({ source: "무료", flags: "u" }),
    Object.freeze({ source: "\\bfree\\b", flags: "iu" }),
  ]);

/** The credit condition a "free" post has to carry with it (§7.2 rule 4). */
const FREE_CONDITION_PATTERNS: readonly { source: string; flags: string }[] =
  Object.freeze([
    Object.freeze({ source: "\\bcredits?\\b", flags: "iu" }),
    Object.freeze({ source: "크레딧", flags: "u" }),
    Object.freeze({ source: "额度|积分", flags: "u" }),
  ]);

const FREE_WORDING: readonly { source: string; flags: string }[] = Object.freeze(
  [
    Object.freeze({ source: "\\bfree\\b", flags: "iu" }),
    Object.freeze({ source: "무료", flags: "u" }),
    Object.freeze({ source: "免费", flags: "u" }),
  ],
);

const matchesAny = (
  text: string,
  patterns: readonly { source: string; flags: string }[],
): boolean =>
  patterns.some((entry) => new RegExp(entry.source, entry.flags).test(text));

/**
 * Whether a rule fires on any of the folded forms.
 *
 * Every variant, whatever the draft's locale claims: a Korean draft can carry
 * an English ban word, and the locale field is the author's assertion rather
 * than a fact about the bytes.
 */
const ruleFires = (
  rule: MarketingGuardRule,
  variants: MarketingTextVariants,
): boolean => {
  const forms = [variants.folded, variants.leet, variants.collapsed];

  // An exception is a longer string that contains a term and is not the claim.
  // Removed from the forms before matching, so 최고기온 stops 최고 firing while
  // "최고기온과 최고 모델" still fires on the second one.
  const cleaned = forms.map((form) =>
    rule.exceptions.reduce(
      (text, exception) =>
        text.split(foldMarketingRuleText(exception).collapsed).join(" "),
      form,
    ),
  );

  for (const term of rule.terms) {
    const needle = foldMarketingRuleText(term.text).collapsed;
    if (!needle) continue;
    const expression =
      term.match === "word"
        ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u")
        : null;
    const hit = cleaned.some((form) =>
      expression ? expression.test(form) : form.includes(needle),
    );
    if (hit) return true;
  }

  for (const entry of rule.patterns) {
    const expression = new RegExp(entry.source, entry.flags);
    // Patterns are written against readable text, so they run on the readable
    // form too: a Korean lookahead does not survive the leet fold.
    if (expression.test(variants.readable)) return true;
    if (cleaned.some((form) => expression.test(form))) return true;
  }

  return false;
};

const uniqueInOrder = <T>(values: readonly T[]): T[] => [...new Set(values)];

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
  const variants = marketingTextVariants(draft.renderedText);
  for (const rule of MARKETING_GUARD_RULES) {
    if (ruleFires(rule, variants)) {
      rejectCodes.push("banned_claim");
      ruleIds.push(rule.id);
    }
  }

  // --- 3. the claims it declares -----------------------------------------
  for (const claim of facts.claims) {
    if (!claim.known) {
      rejectCodes.push("claim_unknown");
      ruleIds.push(`claim.${claim.claimId}`);
      continue;
    }

    if (claim.type === "pricing" || claim.type === "plan") {
      if (claim.priceSourcesAllStored !== true) {
        rejectCodes.push("price_source_not_stored");
        ruleIds.push(`claim.${claim.claimId}`);
      } else if (claim.targetsAustralia === true) {
        // §7.4: an Australian price post is always an approval, even when
        // every field behind it is stored.
        approvalCodes.push("australian_price");
      }
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

  // --- 4. "free" needs its condition in the same post ---------------------
  if (
    matchesAny(variants.readable, FREE_WORDING) &&
    !matchesAny(variants.readable, FREE_CONDITION_PATTERNS)
  ) {
    rejectCodes.push("free_wording_without_condition");
    ruleIds.push("rule.free-wording");
  }

  // --- 5. §7.4, the categories that always need a person -------------------
  if (context.channelAlwaysApproves) approvalCodes.push("rednote_channel");
  if (context.mentionsCompetitor) approvalCodes.push("competitor_named");
  if (context.mentionsPriceOrPromotion) approvalCodes.push("price_or_promotion");
  if (context.mentionsIncidentOrSecurity) {
    approvalCodes.push("incident_or_security");
  }
  if (context.mentionsTestimonial) approvalCodes.push("testimonial");
  if (context.mentionsLegalOrPolicy) approvalCodes.push("legal_or_policy");

  // A fact stated with no claim id behind it. §7.2 rule 8: what cannot be
  // verified goes to the approval queue rather than being refused, because the
  // failure is the extraction's and a person can read the sentence.
  if (
    facts.claims.length === 0 &&
    matchesAny(variants.readable, UNDECLARED_FACT_PATTERNS)
  ) {
    approvalCodes.push("undeclared_fact");
  }

  // --- 6. the verdict -----------------------------------------------------
  if (rejectCodes.length > 0) {
    return {
      verdict: "reject",
      codes: uniqueInOrder(rejectCodes),
      ruleIds: uniqueInOrder(ruleIds),
    };
  }

  const template = draft.templateId
    ? templates.find((entry) => entry.templateId === draft.templateId)
    : undefined;

  // Free copy is at best an approval, and so is a template that did not prove.
  const templateStands =
    !!template &&
    !!template.approvedDigest &&
    template.slotsFromRegistry &&
    !!draft.renderedDigest &&
    draft.renderedDigest === template.approvedDigest;

  if (!templateStands) approvalCodes.push("new_copy");

  // The alert path has to exist before a refusal could be heard about.
  if (!context.priceFallbackAlertReady) {
    approvalCodes.push("alert_path_not_ready");
  }

  if (approvalCodes.length > 0) {
    return {
      verdict: "approval_required",
      codes: uniqueInOrder(approvalCodes),
      ruleIds: uniqueInOrder(ruleIds),
    };
  }

  // Unreachable in S1: nothing writes the audit rows a template needs, and
  // `priceFallbackAlertReady` is false. Both are inputs rather than constants
  // so the corpus can prove the path exists and refuses correctly.
  return {
    verdict: "autonomous_eligible",
    templateId: template!.templateId,
    templateDigest: template!.approvedDigest!,
    ruleIds: uniqueInOrder(ruleIds),
  };
}

/**
 * The same checks, run once when a template is approved (§7.2).
 *
 * A template is approved words, and the words are checked then rather than on
 * every post that renders them -- otherwise a rule added later would silently
 * stop applying to the posts that matter most.
 */
export function guardTemplateForApproval(
  template: { readonly renderedText: string; readonly locale: string; readonly channel: string },
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
