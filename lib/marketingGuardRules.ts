/**
 * The claims a generated marketing post may not make.
 *
 * Contract: docs/policy/marketing-automation.md §7.1, item by item. Each rule
 * carries an id, because the Guard records which rule fired and the corpus
 * meta-test requires a bypass case and a benign case for every id -- a rule
 * nobody has tried to get past is a rule nobody has tested.
 *
 * **Patterns are stored as source and flags, not as `RegExp` objects.** A
 * `RegExp` carries its own mutable matcher: `.compile()` replaces the pattern
 * in place and `Object.freeze` does not stop it, so an exported one is a
 * decision anything sharing this module could change. They are compiled per
 * call instead.
 *
 * **A rule names what the claim is about, rather than matching a word.** 第一
 * is "first" in "第一章" -- chapter one -- and 唯一 is "unique" in "唯一标识符",
 * a unique identifier. Both are ordinary Chinese, and a Guard that refuses
 * ordinary Chinese is a Guard somebody switches off. So the rank and
 * uniqueness rules require the sentence to say what it is first at or unique
 * among, and the age rule does not fire on a notice saying the product is *not*
 * for children.
 *
 * **What this file is not.** It does not decide anything: it is the data, and
 * `lib/marketingGuardCore.ts` is the decision. Keeping them apart is what lets
 * the corpus address a rule by id without knowing how the Guard is wired.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import {
  MARKETING_SUPERLATIVE_EXCEPTIONS,
  MARKETING_SUPERLATIVE_TERMS,
  type MarketingBannedTerm,
} from "@/lib/marketingBannedClaims";
import { findForbiddenMemoryClaims } from "@/lib/marketingMemoryClaims";

/** Which paragraph of §7.1 a rule comes from. */
export const MARKETING_RULE_CATEGORIES = Object.freeze([
  "superlative",
  "guarantee",
  "rank_claim",
  "ai_review_contract",
  "refuted_superiority",
  "china_mainland",
  "australia_urgency",
  "australia_minors",
  "memory_claim",
] as const);

export type MarketingRuleCategory = (typeof MARKETING_RULE_CATEGORIES)[number];

export type MarketingRulePattern = {
  /** `RegExp` source. Compiled per call; see the note above. */
  readonly source: string;
  readonly flags: string;
  readonly language: string;
};

/**
 * A rule that is a function rather than a pattern.
 *
 * One rule needs this. `lib/marketingMemoryClaims.ts` owns what this product
 * may say about account memory, and its detector is sentence-aware: it does not
 * fire on "projects do not share AI memory", which mentions memory in order to
 * deny it. An earlier version copied that module's raw patterns and lost the
 * negation handling with them, so a sentence denying the claim was refused for
 * making it.
 */
export type MarketingRuleDetector = (text: string) => boolean;

export type MarketingGuardRule = {
  readonly id: string;
  readonly category: MarketingRuleCategory;
  /** Every §7.1 rule refuses. The approval categories are §7.4 and live in the core. */
  readonly verdict: "reject";
  /** Literal terms, compiled by the Guard into separator-tolerant patterns. */
  readonly terms: readonly MarketingBannedTerm[];
  readonly patterns: readonly MarketingRulePattern[];
  readonly detectors: readonly MarketingRuleDetector[];
  /** Longer strings that contain a term and are not the claim. */
  readonly exceptions: readonly string[];
};

const pattern = (
  source: string,
  language: string,
  flags = "iu",
): MarketingRulePattern => Object.freeze({ source, flags, language });

const rule = (
  id: string,
  category: MarketingRuleCategory,
  parts: {
    terms?: readonly MarketingBannedTerm[];
    patterns?: readonly MarketingRulePattern[];
    detectors?: readonly MarketingRuleDetector[];
    exceptions?: readonly string[];
  },
): MarketingGuardRule =>
  Object.freeze({
    id,
    category,
    verdict: "reject" as const,
    terms: Object.freeze(parts.terms ? [...parts.terms] : []),
    patterns: Object.freeze(parts.patterns ? [...parts.patterns] : []),
    detectors: Object.freeze(parts.detectors ? [...parts.detectors] : []),
    exceptions: Object.freeze(parts.exceptions ? [...parts.exceptions] : []),
  });

/**
 * §7.1, first item: the repository's ban words, superlatives and comparatives.
 *
 * `better` is refused here without exception. It is in the policy's list, and
 * an earlier version tried to allow the denials -- "no model was a better fit"
 * -- with a negative lookbehind, which then read "Nothing is better than
 * Tomverse" and "No competitor is better than Tomverse" as denials too. Those
 * are the claim stated as strongly as it can be. A generated post has no reason
 * to write the denial, so the Guard refuses the word; the repository's own copy
 * keeps saying it, which is why `MARKETING_SUPERLATIVE_TERMS` does not carry it
 * and `lib/marketingBannedClaims.ts` explains that split.
 */
