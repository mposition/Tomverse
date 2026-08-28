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
 * ## The second version of the same sentence
 *
 * A first block forbade sending the user to another site or app, and the next
 * staging run produced this instead:
 *
 *   "앱에서 실시간 날씨를 요청해 주시면 최신 정보를 바탕으로 안내해 드릴게요."
 *
 * The destination had moved inside the product and the failure had not. It is
 * still the answer handing the task back, it is still vague about how, and it
 * is now *wrong*: the offer under it re-runs the question as it stands, so
 * there is nothing for the user to re-request. The model cannot know that, and
 * cannot know whether the card is on screen at all -- which is precisely why
 * it must not write about it.
 *
 * That run also showed the block's other half not landing: the answer stopped
 * at the limitation and said nothing about what late-August Seoul is usually
 * like. A turn that only reports what it cannot do is not an answer, so the
 * instruction to go on and answer is now imperative rather than permissive.
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
  /**
   * `webSearchMode === "always" && appManagedSearchIsDispatchable(...)`, from
   * the caller.
   *
   * A third way a turn can be searching, and the one that makes reading only
   * the first two dangerous. A Gemini turn searches through this application's
   * own `web_search` tool; without this flag it would be handed
   * `WEB_SEARCH_UNAVAILABLE_PROMPT` -- told, in the same request that carries a
   * working search tool, that nothing in its answer can come from the live web.
   * The model would then either obey the block and refuse to search, or search
   * and open with a sentence saying it could not.
   *
   * Defaulted so a caller written before this route existed keeps its exact
   * behaviour rather than silently claiming a search it did not enable.
   */
  appManagedSearchEnabled?: boolean;
}): WebSearchTurnState =>
  input.nativeSearchEnabled ||
  input.appManagedSearchEnabled === true ||
  getWebSearchCapability(input.modelId).support === "search-model"
    ? "searching"
    : "unavailable";

/**
 * The paragraph, on a turn that cannot search.
 *
 * Four rules, in the order the failures happened. State the limit once, not at
 * length and not as an apology. Then answer anyway. Do not hand the task back
 * -- to anywhere, this interface included. Do not dress training data up as
 * something checked.
 *
 * The third rule covers both destinations deliberately. Splitting it produced
 * the second failure: a block that named only external sites moved the same
 * sentence indoors. What is wrong with it is not where it points but that it
 * points at all -- the model cannot see whether the offer is on screen, cannot
 * know it re-runs the question without a re-request, and cannot press it. That
 * is the reason `lib/imageCapabilityPrompt.ts` gives for its own control, and
 * it holds identically here.
 */
export const WEB_SEARCH_UNAVAILABLE_PROMPT = [
  "# Current information",
  "",
  "Web search is not running on this turn: nothing in your answer can come",
  "from the live web.",
  "",
  "Say that limit once, in one short sentence, in the user's language. Then",
  "answer the question as far as honest general knowledge allows -- the",
  "stable background, what usually holds, what the answer depends on. Never",
  "stop at the limitation: a turn that only reports what you cannot do is",
  "not an answer.",
  "",
  "Do not tell the user to go and get the information themselves, anywhere.",
  "Not on another site, app or search engine; not \"check the official",
  "page\"; and not in this interface either -- do not ask them to switch",
  "anything on, re-send the question, or request it again. Whether a search",
  "can be run, and how, is the interface's business and not yours; a",
  "sentence about it can only be wrong about what this user is being",
  "offered.",
  "",
  "Never say or imply that you searched, and never give a live figure --",
  "today's price, temperature, score or headline -- as though you had",
  "checked it.",
].join("\n");

export const buildWebSearchCapabilitySystemPrompt = (
  state: WebSearchTurnState
): string => (state === "searching" ? "" : WEB_SEARCH_UNAVAILABLE_PROMPT);
