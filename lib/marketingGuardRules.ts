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
import { findMarketingMinorsTargeting } from "@/lib/marketingMinorsClaims";

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

// Terms rather than patterns, because a term compiles into something that
// tolerates separators inside it and a raw pattern does not:
// "Results are guar-anteed." with an em dash went through the regex.
const GUARANTEE = rule("rule.guarantee", "guarantee", {
  terms: [
    { text: "guarantee", language: "en", match: "word" },
    { text: "guaranteed", language: "en", match: "word" },
    { text: "guarantees", language: "en", match: "word" },
    { text: "we promise", language: "en", match: "word" },
    { text: "risk free", language: "en", match: "word" },
    { text: "보장", language: "ko", match: "substring" },
    { text: "약속드립니다", language: "ko", match: "substring" },
    { text: "保证", language: "zh", match: "substring" },
    { text: "保障", language: "zh", match: "substring" },
    { text: "保證", language: "zh-Hant", match: "substring" },
  ],
  exceptions: ["보장보험"],
});

/**
 * "#1" and every way of writing it.
 *
 * The Chinese pattern names what the claim is first at. 第一 on its own is
 * "first" -- 第一章 is chapter one and 第一次 is the first time -- and a rule
 * that refused it would refuse a sentence explaining how to start.
 */
