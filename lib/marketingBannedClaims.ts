/**
 * The claims no copy in this product makes, in every language it publishes in.
 *
 * Contract: docs/policy/marketing-automation.md §7.1, and the S1 plan's
 * instruction to move the repository's existing ban lists into one shared
 * module rather than have the Guard carry a fourth copy.
 *
 * There were three, and they disagreed:
 *
 * - `tests/autoRoutingUi.test.mjs` and `scripts/check-starter-catalog.mjs`
 *   carried the same thirteen words;
 * - `tests/modelLaunchEmail.test.mjs` carried seventeen, adding "fastest",
 *   "most advanced", "state of the art" and their translations.
 *
 * The union is what is here. That makes the first two stricter than they were,
 * which is the right direction and cost nothing: no copy in the repository uses
 * any of the added words, checked before the lists were merged.
 *
 * **Why these words and not others.** Every one of them is a comparative claim
 * this repository cannot support. `ROUTE-01` measures non-inferiority, which is
 * a far weaker statement than "the best model"; nothing here measures speed
 * against another product; and "state of the art" is a claim about the field
 * rather than about us. Australian Consumer Law treats an unsupported
 * comparative as misleading conduct whoever wrote it, and an agent writing it
 * at three in the morning is still the company saying it.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

/** Which script's boundary rules a term is matched under. */
export type MarketingTermMatch = "word" | "substring";

export type MarketingBannedTerm = {
  /** The term as a person would write it. Folded by the Guard before matching. */
  readonly text: string;
  /** BCP-47-ish tag, for reporting which language's rule fired. */
  readonly language: string;
  /**
   * `word` where the script has boundaries and `substring` where it does not.
   *
   * `\b` is defined on ASCII word characters, so `\b최고\b` matches nothing at
   * all -- a Korean or Chinese term has to match as a substring, and carries
   * its exclusions in `MARKETING_SUPERLATIVE_EXCEPTIONS` instead.
   */
  readonly match: MarketingTermMatch;
};

const term = (
  text: string,
  language: string,
  match: MarketingTermMatch,
): MarketingBannedTerm => Object.freeze({ text, language, match });

/**
 * Superlatives and unsupported comparatives.
 *
 * The English entries are matched on word boundaries, so "bestow" and
 * "asbestos" are not "best". The CJK entries are matched as substrings, so they
 * need the exception list below: 최고기온 is a weather reading and 최고 is
 * inside it.
 */
export const MARKETING_SUPERLATIVE_TERMS: readonly MarketingBannedTerm[] =
  Object.freeze([
    term("best", "en", "word"),
    term("fastest", "en", "word"),
    term("smartest", "en", "word"),
    term("optimal", "en", "word"),
    term("most powerful", "en", "word"),
    term("most advanced", "en", "word"),
    term("state of the art", "en", "word"),

    term("최고", "ko", "substring"),
    // Korean inflects, so the stem is the term: "제일 좋은", "제일 좋습니다"
    // and "제일 좋다" all carry it.
    term("제일 좋", "ko", "substring"),
    term("제일 뛰어", "ko", "substring"),
    term("가장 뛰어", "ko", "substring"),
    term("최적", "ko", "substring"),
    term("최강", "ko", "substring"),
    term("가장 좋은", "ko", "substring"),
    term("가장 빠른", "ko", "substring"),
    term("가장 똑똑", "ko", "substring"),

    term("最佳", "zh", "substring"),
    term("最优", "zh", "substring"),
    // Traditional forms. zh-Hant is a first-class marketing locale -- Threads
    // is entirely zh-Hant and half of Facebook is -- so adding only the
    // Simplified spelling covered the smaller half of the audience.
    term("最優", "zh-Hant", "substring"),
    term("最強", "zh-Hant", "substring"),
    term("最好的", "zh-Hant", "substring"),
    term("最好", "zh", "substring"),
    term("最强", "zh", "substring"),
    term("最快", "zh", "substring"),

    term("meilleur", "fr", "word"),
    term("beste", "de", "word"),
    term("mejor", "es", "word"),
    term("melhor", "pt", "word"),
  ]);

/**
 * Words that contain a banned substring and are not the banned claim.
 *
 * Only needed for the scripts matched as substrings; the Latin terms carry
 * their own boundaries. Each of these is a real word a caption could contain:
 * 최고기온 is a maximum temperature, 최적화 is optimisation in the engineering
 * sense, 最快捷 is "most convenient" in a sense that is not a speed claim about
 * this product.
 *
 * An exception is a promise that the longer word is not the shorter claim, so
 * the list is short and each entry is one somebody can check.
 */
export const MARKETING_SUPERLATIVE_EXCEPTIONS: readonly string[] = Object.freeze(
  ["최고기온", "최고령", "최고조", "최적화", "최적의 조건", "最好的时光"],
);

/**
 * The flat list the three existing call sites want.
 *
 * They compare lower-cased copy against lower-cased words and have no notion of
 * a match mode; that is adequate for what they check, which is copy this
 * repository wrote rather than copy a model produced. The Guard uses the
 * structured list above, because a model writes "b e s t".
 */
export const MARKETING_SUPERLATIVE_WORDS: readonly string[] = Object.freeze(
  MARKETING_SUPERLATIVE_TERMS.map((entry) => entry.text),
);

/**
 * Dashes no customer-facing string in this product uses.
 *
 * Moved here from `scripts/check-starter-catalog.mjs` so the Guard and the
 * catalogue check read one list. The rule itself is
 * `components/marketing/landingContent.ts`'s.
 */
export const MARKETING_FORBIDDEN_DASHES: readonly (readonly [string, string])[] =
  Object.freeze([
    Object.freeze(["—", "em dash"] as const),
    Object.freeze(["–", "en dash"] as const),
  ]);
