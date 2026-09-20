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
import { FORBIDDEN_MEMORY_CLAIMS } from "@/lib/marketingMemoryClaims";

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

export type MarketingGuardRule = {
  readonly id: string;
  readonly category: MarketingRuleCategory;
  /** Every §7.1 rule refuses. The approval categories are §7.4 and live in the core. */
  readonly verdict: "reject";
  /** Literal terms, folded by the Guard and matched by their own mode. */
  readonly terms: readonly MarketingBannedTerm[];
  readonly patterns: readonly MarketingRulePattern[];
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
    exceptions?: readonly string[];
  },
): MarketingGuardRule =>
  Object.freeze({
    id,
    category,
    verdict: "reject" as const,
    terms: Object.freeze(parts.terms ? [...parts.terms] : []),
    patterns: Object.freeze(parts.patterns ? [...parts.patterns] : []),
    exceptions: Object.freeze(parts.exceptions ? [...parts.exceptions] : []),
  });

/**
 * §7.1, first item: the repository's ban words, superlatives, guarantees, "#1".
 *
 * `better` is in the policy's list and deliberately *not* in
 * `MARKETING_SUPERLATIVE_TERMS`, because that list is also what checks the
 * copy this repository wrote -- and `lib/autoRoutingCopy.ts` says "no model was
 * a better fit for this message", which is the denial of the claim rather than
 * the claim. So it is a pattern here with the negations excluded, and both
 * forms are in the corpus.
 */
const SUPERLATIVE = rule("rule.superlative", "superlative", {
  terms: MARKETING_SUPERLATIVE_TERMS,
  patterns: [
    // "better" unless something in front of it is turning it down. The
    // alternation is the shapes a denial actually takes, not every possible
    // negation: a rule that tried to parse English would be a rule that is
    // wrong in a way nobody can see.
    pattern(
      "(?<!\\b(?:no|not|never|isn't|aren't|nothing)\\s(?:\\w+\\s){0,4})\\bbetter\\b",
      "en",
    ),
    pattern("(?<!\\S)더\\s*나은", "ko"),
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
  exceptions: [],
});

/**
 * "#1" and every way of writing it.
 *
 * `\b` does not help here: `#` and `1` are not word characters in the same
 * sense, and "No. 1" has a full stop in the middle. The patterns are written
 * out rather than derived.
 */
const RANK_CLAIM = rule("rule.rank-claim", "rank_claim", {
  patterns: [
    pattern("#\\s*1\\b", "en"),
    pattern("\\bno\\.?\\s*1\\b", "en"),
    pattern("\\bnumber one\\b", "en"),
    pattern("\\btop[- ]rated\\b", "en"),
    pattern("1\\s*위", "ko"),
    pattern("업계\\s*1", "ko"),
    pattern("第一(?!次|步|时间)", "zh"),
  ],
  exceptions: [],
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
  exceptions: [],
});

/**
 * §7.1, third item: superiority claims with a known counter-example.
 *
 * Each of these is false, and known to be false, which is a different thing
 * from unsupported. "The only multi-model comparison" is not true; "the only
 * AI that reads HWP" is not true. A claim in this category is refused rather
 * than sent for approval, because there is nothing an approver could check
 * that would make it true.
 */
const REFUTED_SUPERIORITY = rule("rule.refuted-superiority", "refuted_superiority", {
  patterns: [
    pattern(
      "\\b(?:the )?only (?:ai|assistant|tool|app|service|platform|product|workspace)\\b",
      "en",
    ),
    pattern("\\bfirst (?:and only|ever)\\b", "en"),
    pattern("\\bonly (?:one|place|way) to compare\\b", "en"),
    pattern("\\bonly .{0,20}\\bhwp\\b", "en"),
    pattern("유일(?:한|하게)", "ko"),
    pattern("최초의?\\s*(?:다중|멀티|교차)", "ko"),
    pattern("우리만", "ko"),
    pattern("唯一(?:的)?(?:一个)?(?:AI|工具|平台|产品)?", "zh"),
  ],
  exceptions: [],
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
  exceptions: [],
});

/**
 * §7.1, fifth item, first half: manufactured urgency.
 *
 * Australian Consumer Law treats a deadline that is not a deadline as
 * misleading conduct. The rule is about the shape of the sentence, not about
 * whether a promotion exists: a real promotion's end date is a fact the post
 * can state without "hurry".
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
  exceptions: [],
});

/**
 * §7.1, fifth item, second half: copy aimed at people under sixteen.
 *
 * Not a rule about mentioning young people -- a post about a classroom is
 * ordinary -- but about addressing them as the buyer.
 */
const AUSTRALIA_MINORS = rule("rule.australia-minors", "australia_minors", {
  patterns: [
    pattern("\\bfor (?:kids|children|teens|teenagers)\\b", "en"),
    pattern("\\b(?:kids|teens),? (?:sign up|try it|get started)\\b", "en"),
    pattern("\\bunder (?:13|16|18)s?\\b", "en"),
    pattern("\\bhigh ?school(?:ers)? ?(?:can|should|get)\\b", "en"),
    pattern("(?:어린이|청소년|중학생|초등학생)(?:들)?(?:을|를|도)?\\s*(?:위한|대상)", "ko"),
    pattern("(?:青少年|中学生|小学生)(?:专用|适用|快来)", "zh"),
  ],
  exceptions: [],
});

/**
 * §7.1, last item: the memory-claim prohibitions.
 *
 * Imported from `lib/marketingMemoryClaims.ts` rather than restated. That
 * module owns what this product may say about account memory and about
 * importing from another AI service, its patterns are already negation-aware,
 * and a second copy here would drift from it.
 */
const MEMORY_CLAIM = rule("rule.memory-claim", "memory_claim", {
  // Each of those patterns is a `RegExp` this module does not own, so its
  // source is copied and recompiled rather than the object being held: a
  // shared `RegExp` is a matcher anything can replace. The `g` and `y` flags
  // are dropped because they carry `lastIndex`, which makes a shared pattern
  // return different answers on successive calls.
  //
  // The claim id rather than a language: these patterns match Korean and
  // English in one alternation, and calling them either would be wrong.
  patterns: FORBIDDEN_MEMORY_CLAIMS.flatMap((claim) =>
    claim.patterns.map((expression) =>
      pattern(expression.source, claim.id, expression.flags.replace(/[gy]/g, "")),
    ),
  ),
  exceptions: [],
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
