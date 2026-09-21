/**
 * Turning a draft into the forms the Guard's rules are checked against.
 *
 * Contract: the S1 plan's S1f section. A rule that matches "최고" has to match
 * a draft that writes it with a zero-width space in the middle, and a rule that
 * matches "best" has to match "Ьеѕt" in Cyrillic look-alikes and "b3st" in
 * leetspeak. None of those are things a person types by accident; they are what
 * somebody types when a filter is in the way.
 *
 * **Separators are tolerated by the needle, not removed from the haystack.**
 * An earlier version collapsed separators in the text, which forced a choice
 * between two wrong answers: collapse everything and "bestow" becomes "best",
 * or collapse only between single characters and "be.st" gets through. The text
 * keeps its separators, and a term is compiled into a pattern that allows them
 * between its own characters with boundary assertions at the ends. "best" then
 * matches "b e s t", "be.st" and "b.e.s.t", and does not match "bestow".
 *
 * **Leetspeak produces two variants rather than one collapsed alphabet.**
 * `1` is `i` in "1eet" and `l` in "1ogin". An earlier version folded `l`, `i`
 * and `1` together to avoid choosing -- which also folded every rule's own `l`
 * into `i`, so a pattern written as "only" stopped matching "on1y". Two
 * variants, one reading each digit as its round-shaped letter and one as its
 * straight-shaped letter, cover both readings and leave the letters alone.
 *
 * Every variant is checked by every rule, whatever the draft's locale says: a
 * Korean draft can carry an English ban word and an English draft can carry a
 * Korean one, and the locale field is the author's claim rather than a fact
 * about the bytes.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

const codePoint = (value: number): string => String.fromCodePoint(value);

const BIDI_SOURCE =
  `[${codePoint(0x061c)}${codePoint(0x200e)}${codePoint(0x200f)}` +
  `${codePoint(0x202a)}-${codePoint(0x202e)}` +
  `${codePoint(0x2066)}-${codePoint(0x2069)}]`;

const CONTROL_SOURCE =
  `[${codePoint(0x00)}-${codePoint(0x08)}${codePoint(0x0b)}${codePoint(0x0c)}` +
  `${codePoint(0x0e)}-${codePoint(0x1f)}` +
  `${codePoint(0x7f)}-${codePoint(0x9f)}]`;

/**
 * Characters that are invisible or that have no width of their own.
 *
 * One Unicode property rather than a hand-written range, because a hand-written
 * range is a list of the tricks somebody has already played. The first version
 * named five code points and missed the soft hyphen, the combining grapheme
 * joiner and the whole tag block: `b`, soft hyphen, `est` reads as "best" and
 * folded to something else.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * The two default-ignorable characters a caption may legitimately contain.
 *
 * They select whether the character before them renders as an emoji or as
 * text, and a caption with an emoji carries one. They are still stripped before
 * folding, so they cannot be used to split a word.
 */
const VARIATION_SELECTORS = new RegExp(
  `[${codePoint(0xfe0e)}${codePoint(0xfe0f)}]`,
  "gu",
);

/** Left-to-right and right-to-left overrides, isolates and embeddings. */
const BIDI_CONTROL = new RegExp(BIDI_SOURCE, "u");

/**
 * C0 and C1 controls, less the three a caption may legitimately contain.
 *
 * Tab, newline and carriage return are ordinary in a multi-line caption. Every
 * other control is either invisible or terminal-specific.
 */
const CONTROL = new RegExp(CONTROL_SOURCE, "u");

/**
 * An `@` mention, in any script and at any length.
 *
 * The first version required two ASCII characters after the `@`, which let
 * `@x` and `@홍길동` through. A mention notifies somebody, and which somebody
 * is a decision no template records, so the shape is what matters rather than
 * the handle's plausibility. Full-width `＠` is folded to `@` by NFKC before
 * this runs.
 */
const MENTION = /(?:^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.]/u;

/**
 * Anything that reads as a web address.
 *
 * Wide on purpose. The one URL a post may carry is assembled by
 * `lib/marketingLinks.ts` from an approved id and attached by the publisher, so
 * a URL *in the generated text* is always something the model produced -- and a
 * model that produces a URL has produced a destination nobody approved.
 *
 * The host pattern takes any label of two or more letters as its suffix rather
 * than a fixed list: the first version listed thirty and `evil.cloud` was not
 * among them, and there are well over a thousand. `\p{L}` rather than `a-z`,
 * because `例子.中国` is an address too, and the dot is matched in its
 * full-width and ideographic shapes for the same reason.
 */
