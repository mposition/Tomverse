/**
 * Hashtags in an A5 draft (owner decision 2026-11-04,
 * docs/policy/marketing-automation.md §7).
 *
 * Whether a post wants hashtags, and which, is the model's call: the prompt
 * gives it each platform's range (`MARKETING_HASHTAG_RANGE`) and the words to
 * avoid. What is here is the boundary after it, in plain code: a tag that
 * names another company or boasts or hints at a price is removed, and so is
 * every tag past the platform's maximum. Removed rather than the draft
 * dropped: a tag is a label on the words, so taking one off changes no claim
 * the post makes, and dropping a draft would throw away a paid answer for the
 * sake of its last line.
 *
 * The Guard (lib/marketingGuardCore.ts) still reads the whole text, tags
 * included, against its own competitor and price wording lists. The lists
 * below do not replace those; they are this file's own because the generator
 * service loads relative modules only, and the Guard's lists sit inside the
 * Zernio webhook's pinned closure.
 *
 * Imports nothing, so the service loads it with `--experimental-strip-types`.
 */

/** How many hashtags a post on each platform carries: `max` is enforced, `min` is advice. */
export const MARKETING_HASHTAG_RANGE: Readonly<Record<string, { readonly min: number; readonly max: number }>> = {
  instagram: { min: 3, max: 5 },
  tiktok: { min: 3, max: 5 },
  youtube: { min: 2, max: 3 },
  x: { min: 1, max: 2 },
  linkedin: { min: 2, max: 3 },
  facebook: { min: 0, max: 2 },
  // Threads attaches one topic tag to a post.
  threads: { min: 0, max: 1 },
  rednote: { min: 3, max: 5 },
};

/** A platform nobody has set a range for takes no hashtags. */
export function marketingHashtagRange(channel: string): { readonly min: number; readonly max: number } {
  return MARKETING_HASHTAG_RANGE[channel] ?? { min: 0, max: 0 };
}

/**
 * Why a hashtag was taken out of a draft. Its own constant, apart from the
 * draft refusals and the Guard's codes: the draft is kept.
 */
export const MARKETING_HASHTAG_REMOVALS = Object.freeze(["hashtag_forbidden", "hashtag_over_limit"] as const);
export type MarketingHashtagRemoval = (typeof MARKETING_HASHTAG_REMOVALS)[number];

/**
 * Other companies' products, as a tag would spell them. Matched anywhere in
 * the tag, so #ChatGPTalternative is one; the registry's names are added per
 * call (`competitorNames`).
 */
const OTHER_PRODUCT_NAMES: readonly string[] = [
  "chatgpt",
  "openai",
  "claude",
  "anthropic",
  "gemini",
  "copilot",
  "perplexity",
  "deepseek",
  "midjourney",
  "mistral",
  "grok",
  "llama",
  "qwen",
  "챗지피티",
  "제미나이",
  "클로드",
  "코파일럿",
  "퍼플렉시티",
  "딥시크",
  "그록",
  "豆包",
  "文心一言",
  "通义千问",
  "通義千問",
];

/** Boasts and price hints in Latin script: the tag is, starts with or ends with one (#best, #freeAI, #AIforfree). */
const HYPE_WORDS: readonly string[] = [
  "best",
  "free",
  "cheap",
  "cheapest",
  "guaranteed",
  "discount",
  "promo",
  "coupon",
  "no1",
  "number1",
  "top1",
];

/** The same in Korean and Chinese, matched anywhere in the tag. */
const HYPE_TERMS: readonly string[] = [
  "최고",
  "최저",
  "무료",
  "공짜",
  "할인",
  "특가",
  "1위",
  "免费",
  "免費",
  "最便宜",
  "最好",
  "最佳",
  "最强",
  "最強",
  "最低",
  "第一",
  "优惠",
  "優惠",
  "折扣",
  "特价",
  "特價",
];

/** Lowercase letters and digits only, so "Chat GPT" and #chat_gpt read alike. */
const fold = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A tag: `#` not glued to a word, an address fragment or another `#`, then letters, digits or `_`. */
const HASHTAG = /(?<![\p{L}\p{M}\p{N}_&#/])#([\p{L}\p{M}\p{N}_]+)/gu;

/** The hashtags in a text, in order, without the `#`. */
export function marketingHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG)].map((match) => match[1] ?? "");
}

/** Whether a tag names another company or boasts or hints at a price. */
export function marketingHashtagIsForbidden(tag: string, competitorNames: readonly string[] = []): boolean {
  const body = fold(tag);
  if (body === "") return false;
  if (OTHER_PRODUCT_NAMES.some((name) => body.includes(name))) return true;
  for (const name of competitorNames.map(fold)) {
    // A short registry name would match inside ordinary words (#poetry), so it
    // has to be the whole tag.
    if (name.length >= 4 ? body.includes(name) : name !== "" && body === name) return true;
  }
  if (HYPE_WORDS.some((word) => body.startsWith(word) || body.endsWith(word))) return true;
  return HYPE_TERMS.some((term) => body.includes(term));
}

/**
 * The text with its forbidden tags, and every tag past the platform's maximum,
 * taken out, with how many of each. Only a removed tag and the spaces beside
 * it change; every other character, a claim's statement included, is left as
 * it was.
 */
export function marketingHashtagsWithinBounds(
  text: string,
  channel: string,
  competitorNames: readonly string[] = [],
): { readonly text: string; readonly removed: Partial<Record<MarketingHashtagRemoval, number>> } {
  const { max } = marketingHashtagRange(channel);
  const removed: Partial<Record<MarketingHashtagRemoval, number>> = {};
  const cuts: { start: number; end: number }[] = [];
  let kept = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const reason: MarketingHashtagRemoval | null = marketingHashtagIsForbidden(match[1] ?? "", competitorNames)
      ? "hashtag_forbidden"
      : kept >= max
        ? "hashtag_over_limit"
        : null;
    if (reason === null) {
      kept += 1;
      continue;
    }
    removed[reason] = (removed[reason] ?? 0) + 1;
    const start = match.index ?? 0;
    cuts.push({ start, end: start + match[0].length });
  }
  if (cuts.length === 0) return { text, removed };

  let out = "";
  let from = 0;
  for (const cut of cuts) {
    let start = cut.start;
    let end = cut.end;
    // The space before the tag goes with it; at the start of a line, the space after.
    const before = /[ \t]+$/u.exec(text.slice(from, start));
    if (before) start -= before[0].length;
    else end += /^[ \t]*/u.exec(text.slice(end))?.[0].length ?? 0;
    out += text.slice(from, start);
    from = end;
  }
  out += text.slice(from);
  // A line of tags that is now empty leaves only whitespace behind it.
  return { text: out.replace(/\s+$/u, ""), removed };
}
