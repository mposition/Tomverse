import assert from "node:assert/strict";
import test from "node:test";

import {
  anySelectedModelCanSearch,
  classifyWebSearchTopic,
  deriveWebSearchSuggestion,
  webSearchTopicKey,
} from "../lib/webSearchRetrySuggestion.ts";
import { classifyDeepResearchTopic } from "../lib/deepResearchSuggestion.ts";

/**
 * The offer's rules, executed.
 *
 * The card itself is one `if` in each shell over `offered` plus a switch over
 * `state`, so everything that decides what a person sees is in this file's
 * subject. Each test names the requirement it holds rather than the branch it
 * covers -- a branch can be moved, and the requirement is what must survive
 * the move.
 */

/* --------------------------------------------------------- the topic axis */

const WEATHER = "오늘 서울 날씨 알려줘";

test("the question this feature exists for is offered a search", () => {
  const decision = classifyWebSearchTopic({ text: WEATHER });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("recency"));
});

test("the same question is refused a research report, so the two offers never collide", () => {
  // The whole reason this module is not a second flavour of the Deep Research
  // card: recency alone is the one signal that offer will not act on, and it
  // is the only signal this one needs.
  assert.equal(classifyDeepResearchTopic({ text: WEATHER }).suggested, false);
  assert.equal(classifyWebSearchTopic({ text: WEATHER }).suggested, true);
});

test("English recency wording is read, not only Korean", () => {
  const decision = classifyWebSearchTopic({
    text: "what is the weather in Seoul today",
  });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("recency"));
});

test("an explicit request for sources is its own signal", () => {
  const decision = classifyWebSearchTopic({
    text: "이 내용 출처를 알려줘",
  });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("explicit_search_request"));
});

test("opening hours are a live lookup even with no recency word", () => {
  const decision = classifyWebSearchTopic({
    text: "강남 교보문고 영업시간 알려줘",
  });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("live_lookup"));
});

test("a match result is a live lookup", () => {
  for (const text of [
    "어제 손흥민 경기 결과 어떻게 됐어",
    "who won the match last night",
  ]) {
    assert.equal(classifyWebSearchTopic({ text }).suggested, true, text);
  }
});

test("a rule question needs a currency word before it counts as a live lookup", () => {
  // A definition is not a request for this week's version of the rule.
  const definition = classifyWebSearchTopic({
    text: "규제 샌드박스라는 제도가 무엇인지 개념을 설명해줘",
  });
  assert.equal(definition.signals.includes("live_lookup"), false);
  const current = classifyWebSearchTopic({
    text: "지금 전기차 보조금 규정이 어떻게 되는지 알려줘",
  });
  assert.ok(current.signals.includes("live_lookup"));
});

test("an ordinary question gets no offer", () => {
  const decision = classifyWebSearchTopic({
    text: "재귀 함수와 반복문의 차이를 설명해줘",
  });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "no_recency_signal");
});

test("a rewrite request is set aside: the work is the text, not the facts", () => {
  const decision = classifyWebSearchTopic({
    text: "이 문단을 더 자연스럽게 다시 써줘",
  });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "writing_or_translation");
});

test("a fragment shorter than the floor is not read", () => {
  const decision = classifyWebSearchTopic({ text: "오늘" });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "too_short");
});

test("the classifier never reads the switch, so its signal cannot be a tautology", () => {
  // `buildTaskProfile` sets `needsCurrentInformation` for any turn that had
  // search requested. If that reached this classifier, every turn the switch
  // was on for would report `recency` -- and those are exactly the turns the
  // offer must stay away from.
  const decision = classifyWebSearchTopic({
    text: "재귀 함수와 반복문의 차이를 설명해줘",
  });
  assert.equal(decision.signals.includes("recency"), false);
});

test("the topic key is stable across whitespace and case", () => {
  assert.equal(webSearchTopicKey("  Seoul Weather  "), "seoul weather");
});

/* ------------------------------------------------------------- the offer */

const READY = {
  conversationId: "conv-1",
  selectedModelIds: ["gpt-5-6-luna"],
  disabledModelIds: [],
  modelStatuses: { "gpt-5-6-luna": "idle" },
  availability: "available",
  retryFailure: null,
  resolvedTopicKeys: [],
  offeredTopics: [],
};

const turn = (overrides = {}) => ({
  conversationId: "conv-1",
  promptId: "prompt-1",
  text: WEATHER,
  webSearchRequested: false,
  searchExecuted: false,
  ...overrides,
});

test("search off, a model that can search, a finished answer -> the actionable card", () => {
  const suggestion = deriveWebSearchSuggestion({ ...READY, turn: turn() });
  assert.equal(suggestion.offered, true);
  assert.equal(suggestion.state, "enable");
  assert.equal(suggestion.text, WEATHER);
});

test("a turn that had the switch on is never offered a search", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    turn: turn({ webSearchRequested: true }),
  });
  assert.equal(suggestion.offered, false);
  assert.equal(suggestion.refusal, "already_requested");
});