const URL_LIKE = new RegExp(
  [
    "\\b[a-z][a-z0-9+.-]*://",
    "\\bh[xt]{2}ps?\\b",
    `\\bwww\\d{0,3}[.${codePoint(0xff0e)}${codePoint(0x3002)}]`,
    // Lookarounds rather than `\b`, for the reason the terms use them: `\b` is
    // an ASCII word boundary, so there is none before 例 and `\b例子.中国\b`
    // matches nothing at all -- which is how an entirely ordinary Chinese
    // domain got past the first version of this.
    // The ASCII and full-width stops separate a host from its suffix.
    // The ideographic stop is sentence punctuation in Chinese, and
    // treating it as a separator made an ordinary pair of sentences
    // read as an address.
    `(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,62}[.${codePoint(0xff0e)}${codePoint(0xfe52)}]\\p{L}{2,24}(?![\\p{L}\\p{N}-])`,
    // A punycode label, which is never prose whatever surrounds it.
    "xn--[a-z0-9-]{2,59}",
    `\\b\\d{1,3}(?:[.${codePoint(0xff0e)}${codePoint(0x3002)}]\\d{1,3}){3}\\b`,
    "\\[\\s*\\.\\s*\\]",
    "\\(\\s*(?:dot|점|点)\\s*\\)",
    "\\s(?:dot|점|点)\\s\\p{L}{2,}",
  ].join("|"),
  "iu",
);

/**
 * A host written with the ideographic full stop.
 *
 * Its own expression, and case-sensitive, which `URL_LIKE` cannot be. U+3002 is
 * sentence punctuation in Chinese, so treating it as a separator the way the
 * ASCII and full-width stops are treated read an ordinary pair of sentences as
 * an address: 比较答案。然后决定。 is "compare the answers, then decide". The
 * first version listed it; the second removed it, and 例子。中国 -- a real
 * internationalised domain -- went through with nothing said.
 *
 * So the suffix has to look like a top-level domain rather than like a word.
 * An ASCII label takes any lower-case suffix, because example。com is not a
 * sentence; a CJK label needs a suffix from the list, because 然后决定 is.
 * Lower-case matters: 比较答案。Then decide. is two sentences and 。then is not,
 * which is why this cannot be folded into the case-insensitive expression above.
 */
const IDEOGRAPHIC_TLDS = [
  "中国", "中國", "台湾", "台灣", "香港", "公司", "网络", "網絡", "网址", "網址",
  "商店", "我爱你", "新加坡", "机构", "機構", "政务", "集团", "集團", "游戏",
  "遊戲", "中文网", "中文網", "在线", "在線",
].join("|");

/**
 * Suffixes that can follow an ideographic stop after a CJK label.
 *
 * Short and deliberately free of ordinary English words. The test is
 * case-insensitive, and a list holding "one", "run", "live" or "top" would
 * read 比较答案。One more thing. as an address. What is left is either not a
 * word or not one a sentence starts with.
 */
const ASCII_TLDS = [
  "com", "net", "org", "io", "ai", "co", "app", "dev", "xyz", "info", "biz",
  "tv", "cc", "icu", "pro", "asia", "vip", "wang", "ltd", "gg",
  "cn", "kr", "jp", "hk", "tw", "sg", "au", "nz", "uk",
].join("|");

/**
 * An ASCII label before the stop, which Chinese prose does not produce.
 *
 * A sentence in Chinese does not end with a run of Latin letters, so anything
 * Latin on both sides of an ideographic stop reads as an address whatever its
 * case: example。CoM is the same host as example。com, and requiring lower case
 * was how it got through.
 */
const IDEOGRAPHIC_HOST_ASCII_LABEL = new RegExp(
  `(?<![\\p{L}\\p{N}-])[A-Za-z0-9][A-Za-z0-9-]{0,62}${codePoint(0x3002)}[A-Za-z]{2,24}(?![\\p{L}\\p{N}-])`,
  "u",
);