const SUPERLATIVE = rule("rule.superlative", "superlative", {
  terms: MARKETING_SUPERLATIVE_TERMS,
  patterns: [
    pattern("\\bbetter\\b", "en"),
    pattern("더\\s*나은", "ko"),
    pattern("更好(?!的时光)", "zh"),
  ],
  exceptions: MARKETING_SUPERLATIVE_EXCEPTIONS,
});

const GUARANTEE = rule("rule.guarantee", "guarantee", {
  patterns: [
    pattern("\\bguarantee(?:d|s)?\\b", "en"),
    pattern("\\bwe promise\\b", "en"),
    pattern("\\brisk[- ]free\\b", "en"),
    pattern("보장(?!보험)", "ko"),
    pattern("약속드립니다", "ko"),
    pattern("保证|保障", "zh"),
  ],
});

/**
 * "#1" and every way of writing it.
 *
 * The Chinese pattern names what the claim is first at. 第一 on its own is
 * "first" -- 第一章 is chapter one and 第一次 is the first time -- and a rule
 * that refused it would refuse a sentence explaining how to start.
 */
const RANK_CLAIM = rule("rule.rank-claim", "rank_claim", {
  patterns: [
    pattern("#\\s*1\\b", "en"),
    pattern("\\bno\\.?\\s*1\\b", "en"),
    pattern("\\bnumber one\\b", "en"),
    pattern("\\btop[- ]rated\\b", "en"),
    pattern("1\\s*위", "ko"),
    pattern("업계\\s*1", "ko"),
    pattern("第一(?:的)?\\s*(?:AI|平台|产品|工具|选择|品牌|名)", "zh"),
    pattern("(?:排名|销量|市场)\\s*第一", "zh"),
  ],
});

/**
 * §7.1, second item: the AI Review contract.
 *
 * Four separate claims, and AGENTS.md is explicit about each. Two reviewers
 * existing is not two reviewers agreeing. The second reviewer is chosen as the
 * next candidate with a different model id, so "different providers" is a
 * configuration that may or may not have happened. Source grounding measures
 * whether a quotation appears in the answer it is attributed to, which is not
 * accuracy. And nothing here verifies a fact.
 */
const AI_REVIEW_CONTRACT = rule("rule.ai-review-contract", "ai_review_contract", {
  patterns: [
    pattern("\\bfact[- ]check(?:ed|ing|s)?\\b", "en"),
    pattern("\\bverif(?:ies|ied|y) (?:the )?(?:facts?|accuracy)\\b", "en"),
    pattern("\\b(?:models?|reviewers?) agree(?:d|ment)?\\b", "en"),
    pattern("\\bconsensus\\b", "en"),
    pattern("\\bdifferent providers?\\b", "en"),
    pattern("\\baccuracy (?:score|rating|rate)\\b", "en"),
    pattern("사실\\s*(?:검증|확인)", "ko"),
    pattern("(?:모델|검토자)(?:들)?\\s*(?:가|이)?\\s*합의", "ko"),
    pattern("서로\\s*다른\\s*(?:provider|공급자|제공자)", "ko"),
    pattern("정확도\\s*(?:점수|평가)", "ko"),
    pattern("事实核查|模型达成一致|不同的?(?:提供商|供应商)", "zh"),
  ],
});

/**
 * §7.1, third item: superiority claims with a known counter-example.
 *
 * Each is false and known to be false, which is a different thing from
 * unsupported: there is nothing an approver could check that would make "the
 * only AI that reads HWP" true, so it is refused rather than queued.
 *
 * The Chinese pattern names what the claim is unique among, for the reason the
 * rank rule does: 唯一标识符 is a unique identifier and appears in any sentence
 * about file handling.
 */
const REFUTED_SUPERIORITY = rule("rule.refuted-superiority", "refuted_superiority", {
  patterns: [
    pattern(
      "\\b(?:the )?only (?:ai|assistant|tool|app|service|platform|product|workspace)\\b",
      "en",
    ),
    pattern("\\bfirst (?:and only|ever)\\b", "en"),
    pattern("\\bonly (?:one|place|way) to compare\\b", "en"),
    pattern("\\bonly .{0,30}\\bhwp\\b", "en"),
    pattern("유일(?:한|하게)\\s*(?:AI|도구|서비스|플랫폼|제품)?", "ko"),
    pattern("최초의?\\s*(?:다중|멀티|교차)", "ko"),
    pattern("우리만", "ko"),
    pattern("唯一(?:的)?\\s*(?:AI|工具|平台|产品|服务|选择)", "zh"),
  ],
});

