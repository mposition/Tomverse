/**
 * Whether a finished answer should be offered a re-run with web search on.
 *
 * ## The failure this exists for
 *
 * A turn that needs information newer than a model's training, sent with the
 * web-search switch off, produces an answer that cannot be right and says so:
 * "실시간 날씨 정보를 조회할 수 없어 ... 기상청 날씨누리나 휴대폰 날씨 앱에서
 * 검색해 확인해 주세요." Every part of that sentence is true and none of it
 * helps -- the product has a search this account can run, on this question,
 * with one press, and instead sent the person to another app. A dead end
 * offered *by a product that has the answer* is worse than an error, because
 * an error at least does not pretend the work is finished.
 *
 * So this module answers one question: is the switch the only thing standing
 * between this question and its answer?
 *
 * ## Why it is not the Deep Research offer with different words
 *
 * `lib/deepResearchSuggestion.ts` offers *more* than the answer on screen: the
 * answer stays correct and a second pass would add sources and comparison. It
 * therefore refuses a bare recency question by design -- its own comment names
 * "오늘 서울 날씨 알려줘" as the case a research report must not be offered for.
 *
 * This offer is the opposite shape. It is made about an answer that could not
 * be right, it costs seconds rather than minutes, and it is exactly the case
 * Deep Research pushes away. The two are mutually exclusive on the same turn
 * by construction: `recency` alone is the only thing this needs and the one
 * thing that module will not act on alone. Nothing enforces that from outside,
 * and nothing has to -- `tests/webSearchRetrySuggestion.test.mjs` holds the
 * weather question against both classifiers.
 *
 * ## Where the signals come from, in the order the product prefers them
 *
 * 1. **The orchestration layer's own tool-need signal.** `buildTaskProfile`'s
 *    `needsCurrentInformation` is what the Router's web-search hard filter
 *    reads (docs/policy/tomverse-chat-router-score-policy.md §8). It is the
 *    app's existing answer to "does this turn want the web", so this offer
 *    reads it rather than inventing a second one that could disagree with the
 *    router about the same sentence.
 * 2. **The existing capability decision.** Whether a search could actually run
 *    is `webSearchIsDispatchable` (`lib/webSearchCapability.ts`) -- the same
 *    function the composer chip, the credit estimate, preflight and dispatch
 *    read. This module never re-derives it from `support`, which is the
 *    mistake that helper was written to end.
 * 3. **Structured response metadata.** `WebSearchExecution.executed` says
 *    whether the turn that just finished really searched. A turn that searched
 *    is never offered a search.
 * 4. **A heuristic, last and centralised here.** Only for the live-lookup
 *    categories the routing heuristic deliberately does not carry (see
 *    `LIVE_LOOKUP_WORDS`).
 *
 * ## Why the fourth is not a widening of `lib/webSearchSuggestion.ts`
 *
 * `RECENCY_KEYWORDS` there feeds `needsCurrentInformation`, which feeds the
 * Router's hard filter and is recorded against `TASK_PROFILE_VERSION` on every
 * `RoutingRun`. Adding "영업시간" to it changes which models are eligible for
 * turns nobody was asking about and makes past routing decisions
 * unattributable. `lib/deepResearchSuggestion.ts` met this exact wall and kept
 * its extra axis local for the same reason; this follows it. A product offer
 * is not entitled to move a routing boundary.
 *
 * ## No model call, and no reading of the answer
 *
 * Deterministic rules over the question the user already sent, like every
 * other suggestion module here. In particular it does **not** pattern-match
 * the assistant's reply for refusal phrasing ("조회할 수 없어", "I don't have
 * access to"): that reads as the obvious shortcut and is a trap -- it is seven
 * languages of open-ended prose, it would fire on an answer *about* refusals,
 * and it would miss a model that confidently answered from stale training data
 * instead of admitting the gap. "The question needed the web and no search
 * ran" is knowable, checkable, and true in both of those cases.
 *
 * Korean and English, like every other heuristic in this repository. A turn in
 * a language none of them read produces no signal and therefore no card, which
 * is the safe direction.
 *
 * Pure and synchronous. No database, no clock, no I/O.
 */

import type { ComparisonModelStatus } from "@/lib/comparisonReadiness";
import { buildTaskProfile } from "@/lib/taskProfileCore";
import { modelWebSearchIsDispatchable } from "@/lib/webSearchCapability";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import { hasExplicitSourceOrSearchIntent } from "@/lib/webSearchSuggestion";