const RANK_CLAIM = rule("rule.rank-claim", "rank_claim", {
  // The Chinese claims are terms as well as patterns: a term tolerates a
  // separator inside it, and 第·一 went through the pattern untouched.
  terms: [
    { text: "第一AI", language: "zh", match: "substring" },
    { text: "第一平台", language: "zh", match: "substring" },
    { text: "第一产品", language: "zh", match: "substring" },
    { text: "第一產品", language: "zh", match: "substring" },
    { text: "第一工具", language: "zh", match: "substring" },
    { text: "第一选择", language: "zh", match: "substring" },
    { text: "第一選擇", language: "zh", match: "substring" },
    { text: "第一品牌", language: "zh", match: "substring" },
    { text: "第一名", language: "zh", match: "substring" },
    { text: "第1AI", language: "zh", match: "substring" },
    { text: "第1平台", language: "zh", match: "substring" },
    { text: "第1产品", language: "zh", match: "substring" },
    { text: "第1產品", language: "zh", match: "substring" },
    { text: "第1工具", language: "zh", match: "substring" },
    { text: "第1选择", language: "zh", match: "substring" },
    { text: "第1選擇", language: "zh", match: "substring" },
    { text: "第1品牌", language: "zh", match: "substring" },
    { text: "第1名", language: "zh", match: "substring" },
    // Terms rather than patterns for the same reason the Chinese claims are:
    // a term tolerates a separator inside itself, and "top--rated" did not
    // match a pattern whose separator class held one hyphen or one space.
    { text: "number one", language: "en", match: "word" },
    { text: "top rated", language: "en", match: "word" },
  ],
  patterns: [
    // A separator class rather than a whitespace one: "#·1" is the same claim, and a
    // pattern that tolerates only whitespace does not say so.
    pattern("#[^\\p{L}\\p{N}]{0,4}1(?![\\p{L}\\p{N}])", "en"),
    pattern("\\bno[^\\p{L}\\p{N}]{0,4}1(?![\\p{L}\\p{N}])", "en"),
    pattern("1[^\\p{L}\\p{N}]{0,4}위", "ko"),
    pattern("업계[^\\p{L}\\p{N}]{0,4}1", "ko"),
    pattern("第[一1](?:的)?\\s*(?:AI|平台|产品|工具|选择|產品|選擇|品牌|名)", "zh"),
    pattern("(?:排名|[销銷]量|市[场場])\\s*第[一1]", "zh"),
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
  // "fact-checked" written with an em dash went through a pattern whose only
  // separators were a hyphen and a space. A term tolerates whatever is in there.
  terms: [
    { text: "fact check", language: "en", match: "word" },
    { text: "fact checked", language: "en", match: "word" },
    { text: "fact checking", language: "en", match: "word" },
    { text: "fact checks", language: "en", match: "word" },
    { text: "consensus", language: "en", match: "word" },
    { text: "different providers", language: "en", match: "word" },
    { text: "different provider", language: "en", match: "word" },
    { text: "事实核查", language: "zh", match: "substring" },
    { text: "事實核查", language: "zh-Hant", match: "substring" },
    { text: "模型达成一致", language: "zh", match: "substring" },
    { text: "模型達成一致", language: "zh-Hant", match: "substring" },
  ],
  patterns: [
    pattern("\\bverif(?:ies|ied|y) (?:the )?(?:facts?|accuracy)\\b", "en"),
    pattern("\\b(?:models?|reviewers?) agree(?:d|ment)?\\b", "en"),
    pattern("\\baccuracy (?:score|rating|rate)\\b", "en"),
    pattern("사실\\s*(?:검증|확인)", "ko"),
    pattern("(?:모델|검토자)(?:들)?\\s*(?:가|이)?\\s*합의", "ko"),
    pattern("서로\\s*다른\\s*(?:provider|공급자|제공자)", "ko"),
    pattern("정확도\\s*(?:점수|평가)", "ko"),
    pattern("不同的?(?:提供商|供应商|供應商)", "zh"),
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
  // Same reason as the rank rule.
  terms: [
    { text: "唯一AI", language: "zh", match: "substring" },
    { text: "唯一工具", language: "zh", match: "substring" },
    { text: "唯一平台", language: "zh", match: "substring" },
    { text: "唯一产品", language: "zh", match: "substring" },
    { text: "唯一產品", language: "zh", match: "substring" },
    { text: "唯一服务", language: "zh", match: "substring" },
    { text: "唯一服務", language: "zh", match: "substring" },
    { text: "唯一选择", language: "zh", match: "substring" },
    { text: "唯一選擇", language: "zh", match: "substring" },
    { text: "唯1AI", language: "zh", match: "substring" },
    { text: "唯1工具", language: "zh", match: "substring" },
    { text: "唯1平台", language: "zh", match: "substring" },
    { text: "唯1产品", language: "zh", match: "substring" },
    { text: "唯1產品", language: "zh", match: "substring" },
    { text: "唯1服务", language: "zh", match: "substring" },
    { text: "唯1服務", language: "zh", match: "substring" },
    { text: "唯1选择", language: "zh", match: "substring" },
    { text: "唯1選擇", language: "zh", match: "substring" },
  ],
  patterns: [
    pattern(
      "\\b(?:the )?only (?:ai|assistant|tool|app|service|platform|product|workspace)\\b",
      "en",
    ),
    pattern("\\bfirst (?:and only|ever)\\b", "en"),
    pattern("\\bonly (?:one|place|way) to compare\\b", "en"),
    pattern("\\bonly .{0,30}\\bhwp\\b", "en"),
    // 유일한 has to be qualifying the forbidden noun, which means every word in
    // between is still part of the same noun phrase. A word that closes one --
    // one carrying 이, 가, 은, 는, 을 or 를 -- ends the phrase, and a word
    // cannot be matched across a comma or a full stop because the class holds
    // neither. That is the boundary, rather than a count: counting to three
    // read "각 요청에는 유일한 식별자가 있으며 이 도구가 이를 표시합니다" -- a
    // sentence about identifiers -- as a claim about the 도구 two clauses
    // later, and counting to three also let "전 세계에서 유일한 사용하기 쉽고
    // 안전하며 빠른 AI 비교 도구" past with four modifiers.
    pattern(
      "유일(?:한|하게)\\s*(?:[가-힣A-Za-z0-9]{1,10}(?<![이가은는을를])\\s+){0,10}(?:AI|도구|서비스|플랫폼|제품|비교|교차검토)",
      "ko",
    ),
    pattern("최초의?\\s*(?:다중|멀티|교차)", "ko"),
    pattern("우리만", "ko"),
    pattern("唯[一1](?:的)?\\s*(?:AI|工具|平台|产品|產品|服务|服務|选择|選擇)", "zh"),
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
    // Simplified and Traditional in one pattern. RedNote writes Simplified for
    // overseas readers and the zh-Hant accounts write 中國大陸, so a rule that
    // knew one spelling knew one of the channels.
    pattern("中[国國]大[陆陸]\\s*(?:可用|上[线線]|[开開]放|使用|推出)", "zh"),
    pattern("在中[国國]大[陆陸]", "zh"),
    pattern("(?:支付[宝寶]|微信支付|[银銀][联聯])", "zh"),
    pattern("大[陆陸](?:用[户戶])?(?:可|能)(?:注[册冊]|[订訂][阅閱]|付款)", "zh"),
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
    pattern("[仅僅]限今[天日]", "zh"),
    pattern("最[后後][机機][会會]", "zh"),
    pattern("抓[紧緊][时時][间間]", "zh"),
  ],
});

/**
 * §7.1, fifth item, second half: copy aimed at people under sixteen.
 *
 * Not a rule about mentioning young people -- a post about a classroom is
 * ordinary -- but about addressing them as the buyer.
 *
 * A detector, for the reason the memory rule is one. The first version used a
 * fixed-length negative lookbehind and was wrong in both directions at once:
 * "Children, sign up and try it." went through because the comma was not in
 * the pattern, and "Tomverse is not intended for children." was refused
 * because the negator sat further away than the lookbehind could reach.
 * `lib/marketingMinorsClaims.ts` reads the clause instead, through the same
 * parser the memory rule uses.
 */
const AUSTRALIA_MINORS = rule("rule.australia-minors", "australia_minors", {
  detectors: [(text: string) => findMarketingMinorsTargeting(text).length > 0],
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
