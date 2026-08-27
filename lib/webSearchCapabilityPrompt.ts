/**
 * What the model is told about the live web on a chat turn.
 *
 * ## The failure this removes
 *
 * Asked for today's weather with the web-search switch off, the model
 * answered: "현재 실시간 날씨 정보에는 접속할 수 없어 ... 기상청 날씨누리나
 * 휴대폰 날씨 앱에서 서울을 검색해 확인해 주세요." Every clause is true and the
 * whole is a dead end -- the product has a search this account can run, on
 * this question, and the answer sent the person to another app instead.
 *
 * `lib/webSearchRetrySuggestion.ts` puts the offer on screen under that
 * answer. It cannot remove the sentence above it, and the two together read as
 * the app arguing with itself: "go and look it up yourself", then "shall I look
 * it up for you?". So the sentence has to stop being written, and the only
 * place that decides what the model writes is the request.
 *
 * ## The same rule the image block already carries
 *
 * `lib/imageCapabilityPrompt.ts` learned this one modality over, from a
 * request that ended with the model naming a tool it could not reach and
 * telling the user to go find a tab:
 *
 *   do not offer a path you cannot take.
 *
 * This is its mirror image, and the reason it is worth stating separately:
 *
 *   do not hand back a path the app can take itself.
 *
 * A search engine is not out of the model's reach the way the image workspace
 * was -- it is out of *this turn's* reach, and one control away from the user.
 * Naming it is not a helpful fallback; it is the app declining work it is
 * built to do.
 *
 * ## Why the block is silent when the turn can search
 *
 * Then there is no limitation to state. The tool is attached and the provider
 * will use it, and a paragraph about what the model cannot reach would be
 * priced input contradicting the tool in the same request. Same reason
 * `hidden` is empty in the image block.
 *
 * Pure: no Prisma, no `ai`, no `server-only`. Priced through
 * `buildChatTurnSystemBlocks` like every other block, so the chat route and
 * preflight cannot come to quote different numbers for it.
 */

import { getWebSearchCapability } from "@/lib/webSearchCapability";

export const WEB_SEARCH_TURN_STATES = [
  /** This turn will search -- a native tool is attached, or the model always does. */
  "searching",
  /** It will not: the switch is off, or this model has no search this request may carry. */
  "unavailable",
] as const;
export type WebSearchTurnState = (typeof WEB_SEARCH_TURN_STATES)[number];

/**
 * Which of the two this turn is.
 *
 * `search-model` is read off the register rather than folded into
 * `nativeSearchEnabled` by the caller: a Perplexity model searches inside its
 * ordinary completion with no tool attached, so the flag is false for it and a
 * block built on the flag alone would tell a model that is about to search
 * that it cannot. That is the same distinction `resolveAttemptSearchPath`
 * draws (`lib/webSearchPath.ts`), one step earlier -- here there is no built
 * tool configuration to read yet, only what the register says and what the
 * dispatch has decided to enable.
 */
export const resolveWebSearchTurnState = (input: {
  modelId: string;
  /** `webSearchMode === "always" && nativeSearchIsDispatchable(...)`, from the caller. */
  nativeSearchEnabled: boolean;
}): WebSearchTurnState =>
  input.nativeSearchEnabled ||
  getWebSearchCapability(input.modelId).support === "search-model"
    ? "searching"
    : "unavailable";

/**
 * The paragraph, on a turn that cannot search.
 *
 * Three rules, in the order the failures happened. State the limit once --
 * not at length, and not as an apology. Do not hand the task back. Do not
 * dress training data up as something checked.
 *
 * It says nothing about the offer the interface renders under the answer, on
 * purpose and for the reason the image block gives about its own control: a
 * sentence cannot know whether this viewer's models can search, cannot carry
 * the question, and cannot press itself. Describing it would put the model in
 * the position of promising a card that may not appear.
 */
export const WEB_SEARCH_UNAVAILABLE_PROMPT = [
  "# Current information",
  "",
  "Web search is not running on this turn: nothing in your answer can come",
  "from the live web.",
  "",
  "If answering well needs information that may have changed since your",
  "training data, say so plainly in one sentence, in the user's language,",
  "then give what you can from general knowledge.",
  "",
  "Do not send the user elsewhere to look it up -- no search engines, no",
  "other apps or sites, no \"check the official page\", no naming a service",
  "that would have the answer. This product runs the search itself when the",
  "user asks it to, and a sentence handing the task back to them is a dead",
  "end offered in place of the thing the app can do.",
  "",
  "Never say or imply that you searched, and never give a current figure --",
  "today's price, temperature, score or headline -- as though you had",
  "checked it.",
].join("\n");

export const buildWebSearchCapabilitySystemPrompt = (
  state: WebSearchTurnState
): string => (state === "searching" ? "" : WEB_SEARCH_UNAVAILABLE_PROMPT);