/**
 * Below this many characters a question is not read at all.
 *
 * The same four as `suggestsRecentInformationNeeded`'s floor and for the same
 * reason -- a bare "오늘" is a guess about a word, not a question. Lower than
 * Deep Research's twelve on purpose: "오늘 환율" is a complete live lookup and
 * a report is what a lookup does not need, not a search.
 */
export const WEB_SEARCH_SUGGESTION_MINIMUM_LENGTH = 4;

/* ------------------------------------------------------------------------ */
/* The topic axis                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Why this question looks like one the web would answer and training data
 * would not.
 *
 * Reported as a list of fixed identifiers from this file -- never anything
 * taken from the text -- because the caller records which ones fired.
 */
export const WEB_SEARCH_TOPIC_SIGNALS = [
  /** The user asked for sources, citations or a search themselves. */
  "explicit_search_request",
  /** The orchestration layer's own `needsCurrentInformation`. */
  "recency",
  /**
   * A lookup whose answer is a fact held somewhere public right now: opening
   * hours, a score, a timetable, a statute as amended. See `LIVE_LOOKUP_WORDS`
   * for why these are here rather than in the shared recency list.
   */
  "live_lookup",
] as const;

export type WebSearchTopicSignal = (typeof WEB_SEARCH_TOPIC_SIGNALS)[number];

/** Why a question was read and then set aside. */
export type WebSearchTopicRefusal =
  /** Shorter than the floor above. */
  | "too_short"
  /**
   * Writing, rewriting or translation. The work is the text itself, and a
   * search result is not a better draft of the user's own paragraph.
   */
  | "writing_or_translation"
  /** Read, and nothing in it says the answer has to be current. */
  | "no_recency_signal";

export type WebSearchTopicDecision = {
  suggested: boolean;
  signals: readonly WebSearchTopicSignal[];
  refusal: WebSearchTopicRefusal | null;
};

export type WebSearchTopicInput = {
  /** The user's question. Never stored or echoed by this module. */
  text: string;
  attachments?: ReadonlyArray<{ name?: string; mediaType?: string }>;
};

/**
 * Live lookups the shared recency list does not carry.
 *
 * Each entry is a question whose answer is a fact somebody is publishing right
 * now and no model was trained on: whether a shop is open, how a match ended,
 * when a flight leaves, what a statute says as amended. They are deliberately
 * *narrow* -- "가격" alone is not here, because "이 설계의 가격은 얼마나 드나"
 * is a design question, and a card under every sentence containing the word
 * price is the failure mode this whole module is trying not to become.
 *
 * Extending this list is the intended way to teach the offer a new category,
 * and it is a UI change with no routing consequence. Adding a language means
 * adding its patterns here beside the two; nothing about the shape is bound to
 * Korean, and `tests/webSearchRetrySuggestion.test.mjs` covers both current
 * languages so a third arrives with its own cases rather than by accident.
 */
const LIVE_LOOKUP_WORDS =
  // Opening hours and whether a place is operating.
  /영업\s*(시간|중|일)|운영\s*(시간|중|일)|문\s*(여는|닫는|열었|닫았)|오픈\s*시간|마감\s*시간|휴무|임시\s*휴업|\b(opening|business|store|opening)\s*hours?\b|\bare\s+they\s+open\b|\bis\s+it\s+open\b|\bopen\s+(now|today)\b|\bhours\s+(today|now)\b/i;

const LIVE_RESULT_WORDS =
  // Scores, fixtures, timetables, departures, releases.
  /경기\s*(결과|일정|스코어)|스코어|승부\s*예측|중계|선발\s*(명단|라인업)|순위표|시간표|운행\s*(정보|중단)|연착|결항|출발\s*시각|개봉\s*(일|했|하나)|출시\s*(일|했|되나|예정)|발매\s*일|\b(match|game|final)\s*(score|result)s?\b|\bwho\s+won\b|\bfixtures?\b|\bkick-?off\b|\bstandings\b|\btimetable\b|\bdeparture\s+time\b|\brelease\s+date\b|\bis\s+.{0,24}\bdelayed\b/i;

