/**
 * How an assistant answer's markdown is parsed.
 *
 * Two changes to the default GitHub-flavoured parse, both for the same
 * reason: this product renders unsupervised AI-generated Markdown, mostly in
 * Korean, and CommonMark's inline rules were written for a language that puts
 * spaces around things.
 *
 * ## 1. `~` is a range in Korean, not a strikethrough
 *
 * `remark-gfm` enables single-tilde strikethrough by default, matching
 * GitHub: `~text~` renders struck through. That is right for a repository
 * README and wrong here, because `~` is the ordinary range separator in
 * Korean -- "오전 9시~오후 10시", "26~28°C", "3~4일" -- and so it arrives in
 * pairs by nature. Two in one paragraph and everything between is struck out.
 *
 * `~~text~~` still works, so nothing that meant strikethrough loses it. What
 * is given up is the one-tilde shorthand, which no user of this product has a
 * reason to reach for and which the model has no reason to emit.
 *
 * ## 2. A closing delimiter followed by a Korean particle
 *
 * CommonMark decides whether `**` may close by looking at the characters
 * either side of it. A run preceded by punctuation and followed by a letter is
 * not right-flanking, so it cannot close -- and `(09:30)**입니다` is exactly
 * that shape. Korean, Japanese and Chinese attach particles and clauses
 * directly to a closing delimiter with no space, so the shape is not an edge
 * case in those languages; it is how sentences are written.
 *
 * This is not an error in `react-markdown`'s implementation of the
 * specification. It is still a defect of this product, because what reaches
 * the reader is a literal `**`. Behaving to specification is not a licence to
 * show markup to a user.
 *
 * The fix is a parser extension rather than an option, so it is deliberately
 * two: `remark-cjk-friendly` relaxes the flanking rules for emphasis, and
 * `remark-cjk-friendly-gfm-strikethrough` does the same for GFM's `~~`.
 * Taking only the first would leave `~~취소선(가격)~~입니다` broken in exactly
 * the way `**` was, which is the half-fix its own documentation warns about.
 * Both are the `/parseOnly` entry points -- this repository renders Markdown
 * and never serialises it back, so the bidirectional builds would be dependency
 * weight with nothing to do -- and both are placed after `remarkGfm`, which is
 * what the plugins require to take effect.
 *
 * ## What was considered and rejected
 *
 * Telling the model in a system prompt to leave a space before a particle:
 * unenforceable, and it would make the app's Korean read wrongly on purpose.
 * Pre-processing the text with a regular expression before parsing: it cannot
 * see code fences, link destinations or escapes, so it would corrupt the cases
 * it did not understand. Neither is worth doing when the parse itself can be
 * told the truth about the language.
 */

import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import type { PluggableList } from "unified";

/**
 * Read by `remarkGfm` and by the strikethrough extension, from one object.
 *
 * The extension re-registers the strikethrough construct with its own flanking
 * rules and takes its own `singleTilde`, so it does not inherit the one given
 * to `remarkGfm`. Adding the extension with no options put the single-tilde
 * behaviour straight back, and the staging sentence this file exists for
 * struck through "오후 10시(09:30" again -- a fix for one defect quietly
 * undoing the fix for the other. One object rather than two literals, so they
 * cannot drift apart again.
 */
const GFM_OPTIONS = { singleTilde: false } as const;

/**
 * The plugin list every assistant answer is rendered with.
 *
 * Exported as the list rather than as options so there is one place to add to,
 * and one place a test can read. `tests/chatMarkdownPlugins.test.mjs` executes
 * the parse rather than asserting on the options, because an option is only
 * interesting for what it does to a sentence.
 *
 * Order is part of the contract: both extensions amend constructs `remarkGfm`
 * registers, so they follow it.
 */
export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, GFM_OPTIONS],
  remarkCjkFriendly,
  [remarkCjkFriendlyGfmStrikethrough, GFM_OPTIONS],
];