/**
 * A CJK label, where the stop usually *is* punctuation.
 *
 * Here the suffix has to be one somebody could register, **and it has to be
 * lower case**. The case-insensitive version read 比較答案。AI Review can help.
 * as an address, because "AI" is a top-level domain and also the first word of
 * the next sentence -- as are "Pro" and "App". A sentence starts with a
 * capital and a host label does not.
 */
const IDEOGRAPHIC_HOST_CJK_LABEL = new RegExp(
  `(?<![\\p{L}\\p{N}-])[\\p{L}\\p{N}][\\p{L}\\p{N}-]{0,62}${codePoint(0x3002)}(?:${IDEOGRAPHIC_TLDS}|${ASCII_TLDS})(?![\\p{L}\\p{N}-])`,
  "u",
);

/** Markdown and HTML link syntax, whatever it points at. */
const LINK_MARKUP = /\[[^\]]*\]\([^)]*\)|<\s*a\b[^>]*>|href\s*=/iu;

/**
 * Text that addresses a reader who is a model rather than a person.
 *
 * A marketing draft is generated by a model from a brief, and a brief that
 * arrived from anywhere outside this system is untrusted text. These are the
 * markers that text uses when it is trying to become an instruction.
 */
const PROMPT_INJECTION = new RegExp(
  [
    "ignore (?:all |any |the )?(?:previous|prior|above)",
    "disregard (?:all |any |the )?(?:previous|prior|above)",
    "system prompt",
    "you are (?:now |a |an )",
    "</?(?:system|assistant|user|instructions?)>",
    "\\[\\s*(?:system|assistant|instructions?)\\s*\\]",
    "이전\\s*(?:지시|명령|프롬프트)",
    "시스템\\s*프롬프트",
    "忽略(?:之前|上述|以上)",
    "系统提示",
  ].join("|"),
  "iu",
);

/** Why a draft is refused before any rule about what it says. */
export const MARKETING_HYGIENE_CODES = Object.freeze([
  "control_character",
  "bidi_control",
  "zero_width",
  "mention",
  "url_like",
  "link_markup",
  "prompt_injection_marker",
] as const);

export type MarketingHygieneCode = (typeof MARKETING_HYGIENE_CODES)[number];

/**
 * The circled and squared letter forms, mapped to the letter they enclose.
 *
 * Generated from their code point ranges rather than typed out, because there
 * are over a hundred and a hand-written table would have holes -- which is how
 * `b🅴st` got through the first version. NFKC folds two of these ranges and
 * leaves the negative forms alone, so the table covers all of them and the
 * duplicates cost nothing.
 */
function enclosedLatinLetters(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const start of [0x24b6, 0x24d0, 0x1f130, 0x1f150, 0x1f170]) {
    for (let index = 0; index < 26; index += 1) {
      map[codePoint(start + index)] = String.fromCharCode(97 + index);
    }
  }
  return map;
}

/**
 * Letters that are not the letter they look like.
 *
 * Curated rather than generated: the full Unicode confusables table maps
 * thousands of characters, including many a Korean or Chinese caption uses
 * legitimately, and folding those would make the Korean rules match Korean text
 * at random. What is here is the Cyrillic and Greek that look like Latin in a
 * sans-serif face, which is the set somebody reaches for to write an English
 * ban word that does not look like one.
 *
 * Full-width Latin, mathematical alphanumerics and the enclosed forms are
 * folded by NFKC, which runs first.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  а: "a", б: "b", в: "b", г: "r", д: "d", е: "e", ж: "x", з: "3", и: "n",
  й: "n", к: "k", л: "n", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c",
  т: "t", у: "y", ф: "o", х: "x", ц: "u", ч: "y", ш: "w", щ: "w", ъ: "b",
  ы: "b", ь: "b", э: "e", ю: "o", я: "r", і: "i", ј: "j", ѕ: "s", ԁ: "d",
  ԛ: "q", ԝ: "w", ё: "e",
  α: "a", β: "b", γ: "y", δ: "d", ε: "e", ζ: "z", η: "n", θ: "o", ι: "i",
  κ: "k", λ: "n", μ: "m", ν: "v", ξ: "e", ο: "o", π: "n", ρ: "p", ς: "s",
  σ: "o", τ: "t", υ: "u", φ: "o", χ: "x", ψ: "y", ω: "w",
  ɪ: "i", ʟ: "l", ɴ: "n", ʀ: "r", ᴀ: "a", ᴄ: "c", ᴅ: "d", ᴇ: "e", ɢ: "g",
  ʜ: "h", ᴊ: "j", ᴋ: "k", ᴍ: "m", ᴏ: "o", ᴘ: "p", ᴛ: "t", ᴜ: "u", ᴠ: "v",
  ᴡ: "w", ʏ: "y", ᴢ: "z", ǀ: "l", ı: "i", ɡ: "g",
  ...enclosedLatinLetters(),
});

/**
 * Digits and symbols that stand in for letters, in the two readings each has.
 *
 * `round` reads `1` as `i`; `straight` reads it as `l`. Both variants are
 * produced and every rule is checked against both, which is what lets a rule
 * keep its own letters: an earlier version folded `l` into `i` to avoid
 * choosing, and a pattern written as "only" then failed to match "on1y" --
 * because the pattern's own `l` had become `i` and the text's `1` had too, but
 * they met at different letters.
 */
