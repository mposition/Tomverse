import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@tomverse/chat-ui";

/**
 * Math in assistant answers (web Chat and Review).
 *
 * Single dollars are text: `lib/chatMathDelimiters.ts` decides which `$` are
 * formulas and rewrites them to `$$` before parsing, so "$5 and $10" can never
 * become a formula. The shared `@tomverse/chat-ui` parser list is left as it
 * is for the mobile and desktop shells.
 */
export const ANSWER_REMARK_PLUGINS: PluggableList = [
  ...CHAT_MARKDOWN_REMARK_PLUGINS,
  [remarkMath, { singleDollarTextMath: false }],
];

/**
 * `throwOnError` is fixed to false by rehype-katex: a formula KaTeX cannot
 * parse (including one cut off mid-stream) shows as its source in the error
 * colour instead of failing the answer. `trust` stays off, so no `\href`,
 * `\includegraphics` or `\url`.
 */
export const ANSWER_MATH_REHYPE_PLUGIN: PluggableList[number] = [
  rehypeKatex,
  { strict: "ignore", trust: false, maxSize: 20, maxExpand: 200, errorColor: "#b91c1c" },
];
