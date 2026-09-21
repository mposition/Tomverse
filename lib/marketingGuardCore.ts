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
 * Pure but for one clock read. No server-only import, no network, no Prisma:
 * every fact it needs is an input, which is what lets the corpus state a case
 * without a database. The exception is `Date.now()`, which bounds how old a
 * template proof may be -- taken here rather than as an argument, because a
 * caller that could set the time could set it forward.
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
      /**
       * The row state this decision was made against.
       *
       * A decision is about a template as it stood when the loader read it, and
       * the publish that follows happens later. Whoever writes the post has to
       * make its own write conditional on every field here -- the same id, the
       * same channel, the same approved digest, the same `historyVersion`, and
       * still `reusableAsTemplate` -- so an edit or an un-marking that landed
       * in between turns the write into nought rows rather than into a post
       * nobody approved.
       */
      templateBinding: MarketingTemplateBinding;
      ruleIds: string[];
    };

/** What a publish has to re-check about the template it is rendering. */
export type MarketingTemplateBinding = {
  readonly templateId: string;
  readonly channelId: string;
  readonly locale: string;
  readonly approvedDigest: string;
  readonly historyVersion: number;
  readonly reusableAsTemplate: true;
  /** When the loader proved the row, and when that stops being worth anything. */
  readonly provenAt: number;
  readonly expiresAt: number;
};

/**
 * What a publish has to do with a binding, rather than a suggestion that it
 * should.
 *
 * The age bound on the proof stops a *proof* being kept; it did nothing about
 * the decision, which carried the same permission with no expiry on it at all.
 * So the binding carries its own, and this is the only way to turn one into a
 * write: it refuses an expired binding and otherwise returns the `where`
 * fragment the update has to carry.
 *
 * `now` is an argument because the only clock worth reading here is the
 * database's, in the transaction doing the write. A caller that passes its own
 * is comparing against a clock nobody agreed on, which is the failure this is
 * about; `lib/marketingStore.ts` reads it from the database when the publish
 * route exists.
 */
export type MarketingTemplateWriteConditions =
  | { ok: true; where: Record<string, unknown> }
  | { ok: false; refusal: "binding_expired" };

export function marketingTemplateWriteConditions(
  binding: MarketingTemplateBinding,
  now: Date,
): MarketingTemplateWriteConditions {
  const at = now.getTime();
  if (!Number.isFinite(at) || at > binding.expiresAt || at < binding.provenAt) {
    return { ok: false, refusal: "binding_expired" };
  }
  return {
    ok: true,
    where: {
      id: binding.templateId,
      channelId: binding.channelId,
      locale: binding.locale,
      approvedDigest: binding.approvedDigest,
      envelopeDigest: binding.approvedDigest,
      historyVersion: binding.historyVersion,
      reusableAsTemplate: true,
    },
  };
}

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
  /**
   * For `plan`: whether this claim is the credit allowance itself.
   *
   * §7.2 rule 4 wants the condition a "free" post carries, and the condition
   * is the allowance -- not any price claim that happens to be in the same
   * post. An earlier version accepted one, so "Start free. Credits never run
   * out. Pro costs AUD 20 per month." passed on the strength of a claim about
   * the Pro price. `lib/marketingClaims.ts` sets this from the registry entry.
   */
  readonly statesCreditAllowance?: boolean;
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
  /**
   * The connected account this post is for: `MarketingChannel.id`.
   *
   * A template is approved for one account, in one language. Without this the
   * Guard compared a digest and nothing else, so an approval given for the
   * LinkedIn English account published the same words from the zh-Hant
   * Instagram one -- a different audience, a different jurisdiction and a
   * different graduation record.
   */
  readonly channelId: string;
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
  /** The account the approval was given for. */
  readonly channelId: string;
  /**
   * The platform that account posts to, read off the account row.
   *
   * Sealed as well as the id, because the id alone did not stop the *kind* of
   * channel being misreported: a real RedNote proof presented with
   * `channel: "linkedin"` went autonomous, and RedNote is a channel §7.4 says
   * always needs a person.
   */
  readonly channel: string;
  /** The language it was given in. */
  readonly locale: string;
  /** The row revision the loader read, carried into the decision's binding. */
  readonly historyVersion: number;
  /** When the loader proved it. Stamped here, never supplied. */
  readonly provenAt: number;
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
  channelId: string;
  channel: string;
  locale: string;
  historyVersion: number;
  approvedDigest: string;
  slotsFromRegistry: boolean;
  claimIds: readonly string[];
  assetIds: readonly string[];
}): MarketingTemplateProof {
  const sealed = Object.freeze({
    templateId: proof.templateId,
    channelId: proof.channelId,
    channel: proof.channel,
    locale: proof.locale,
    historyVersion: proof.historyVersion,
    // Read here rather than taken as an argument. A caller that could set it
    // could set it forward, and the age bound is the only thing between a
    // proof and a caller that kept one from last month.
    provenAt: Date.now(),
    approvedDigest: proof.approvedDigest,
    slotsFromRegistry: proof.slotsFromRegistry,
    claimIds: Object.freeze([...proof.claimIds]),
    assetIds: Object.freeze([...proof.assetIds]),
  }) as MarketingTemplateProof;
  sealedProofs.add(sealed);
  return sealed;
}