const LIVE_RULE_WORDS =
  // Rules, prices and specifications as they stand today. Each of these needs
  // a currency word beside it -- see the `_CURRENT` guard below -- because a
  // question about a regulation is not by itself a question about this week's
  // version of it.
  /규정|규제|법령|시행령|개정|세율|관세|금리|요금제|보조금|지원금|스펙|사양|단종|리콜|\b(regulation|statute|tariff|interest rate|tax rate|subsidy|spec(ification)?s?|discontinued|recall(ed)?)\b/i;

// The currency words that turn a rule question into a *current* rule question.
// Kept separate from `LIVE_RULE_WORDS` so "규제 샌드박스가 뭐야" -- a
// definition -- does not get a card, while "현재 규제가 어떻게 되나" does.
const CURRENCY_WORDS =
  /오늘|현재|지금|최신|올해|이번\s*(주|달|해)|요즘|최근|바뀐|변경된|달라진|기준으로|\b(today|now|current(ly)?|latest|this (week|month|year)|as of|recent(ly)?|updated?|changed?)\b|\b20(2[4-9]|3[0-9])\b/i;

/**
 * Reads one sent question and says whether a search is worth offering for it.
 *
 * `webSearchRequested` is deliberately *not* an input, unlike
 * `classifyDeepResearchTopic`. Passing it through to `buildTaskProfile` would
 * make `needsCurrentInformation` true for every turn the switch was already on
 * for -- which is exactly the population this offer must never appear for, so
 * feeding it in would turn a signal into a tautology. Whether the turn already
 * searched is a separate question, answered by `deriveWebSearchSuggestion`
 * below where it belongs.
 */
export const classifyWebSearchTopic = (
  input: WebSearchTopicInput
): WebSearchTopicDecision => {
  const text = (input.text ?? "").trim();
  const none = (refusal: WebSearchTopicRefusal): WebSearchTopicDecision => ({
    suggested: false,
    signals: [],
    refusal,
  });

  if (text.length < WEB_SEARCH_SUGGESTION_MINIMUM_LENGTH) {
    return none("too_short");
  }

  const profile = buildTaskProfile({
    text,
    attachments: input.attachments,
    webSearchRequested: false,
  });

  if (profile.kind === "writing" || profile.kind === "multilingual") {
    return none("writing_or_translation");
  }

  const signals: WebSearchTopicSignal[] = [];
  if (hasExplicitSourceOrSearchIntent(text)) {
    signals.push("explicit_search_request");
  }
  if (profile.needsCurrentInformation) signals.push("recency");
  if (
    LIVE_LOOKUP_WORDS.test(text) ||
    LIVE_RESULT_WORDS.test(text) ||
    (LIVE_RULE_WORDS.test(text) && CURRENCY_WORDS.test(text))
  ) {
    signals.push("live_lookup");
  }

  if (signals.length === 0) {
    return { suggested: false, signals, refusal: "no_recency_signal" };
  }
  return { suggested: true, signals, refusal: null };
};

/**
 * Stable key for "this question has already been answered for in this
 * conversation".
 *
 * Same shape and same reason as `deepResearchTopicKey`: deterministic per
 * trimmed question, not cryptographic.
 */
export const webSearchTopicKey = (text: string): string =>
  text.trim().toLowerCase();

/* ------------------------------------------------------------------------ */
/* The offer                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * What the card is allowed to say, and therefore what it is allowed to offer.
 *
 * These are four different facts about the world and the contract requires
 * them told apart, because the remedy differs and a wrong one is worse than
 * silence. A dead CTA on a question the product cannot answer is the same
 * dead end this module exists to remove, one screen further in.
 */
export type WebSearchSuggestionState =
  /**
   * The switch is off and at least one answering model can search. The only
   * state with a working primary action.
   */
  | "enable"
  /**
   * No model answering this question has a dispatchable search. Nothing to
   * switch on: the card explains and offers no search action.
   *
   * A model-swap action is deliberately not offered here. Changing the
   * selection writes `Conversation.selectedModels`, a column with no history
   * table, and takes a panel out of the conversation the answers are in --
   * the same unconfirmed write `startDeepResearch`'s cap dialog exists to
   * prevent. An offer to *check the web* must not silently be an offer to
   * rearrange the user's comparison.
   */
  | "unsupported"
  /**
   * The server refused the search itself. Today that is the operational
   * refusal `WEB_SEARCH_COST_UNBOUNDED` -- a provider whose per-search cost
   * has no enforceable worst case, or one latched off after billing past the
   * ceiling it was given (`lib/webSearchCeilingBreachStore.ts`). It is not
   * something the account can change and not something a retry fixes, so the
   * card says so and offers no retry.
   *
   * There is no workspace or administrator policy over web search in this
   * deployment; if one is ever added, it produces this state with its own
   * reason rather than a fifth one.
   */
  | "blocked"
  /** A re-run was attempted and failed. Retryable, with the question intact. */
  | "error";