const LEET_ROUND: Readonly<Record<string, string>> = Object.freeze({
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t",
  "8": "b", "9": "g", "@": "a", $: "s", "!": "i", "|": "i",
});

const LEET_STRAIGHT: Readonly<Record<string, string>> = Object.freeze({
  ...LEET_ROUND,
  "1": "l",
  "!": "l",
  "|": "l",
});

const foldWith = (
  value: string,
  table: Readonly<Record<string, string>>,
): string =>
  Array.from(value)
    .map((character) =>
      Object.hasOwn(table, character) ? table[character] : character,
    )
    .join("");

/**
 * What a reader sees: NFKC applied, and nothing invisible left in it.
 *
 * The invisible characters are removed rather than kept, because a rule that
 * had to allow for one between every pair of letters would be a rule nobody can
 * read. Their *presence* is reported separately by `marketingTextHygiene` and
 * refuses the draft on its own.
 */
const readableForm = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(new RegExp(BIDI_SOURCE, "gu"), "")
    .replace(new RegExp(CONTROL_SOURCE, "gu"), "");

/**
 * Separators between two characters of a word, for the forms that drop them.
 *
 * Whitespace is deliberately not in the class. A term compiles into something
 * that tolerates separators inside itself, which covers a term; it does not
 * cover a *pattern* -- 销量第·一 went through `(?:排名|销量|市场)\s*第一` untouched,
 * and "We clo·ne your memories." went past a detector that reads a sentence.
 * So every form gets a twin with these runs removed, and the rules are checked
 * against both.
 *
 * Leaving whitespace out is what keeps the twin safe. Joining "answers." to
 * "Then" would invent words that are not in the text; joining across a run of
 * punctuation that a person would not type is exactly the trick being undone.
 */
const INTERIOR_SEPARATORS =
  /(?<=[\p{L}\p{N}])[^\p{L}\p{N}\s]+(?=[\p{L}\p{N}])/gu;

const collapsedForm = (value: string): string =>
  value.replace(INTERIOR_SEPARATORS, "");

export type MarketingTextVariants = {
  /** NFKC, invisible characters stripped. What a person would read. */
  readable: string;
  /** Lower-cased with look-alike letters folded to Latin. */
  folded: string;
  /** `folded` with digits read as their round-shaped letters. */
  leetRound: string;
  /** `folded` with digits read as their straight-shaped letters. */
  leetStraight: string;
};

/**
 * The four forms every rule is checked against.
 *
 * Separators are *not* removed from any of them. A term tolerates separators
 * through the pattern `marketingTermPattern()` builds, which is what keeps
 * "be.st" caught and "bestow" clean at the same time.
 */
export function marketingTextVariants(raw: string): MarketingTextVariants {
  const readable = readableForm(raw);
  const folded = foldWith(readable.toLowerCase(), CONFUSABLES);
  return {
    readable,
    folded,
    leetRound: foldWith(folded, LEET_ROUND),
    leetStraight: foldWith(folded, LEET_STRAIGHT),
  };
}