/**
 * How long a proof is worth anything.
 *
 * A proof is evidence about a database row at the moment it was read, and the
 * row can be edited or un-marked a second later. The binding on the decision is
 * what makes the publish conditional on the row *not* having moved; this is
 * what stops a proof being kept. A minute is long enough for a draft to be
 * rendered and decided in the same request and short enough that "I have a
 * proof" is never a stored capability.
 */
export const MARKETING_TEMPLATE_PROOF_MAX_AGE_MS = 60_000;

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
      source: "\\b\\d+(?:[.,]\\d+)?\\s?(?:usd|aud|krw|cny)\\b",
      flags: "iu",
    }),
    // A percentage on its own, without the trailing boundary. `\\b` after `%`
    // needs a word character next to it, so "Save 20% today." was not a stated
    // figure and "20%off" was.
    Object.freeze({
      source: "\\b\\d+(?:[.,]\\d+)?\\s?%",
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
    // Traditional. The zh-Hant accounts write 免費, and a list holding only the
    // Simplified spelling read 免費使用，每月包含積分 as copy with no price in
    // it at all.
    Object.freeze(["免費", "substring"] as const),
  ]);

/**
 * §7.4: a price or a promotion, read off the words rather than off a claim.
 *
 * The claim types say what the draft *declared*. They say nothing about a
 * sentence that states a discount and declares nothing, which is how "Save 20%
 * with our September discount." and "Our September promotion is live." reached
 * `autonomous_eligible` with empty id lists: the category was derived from the
 * declarations, and there were none.
 */
const PROMOTION_WORDING: readonly (readonly [string, "word" | "substring"])[] =
  Object.freeze([
    Object.freeze(["discount", "word"] as const),
    Object.freeze(["discounts", "word"] as const),
    Object.freeze(["discounted", "word"] as const),
    Object.freeze(["promo", "word"] as const),
    Object.freeze(["promotion", "word"] as const),
    Object.freeze(["promotional", "word"] as const),
    Object.freeze(["coupon", "word"] as const),
    Object.freeze(["voucher", "word"] as const),
    Object.freeze(["sale", "word"] as const),
    Object.freeze(["price drop", "word"] as const),
    Object.freeze(["할인", "substring"] as const),
    Object.freeze(["프로모션", "substring"] as const),
    Object.freeze(["특가", "substring"] as const),
    Object.freeze(["쿠폰", "substring"] as const),
    Object.freeze(["优惠", "substring"] as const),
    Object.freeze(["優惠", "substring"] as const),
    Object.freeze(["折扣", "substring"] as const),
    Object.freeze(["促销", "substring"] as const),
    Object.freeze(["促銷", "substring"] as const),
    Object.freeze(["特价", "substring"] as const),
    Object.freeze(["特價", "substring"] as const),
  ]);

/**
 * §7.4: another product named, read off the words for the same reason.
 *
 * "Compare ChatGPT and Claude side by side." names two competitors and
 * declares no comparison claim. The comparison *claim* check is about evidence;
 * this is about the category, and they are different questions.
 */
const COMPETITOR_NAMES: readonly (readonly [string, "word" | "substring"])[] =
  Object.freeze([
    Object.freeze(["chatgpt", "word"] as const),
    Object.freeze(["openai", "word"] as const),
    Object.freeze(["claude", "word"] as const),
    Object.freeze(["anthropic", "word"] as const),
    Object.freeze(["gemini", "word"] as const),
    // Branded spellings only. "copilot" on its own is an ordinary noun --
    // "Use Tomverse as your research copilot." names no competitor -- and a
    // rule that sent that to a person would make the approval queue the only
    // outcome for ordinary copy.
    Object.freeze(["github copilot", "word"] as const),
    Object.freeze(["microsoft copilot", "word"] as const),
    Object.freeze(["perplexity", "word"] as const),
    Object.freeze(["deepseek", "word"] as const),
    Object.freeze(["midjourney", "word"] as const),
    Object.freeze(["mistral", "word"] as const),
    Object.freeze(["챗지피티", "substring"] as const),
    Object.freeze(["제미나이", "substring"] as const),
    Object.freeze(["클로드", "substring"] as const),
    Object.freeze(["코파일럿", "substring"] as const),
    Object.freeze(["퍼플렉시티", "substring"] as const),
  ]);

