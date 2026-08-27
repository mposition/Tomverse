/**
 * How an assistant answer's markdown is parsed.
 *
 * ## `~` is a range in Korean, not a strikethrough
 *
 * `remark-gfm` enables single-tilde strikethrough by default, matching
 * GitHub: `~text~` renders struck through. That is right for a repository
 * README and wrong for this product's answers, because `~` is the ordinary
 * range separator in Korean — "오전 9시~오후 10시", "26~28°C", "3~4일" — and it
 * arrives in pairs by nature. Two of them in one paragraph and everything
 * between is struck out.
 *
 * Found on staging, 2026-08-27, in a searched answer about a shop's opening
 * hours. The model wrote
 *
 *   **교보문고 강남점 영업시간은 매일 오전 9시 30분~오후 10시(09:30~22:00)**입니다.
 *
 * and the reader was shown "오후 10시(09:30" with a line through it, the rest
 * of the sentence unbolded, and a literal `**` at each end — the two tildes
 * had been consumed as a `delete` node, which also broke the emphasis run that
 * spanned them. A correct answer, rendered as damage.
 *
 * `~~text~~` still works, so nothing that meant strikethrough loses it. What
 * is given up is the one-tilde shorthand, which no user of this product has a
 * reason to reach for and which the model has no reason to emit.
 *
 * ## What this does not fix
 *
 * The literal `**` in that same sentence has a second, independent cause, and
 * it is not a bug in any renderer: CommonMark's flanking rules. A closing `**`
 * preceded by punctuation and followed by a letter — `(09:30)**입니다` — is not
 * right-flanking, so it cannot close, and the asterisks stay on screen. It is
 * a known CJK gap in the specification (Korean and Japanese put particles
 * straight after a closing delimiter, with no space), and closing it means a
 * parser extension rather than an option. Deliberately left alone here: this
 * module changes one flag, and that change is worth having on its own.
 */

import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

/**
 * The plugin list every assistant answer is rendered with.
 *
 * Exported as the list rather than as options so there is one place to add to,
 * and one place a test can read. `tests/chatMarkdownPlugins.test.mjs` executes
 * the parse rather than asserting on the option, because the option is only
 * interesting for what it does to a sentence.
 */
export const CHAT_MARKDOWN_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
];