test("a turn that really searched is never offered a search", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    turn: turn({ searchExecuted: true }),
  });
  assert.equal(suggestion.offered, false);
  assert.equal(suggestion.refusal, "already_searched");
});

test("no answering model can search -> the card states it and offers no search", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    availability: "unsupported",
    turn: turn(),
  });
  assert.equal(suggestion.offered, true);
  assert.equal(suggestion.state, "unsupported");
});

test("a server-side refusal -> the blocked state, not a retry", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    availability: "blocked",
    turn: turn(),
  });
  assert.equal(suggestion.state, "blocked");
});

test("a failed re-run keeps the question and offers a retry", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    retryFailure: "error",
    // The re-run's own turn: it had the switch on and did not search.
    turn: turn({ promptId: "prompt-2", webSearchRequested: true }),
  });
  assert.equal(suggestion.state, "error");
  assert.equal(suggestion.text, WEATHER);
});

test("a refusal the account cannot lift keeps its own state through the error branch", () => {
  /*
    The failed-run branch runs before everything else, so it is also where a
    `blocked` refusal would be flattened into a retryable `error` if the reason
    did not travel with it. It did once, and the card offered a retry for a
    search the server had already said it would never authorize.
  */
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    retryFailure: "blocked",
    turn: turn({ promptId: "prompt-2", webSearchRequested: true }),
  });
  assert.equal(suggestion.state, "blocked");
});

test("the error state outranks the bookkeeping that accepting the offer wrote", () => {
  // Accepting resolves the topic. If `resolved` were checked first, a failed
  // re-run could never be reported at all.
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    retryFailure: "error",
    resolvedTopicKeys: [webSearchTopicKey(WEATHER)],
    offeredTopics: [
      { topicKey: webSearchTopicKey(WEATHER), promptId: "prompt-1" },
    ],
    turn: turn({ promptId: "prompt-2", webSearchRequested: true }),
  });
  assert.equal(suggestion.state, "error");
});

test("a question that was answered for stops asking", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    resolvedTopicKeys: [webSearchTopicKey(WEATHER)],
    turn: turn(),
  });
  assert.equal(suggestion.offered, false);
  assert.equal(suggestion.refusal, "resolved");
});

test("a question already shown under an earlier send is not shown again", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    offeredTopics: [
      { topicKey: webSearchTopicKey(WEATHER), promptId: "prompt-0" },
    ],
    turn: turn(),
  });
  assert.equal(suggestion.refusal, "already_offered");
});

test("the entry written the moment the card appears does not refuse that card", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    offeredTopics: [
      { topicKey: webSearchTopicKey(WEATHER), promptId: "prompt-1" },
    ],
    turn: turn({ promptId: "prompt-1" }),
  });
  assert.equal(suggestion.offered, true);
});

test("nothing is offered while a panel is still streaming", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    modelStatuses: { "gpt-5-6-luna": "responding" },
    turn: turn(),
  });
  assert.equal(suggestion.refusal, "still_generating");
});

test("a paused panel is outside the question", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    selectedModelIds: ["gpt-5-6-luna", "claude-sonnet-5"],
    disabledModelIds: ["claude-sonnet-5"],
    modelStatuses: { "gpt-5-6-luna": "idle", "claude-sonnet-5": "responding" },
    turn: turn(),
  });
  assert.equal(suggestion.offered, true);
});

test("a conversation switch drops the offer instead of following the user", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    conversationId: "conv-2",
    turn: turn(),
  });
  assert.equal(suggestion.refusal, "conversation_changed");
});

test("an ordinary question is never offered a search, whatever else is true", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    turn: turn({ text: "재귀 함수와 반복문의 차이를 설명해줘" }),
  });
  assert.equal(suggestion.offered, false);
  assert.equal(suggestion.refusal, "topic_not_suitable");
});

test("a failed re-run of an ordinary question still shows nothing", () => {
  const suggestion = deriveWebSearchSuggestion({
    ...READY,
    retryFailure: "error",
    turn: turn({ text: "재귀 함수와 반복문의 차이를 설명해줘" }),
  });
  assert.equal(suggestion.offered, false);
});

/* ------------------------------------------------------- the capability */

test("availability reads the dispatchable capability, not the provider's brochure", () => {
  // Gemini's grounding is `support: "native"` and has no ceiling to reserve
  // against, so `nativeSearchIsDispatchable` refuses it -- and this offer must
  // refuse it too, or it promises a search the dispatch will reject.
  assert.equal(
    anySelectedModelCanSearch({
      selectedModelIds: ["gemini-3-1-pro"],
      disabledModelIds: [],
    }),
    false
  );
  assert.equal(
    anySelectedModelCanSearch({
      selectedModelIds: ["gpt-5-6-luna"],
      disabledModelIds: [],
    }),
    true
  );
});

test("a paused searching model does not make the selection searchable", () => {
  assert.equal(
    anySelectedModelCanSearch({
      selectedModelIds: ["gpt-5-6-luna", "gpt-5-4-mini"],
      disabledModelIds: ["gpt-5-6-luna"],
    }),
    false
  );
});