/**
 * How a re-run ended, when it did not produce a search.
 *
 * Exactly the two card states a failed run can land on, so the caller cannot
 * report a failure this module has no way to render.
 */
export type WebSearchRetryFailure = Extract<
  WebSearchSuggestionState,
  "error" | "blocked"
>;

/** Whether this viewer could run a search at all, decided by the caller. */
export type WebSearchAvailability =
  | "available"
  /** No selected model has a dispatchable search. */
  | "unsupported"
  /** Refused server-side on operational grounds. */
  | "blocked";

export type WebSearchSuggestionTurn = {
  conversationId: string;
  promptId: string;
  text: string;
  attachments?: ReadonlyArray<{ name?: string; mediaType?: string }>;
  /** The user had the web-search switch on for this turn. */
  webSearchRequested: boolean;
  /**
   * Whether a search really ran, from `WebSearchExecution.executed` -- the
   * structured metadata the stream trailer carries, not a guess from the
   * switch. A provider that was asked and chose not to search reports false
   * here, and that turn is genuinely un-searched.
   */
  searchExecuted: boolean;
};

export type WebSearchSuggestionRefusal =
  /** Nothing has been asked yet in this conversation. */
  | "no_turn"
  /** The recorded question belongs to a conversation no longer on screen. */
  | "conversation_changed"
  /** The switch was already on for this turn. */
  | "already_requested"
  /** This turn searched. Offering a search would be offering what happened. */
  | "already_searched"
  /** At least one panel is still streaming. */
  | "still_generating"
  /** Everything settled and nothing usable came out of it. */
  | "no_usable_answer"
  /** Offered and answered for this question already, in this conversation. */
  | "resolved"
  /** Shown for this question already, under an earlier send. */
  | "already_offered"
  | "topic_not_suitable";

export type WebSearchSuggestion = {
  offered: boolean;
  /** Which of the four states the card renders. Null unless `offered`. */
  state: WebSearchSuggestionState | null;
  refusal: WebSearchSuggestionRefusal | null;
  /** The question a re-run would carry. Null unless `offered`. */
  promptId: string | null;
  text: string | null;
  topicKey: string | null;
  signals: readonly WebSearchTopicSignal[];
};

export type WebSearchSuggestionInput = {
  /** The conversation currently on screen. */
  conversationId: string | null;
  /** The last question asked in it, or null. */
  turn: WebSearchSuggestionTurn | null;
  selectedModelIds: readonly string[];
  disabledModelIds: readonly string[];
  /** Per-panel runtime status, the same map the comparison rail reads. */
  modelStatuses: Readonly<Record<string, ComparisonModelStatus | undefined>>;
  availability: WebSearchAvailability;
  /**
   * How a re-run this page started ended, or null if none has failed. Kept by
   * the caller against the question it failed for, so a stale failure cannot
   * attach itself to the next one.
   *
   * The *reason* rather than a boolean, and that distinction is the whole
   * point: `WEB_SEARCH_COST_UNBOUNDED` and a provider timeout both mean the
   * re-run did not happen, but only one of them can be fixed by pressing the
   * button again. A boolean here made every refusal look retryable, so a
   * request the server had already said it would never authorize came back
   * with a "try again" under it.
   */
  retryFailure: WebSearchRetryFailure | null;
  /** Questions this conversation has settled -- dismissed or re-run. */
  resolvedTopicKeys: readonly string[];
  /**
   * Questions this conversation has already shown the card for, each with the
   * send that did it.
   *
   * Same rule and same shape as the Deep Research offer's: being shown the
   * card is itself an answer to "have we asked?", and the promptId is what
   * keeps the entry written on appearance from refusing the card that wrote
   * it.
   */
  offeredTopics: readonly { topicKey: string; promptId: string }[];
};

const NOT_OFFERED = (
  refusal: WebSearchSuggestionRefusal
): WebSearchSuggestion => ({
  offered: false,
  state: null,
  refusal,
  promptId: null,
  text: null,
  topicKey: null,
  signals: [],
});