/**
 * Compounds that contain "free" and are not about a price.
 *
 * Removed from the forms before the free-wording check, the way a rule's
 * exceptions are removed before its terms run. "Use free-form prompts to
 * describe the task." was refused for stating a price it does not state.
 */
const FREE_COMPOUNDS: readonly string[] = Object.freeze([
  "free form",
  "freeform",
  "free flowing",
  "hands free",
  "barrier free",
  "free rein",
  "carefree",
  "free text",
]);

const withoutFreeCompounds = (forms: readonly string[]): string[] =>
  forms.map((form) =>
    FREE_COMPOUNDS.reduce((text, compound) => {
      const pattern = marketingTermPattern(compound, "substring");
      return text.replace(new RegExp(pattern.source, "gu"), " ");
    }, form),
  );

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
  const cleanedOfFreeCompounds = withoutFreeCompounds(forms);
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
  //
  // The condition has to be a *claim*, not a word. An earlier version accepted
  // the token "credits" appearing anywhere in the post, so "Start free. Credits
  // never run out." and "Free forever; credits power the service." both passed
  // -- the first says the opposite of the limit it was supposed to state and
  // the second states nothing at all. What §7.2 rule 4 wants is the allowance,
  // and an allowance is a resolved pricing or plan claim.
  const freeCondition = facts.claims.some(
    (claim) =>
      claim.known &&
      claim.type === "plan" &&
      claim.priceSourcesAllStored === true &&
      claim.statesCreditAllowance === true,
  );
  if (anyTermMatches(cleanedOfFreeCompounds, FREE_WORDING)) {
    approvalCodes.push("price_or_promotion");
    if (!freeCondition || !anyTermMatches(forms, FREE_CONDITION)) {
      rejectCodes.push("free_wording_without_condition");
      ruleIds.push("rule.free-wording");
    }
  }

  // §7.4, derived from the words. A template approval does not exempt these:
  // see the verdict below.
  if (anyTermMatches(forms, PROMOTION_WORDING)) {
    approvalCodes.push("price_or_promotion");
  }
  if (anyTermMatches(forms, COMPETITOR_NAMES)) {
    approvalCodes.push("competitor_named");
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
  // given, the ids the loader read off the approved post, and the scope the
  // approval was actually given in. An earlier version compared two values the
  // caller supplied; the version after that compared the draft's ids against
  // facts from the same caller; the version after *that* compared a digest and
  // nothing else, so one approval covered every account and every language.
  //
  // The age bound is the fifth part. A proof is evidence about a row as it was
  // read, and a proof that could be kept would be a standing permission.
  const templateStands =
    !!named &&
    sealedProofs.has(named) &&
    named.slotsFromRegistry &&
    named.approvedDigest === sha256(draft.renderedText) &&
    named.channelId === draft.channelId &&
    named.channel === draft.channel &&
    named.locale === draft.locale &&
    Date.now() - named.provenAt <= MARKETING_TEMPLATE_PROOF_MAX_AGE_MS &&
    Date.now() >= named.provenAt &&
    sameSet([...draft.claimIds], [...named.claimIds]) &&
    sameSet([...draft.assetIds], [...named.assetIds]);

  if (!templateStands) approvalCodes.push("new_copy");

  // A stated fact goes to a person, template or not.
  //
  // An earlier version skipped this for a proved template, reasoning that the
  // same check ran at approval. It does -- but the check that ran at approval
  // is this one, and skipping it here meant the *only* reading of the words
  // was the one that happened before the rules were last changed. Worse, the
  // §7.4 categories above are derived from the words too, and a template
  // rendering that skipped them published a discount with nobody looking.
  // §7.4 says these categories always need a person; "always" includes a
  // template.
  if (anyPatternMatches(forms, FACT_PATTERNS)) {
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
    templateBinding: {
      templateId: named!.templateId,
      channelId: named!.channelId,
      locale: named!.locale,
      approvedDigest: named!.approvedDigest,
      historyVersion: named!.historyVersion,
      reusableAsTemplate: true,
      provenAt: named!.provenAt,
      expiresAt: named!.provenAt + MARKETING_TEMPLATE_PROOF_MAX_AGE_MS,
    },
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
    readonly channelId: string;
  },
  facts: MarketingGuardInput["facts"],
  context: MarketingGuardContext,
): MarketingGuardDecision {
  return guardDraft({
    draft: {
      renderedText: template.renderedText,
      locale: template.locale,
      channel: template.channel,
      channelId: template.channelId,
      claimIds: facts.claims.map((claim) => claim.claimId),
      assetIds: facts.assets.map((asset) => asset.assetId),
    },
    facts,
    templates: [],
    context,
  });
}