/**
 * §7.1, fourth item: mainland China.
 *
 * A 2026-09-16 legal review decided there is no mainland launch, the WAF blocks
 * mainland traffic, and marketing excludes it. RedNote is kept for overseas
 * Chinese readers in Simplified, which is why the rule is about availability
 * and payment rather than about the language.
 */
const CHINA_MAINLAND = rule("rule.china-mainland", "china_mainland", {
  patterns: [
    pattern("\\bavailable in (?:mainland )?china\\b", "en"),
    pattern("\\bchina (?:launch|available|now live)\\b", "en"),
    pattern("中国大陆(?:可用|上线|开放)", "zh"),
    pattern("(?:支付宝|微信支付|银联)", "zh"),
    pattern("大陆(?:用户)?(?:可|能)(?:注册|订阅|付款)", "zh"),
    pattern("중국\\s*본토(?:에서)?\\s*(?:이용|사용|결제)", "ko"),
  ],
});

/**
 * §7.1, fifth item, first half: manufactured urgency.
 *
 * Australian Consumer Law treats a deadline that is not a deadline as
 * misleading conduct. The rule is about the shape of the sentence rather than
 * about whether a promotion exists: a real promotion's end date is a fact the
 * post can state without "hurry".
 */
const AUSTRALIA_URGENCY = rule("rule.australia-urgency", "australia_urgency", {
  patterns: [
    pattern("\\btoday only\\b", "en"),
    pattern("\\blast chance\\b", "en"),
    pattern("\\bhurry\\b", "en"),
    pattern("\\bends (?:today|in \\d+ (?:hours?|minutes?))\\b", "en"),
    pattern("\\bonly \\d+ (?:left|remaining|spots?)\\b", "en"),
    pattern("\\bact now\\b", "en"),
    pattern("오늘\\s*만", "ko"),
    pattern("마지막\\s*기회", "ko"),
    pattern("서두르", "ko"),
    pattern("마감\\s*임박", "ko"),
    pattern("仅限今(?:天|日)|最后机会|抓紧时间", "zh"),
  ],
});

/**
 * §7.1, fifth item, second half: copy aimed at people under sixteen.
 *
 * Not a rule about mentioning young people -- a post about a classroom is
 * ordinary -- but about addressing them as the buyer. The negative lookbehind
 * is why "Tomverse is not for under 16s" survives: that is a safety notice, and
 * refusing it would make the rule refuse the thing it wants said.
 */
const AUSTRALIA_MINORS = rule("rule.australia-minors", "australia_minors", {
  patterns: [
    pattern("(?<!\\bnot )\\bfor (?:kids|children|teens|teenagers)\\b", "en"),
    pattern("\\b(?:kids|teens),? (?:sign up|try it|get started)\\b", "en"),
    pattern("(?<!\\bnot )\\bfor under (?:13|16|18)s?\\b", "en"),
    pattern("\\bhigh ?school(?:ers)? ?(?:can|should|get)\\b", "en"),
    pattern(
      "(?:어린이|청소년|중학생|초등학생)(?:들)?(?:을|를|도)?\\s*(?:위한|대상)",
      "ko",
    ),
    pattern("(?:青少年|中学生|小学生)(?:专用|适用|快来)", "zh"),
  ],
});

/**
 * §7.1, last item: the memory-claim prohibitions.
 *
 * A detector rather than copied patterns. `lib/marketingMemoryClaims.ts` owns
 * this question and its matcher is sentence-aware -- it does not fire on
 * "projects do not share AI memory", which mentions memory in order to deny
 * it. An earlier version copied its raw patterns and lost that with them, so
 * "Tomverse does not clone your memories" was refused for making the claim it
 * denies.
 */
const MEMORY_CLAIM = rule("rule.memory-claim", "memory_claim", {
  detectors: [(text: string) => findForbiddenMemoryClaims(text).length > 0],
});

export const MARKETING_GUARD_RULES: readonly MarketingGuardRule[] =
  Object.freeze([
    SUPERLATIVE,
    GUARANTEE,
    RANK_CLAIM,
    AI_REVIEW_CONTRACT,
    REFUTED_SUPERIORITY,
    CHINA_MAINLAND,
    AUSTRALIA_URGENCY,
    AUSTRALIA_MINORS,
    MEMORY_CLAIM,
  ]);

export const MARKETING_GUARD_RULE_IDS: readonly string[] = Object.freeze(
  MARKETING_GUARD_RULES.map((entry) => entry.id),
);