/**
 * Every form a rule should be checked against, in one array.
 *
 * Each variant and the same variant with its interior separators removed. The
 * twin is what a raw pattern needs, which does not tolerate a separator the
 * way a compiled term does: "销量第·一" went through a pattern untouched.
 *
 * **Whitespace is not a separator here, and a word spelled out letter by
 * letter is not handled by a twin.** A twin that joined single characters
 * across spaces fixed "We c l o n e your memories." and immediately failed on
 * "We c  l  o  n  e" and "We cl o ne", while inventing "BEST" out of a
 * sentence listing the letters. The answer is at the other end: a rule that
 * needs to survive that is written as a *term*, which compiles into a pattern
 * tolerating any separator inside itself, spaces included. See the memory
 * rule's terms in `lib/marketingGuardRules.ts`.
 *
 * A form identical to one already in the list is dropped, so ordinary text
 * costs the same handful of comparisons it always did.
 */
export function marketingTextForms(raw: string): string[] {
  const variants = marketingTextVariants(raw);
  const base = [
    variants.readable,
    variants.folded,
    variants.leetRound,
    variants.leetStraight,
  ];
  return [...new Set(base.flatMap((form) => [form, collapsedForm(form)]))];
}

/** The same folds applied to a rule's own text, so needle and haystack meet. */
export function foldMarketingRuleText(raw: string): string {
  return marketingTextVariants(raw).leetRound;
}

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Anything between two characters of a word that a person did not mean to type. */
const SEPARATOR = "[^\\p{L}\\p{N}]*";

/**
 * A term compiled into a pattern that tolerates separators inside it.
 *
 * This is where "checked against every spelling" actually happens. The term is
 * folded first, then its characters are joined by an optional run of
 * non-alphanumerics, so "b e s t", "be.st" and "b🅴s🅴t" all match.
 *
 * `word` terms get boundary assertions written as lookarounds rather than
 * `\b`, because `\b` is defined on ASCII word characters and would be wrong at
 * both ends of a Korean term -- `\b최고\b` matches nothing at all.
 *
 * **Whitespace is one of the separators, and that is a decision rather than
 * an oversight.** It is what makes "b e s t" match a term written as
 * "best", which is the commonest way of spelling a ban word past a filter.
 * The cost is that a sentence spelling the letters out for another reason --
 * "Use the labels B E S T in sequence." -- is refused. That is the safe
 * direction: a refusal is an operator rewriting one line, and the other way
 * round is a published superlative. The trade is written down here rather
 * than discovered.
 */
export function marketingTermPattern(
  term: string,
  match: "word" | "substring",
): RegExp {
  const body = Array.from(foldMarketingRuleText(term))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .map(escapeForRegExp)
    .join(SEPARATOR);

  // A term with nothing alphanumeric in it would compile to an empty pattern,
  // which matches everywhere. Never matching is the safe answer for a term
  // somebody wrote wrong.
  if (!body) return /(?!)/u;

  return new RegExp(
    match === "word"
      ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`
      : body,
    "u",
  );
}

/**
 * What is wrong with the bytes, before anything about the meaning.
 *
 * Returned as a list rather than a first match: a draft carrying both a mention
 * and a URL has two problems, and an operator rewriting it wants both.
 */
export function marketingTextHygiene(raw: string): MarketingHygieneCode[] {
  const codes: MarketingHygieneCode[] = [];

  if (CONTROL.test(raw)) codes.push("control_character");
  if (BIDI_CONTROL.test(raw)) codes.push("bidi_control");
  // Bidi controls are default-ignorable too, and they already have their own
  // code. Reporting both would make every direction override arrive with a
  // second finding that says nothing more.
  const invisible = raw
    .replace(VARIATION_SELECTORS, "")
    .replace(new RegExp(BIDI_SOURCE, "gu"), "");
  if (DEFAULT_IGNORABLE.test(invisible)) codes.push("zero_width");

  // The readable form for the rest: a mention written with a zero-width space
  // after the `@` is still a mention, and the invisible character has already
  // been reported above.
  const readable = readableForm(raw);
  if (MENTION.test(readable)) codes.push("mention");
  if (
    URL_LIKE.test(readable) ||
    IDEOGRAPHIC_HOST_ASCII_LABEL.test(readable) ||
    IDEOGRAPHIC_HOST_CJK_LABEL.test(readable)
  ) {
    codes.push("url_like");
  }
  if (LINK_MARKUP.test(readable)) codes.push("link_markup");
  if (PROMPT_INJECTION.test(readable)) codes.push("prompt_injection_marker");

  return codes;
}