/**
 * Whether any model answering this question could actually search.
 *
 * Through `modelWebSearchIsDispatchable`, never through `support`: a native
 * tool whose worst-case cost cannot be bounded is not a search this product
 * may promise, and promising it anyway is the exact failure
 * `nativeSearchIsDispatchable` was written to end.
 */
export const anySelectedModelCanSearch = (input: {
  selectedModelIds: readonly string[];
  disabledModelIds: readonly string[];
  /**
   * Which application-managed search backends this deployment can reach.
   *
   * The card offers to re-run the question with search on, so it has to answer
   * the same question the composer answers. Without this it would offer the
   * re-run on a deployment holding no credential for the model's backend --
   * a dead CTA one screen later, which is the failure this card exists to
   * remove.
   */
  searchBackendReadiness: WebSearchBackendReadiness;
}) =>
  input.selectedModelIds
    .filter((modelId) => !input.disabledModelIds.includes(modelId))
    .some((modelId) =>
      modelWebSearchIsDispatchable(modelId, input.searchBackendReadiness)
    );

/**
 * The single decision both shells read.
 *
 * Called once per shell with that shell's own status map, exactly like
 * `deriveComparisonReadiness` and `deriveDeepResearchSuggestion` -- the panels
 * report to the shell, so the map lives there, and the rules live here so
 * desktop and mobile cannot come to disagree about when the card appears.
 *
 * ## Once per question, not once per answer
 *
 * A three-model comparison produces three answers to one question, and the
 * re-run is one send for the whole set. So the decision is keyed on
 * `turn.promptId` and the card is rendered once, in the bottom dock.
 *
 * ## Why the error state outranks everything below it
 *
 * A failed re-run is checked before the "already offered" and "resolved"
 * bookkeeping, because accepting the offer writes the question into
 * `resolvedTopicKeys` -- so by the time a failure comes back, every rule that
 * asks "have we already offered this?" says yes. Ordering the error first is
 * what keeps a failed attempt from silently swallowing the retry the contract
 * requires.
 */
export const deriveWebSearchSuggestion = (
  input: WebSearchSuggestionInput
): WebSearchSuggestion => {
  const { turn } = input;
  if (!turn) return NOT_OFFERED("no_turn");
  if (!input.conversationId || turn.conversationId !== input.conversationId) {
    return NOT_OFFERED("conversation_changed");
  }

  const topicKey = webSearchTopicKey(turn.text);
  const topic = classifyWebSearchTopic({
    text: turn.text,
    attachments: turn.attachments,
  });

  const offer = (state: WebSearchSuggestionState): WebSearchSuggestion => ({
    offered: true,
    state,
    refusal: null,
    promptId: turn.promptId,
    text: turn.text,
    topicKey,
    signals: topic.signals,
  });

  // The question still has to be one a search would help with: a re-run that
  // failed on "회의록 정리해줘" is a failure nobody needs told about here.
  if (!topic.suggested) return NOT_OFFERED("topic_not_suitable");

  // Before every other rule -- see the note above. The reason comes from the
  // caller because only the caller saw the refusal; this module's job is to
  // make sure it survives to the card rather than being flattened to "error".
  if (input.retryFailure) return offer(input.retryFailure);

  if (turn.webSearchRequested) return NOT_OFFERED("already_requested");
  if (turn.searchExecuted) return NOT_OFFERED("already_searched");

  if (input.resolvedTopicKeys.includes(topicKey)) {
    return NOT_OFFERED("resolved");
  }
  if (
    input.offeredTopics.some(
      (offered) =>
        offered.topicKey === topicKey && offered.promptId !== turn.promptId
    )
  ) {
    return NOT_OFFERED("already_offered");
  }

  // The same population the comparison rail draws from: selected, minus the
  // panels the user paused. A paused panel is outside the question.
  const active = input.selectedModelIds.filter(
    (modelId) => !input.disabledModelIds.includes(modelId)
  );
  let completed = 0;
  for (const modelId of active) {
    const status = input.modelStatuses[modelId];
    if (status === "loading" || status === "responding") {
      return NOT_OFFERED("still_generating");
    }
    if (status === "idle") completed += 1;
  }
  if (completed === 0) return NOT_OFFERED("no_usable_answer");

  if (input.availability === "blocked") return offer("blocked");
  if (input.availability === "unsupported") return offer("unsupported");
  return offer("enable");
};
