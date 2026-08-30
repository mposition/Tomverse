import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEP_RESEARCH_DEFAULT_DEPTH,
  DEEP_RESEARCH_MODEL_ID,
  classifyDeepResearchTopic,
  deepResearchTopicKey,
  deriveDeepResearchSuggestion,
} from "../lib/deepResearchSuggestion.ts";

/**
 * The offer's rules, executed.
 *
 * The card itself is one `if` in each shell over `offered`, so everything that
 * decides whether a person sees it is in this file's subject. Each test names
 * the requirement it holds rather than the branch it covers -- a branch can be
 * moved, and the requirement is what must survive the move.
 */

/* --------------------------------------------------------- the topic axis */

const RESEARCH_QUESTION =
  "2026년 국내 전기차 보조금 정책 변화를 여러 출처로 비교해서 정리해줘";

test("a question that asks for sources compared against each other is offered", () => {
  const decision = classifyDeepResearchTopic({ text: RESEARCH_QUESTION });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("explicit_research_request"));
  assert.ok(decision.signals.includes("multi_source_comparison"));
  assert.equal(decision.refusal, null);
});

test("market, policy, industry and academic depth each stand on their own", () => {
  for (const text of [
    "국내 이차전지 시장 규모와 점유율 현황을 정리해줘",
    "Summarise the competitive landscape for EU carbon border regulation",
    "이 분야 선행 연구와 문헌 조사를 정리해줘",
    "Give me a literature review of retrieval augmented generation",
  ]) {
    const decision = classifyDeepResearchTopic({ text });
    assert.equal(decision.suggested, true, text);
    assert.ok(decision.signals.includes("domain_depth"), text);
  }
});

test("claims that disagree with each other are a verification question", () => {
  for (const text of [
    "이 주제에 대해 상충하는 주장이 있는지 검증해줘",
    "The reports here seem conflicting -- which figures hold up?",
  ]) {
    const decision = classifyDeepResearchTopic({ text });
    assert.equal(decision.suggested, true, text);
    assert.ok(decision.signals.includes("claim_verification"), text);
  }
});

test("a simple fact check is not offered, however recent it is", () => {
  // Long enough to clear the floor, current-information-shaped, and still a
  // lookup. This is the case the offer must stay out of.
  const decision = classifyDeepResearchTopic({
    text: "오늘 서울 날씨가 어떤지 알려줘",
  });
  assert.equal(decision.suggested, false);
  assert.deepEqual([...decision.signals], ["recency"]);
  assert.equal(decision.refusal, "no_depth_signal");
});

test("recency plus a request for depth is a research question", () => {
  const decision = classifyDeepResearchTopic({
    text: "최근 반도체 공급망 상황을 자세히 설명해줘",
  });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("recency"));
});

test("code, writing and translation are never offered", () => {
  const cases = [
    ["```py\ndef f():\n  return 1\n```\n이 함수 버그 좀 고쳐줘", "coding"],
    ["Fix this TypeError in my typescript build please", "coding"],
    ["이 문단을 자연스럽게 다듬어서 블로그 글로 작성해줘", "writing_or_translation"],
    ["다음 문장을 영어로 번역해줘: 오늘 회의는 취소되었습니다", "writing_or_translation"],
  ];
  for (const [text, refusal] of cases) {
    const decision = classifyDeepResearchTopic({ text });
    assert.equal(decision.suggested, false, text);
    assert.equal(decision.refusal, refusal, text);
  }
});

test("a request for one line is not answered with a research report", () => {
  const decision = classifyDeepResearchTopic({
    text: "국내 이차전지 시장 규모를 한 줄로 요약해줘",
  });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "short_answer_requested");
});

test("a plain summary request carries no depth signal of its own", () => {
  const decision = classifyDeepResearchTopic({
    text: "위에 붙여 넣은 내용을 요약해줘",
  });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "no_depth_signal");
});

test("a turn shorter than the floor is not read at all", () => {
  const decision = classifyDeepResearchTopic({ text: "시장 동향" });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "too_short");
  assert.deepEqual([...decision.signals], []);
});

test("only fixed identifiers are reported, never anything from the text", () => {
  const decision = classifyDeepResearchTopic({ text: RESEARCH_QUESTION });
  const allowed = new Set([
    "explicit_research_request",
    "recency",
    "multi_source_comparison",
    "claim_verification",
    "domain_depth",
  ]);
  for (const signal of decision.signals) assert.ok(allowed.has(signal), signal);
});

/* ----------------------------------- the web search switch is not intent */

/**
 * Every rule above, asked again with the web search switch on.
 *
 * This is the axis production always supplies and this file used to leave out.
 * `ChatPageClient` records `webSearchRequested` on every turn, so the offer was
 * never decided by the input these tests were passing, and a turn that reads as
 * a lookup here reached a person as a card. The switch says "check the web
 * before answering", which is a setting; it is not someone asking for a dozen
 * sources to be compared, and on its own it must move nothing.
 */
const SWITCH_INVARIANT_CASES = [
  ["오늘 서울 날씨가 어떤지 알려줘", false],
  ["이 문단을 자연스럽게 다듬어줘", false],
  ["위에 붙여 넣은 내용을 요약해줘", false],
  ["국내 이차전지 시장 규모를 한 줄로 요약해줘", false],
  ["시장 동향", false],
  [RESEARCH_QUESTION, true],
  ["국내 이차전지 시장 규모와 점유율 현황을 정리해줘", true],
  ["최근 반도체 공급망 상황을 자세히 설명해줘", true],
  ["최근 시장 자료를 조사해서 분석 보고서를 작성해줘", true],
];

test("the web search switch changes no offer, in either position", () => {
  for (const [text, expected] of SWITCH_INVARIANT_CASES) {
    for (const webSearchRequested of [false, true]) {
      const decision = classifyDeepResearchTopic({ text, webSearchRequested });
      assert.equal(
        decision.suggested,
        expected,
        `${text} / webSearchRequested=${webSearchRequested}`
      );
    }
  }
});

test("a lookup asked with the switch on is still a lookup", () => {
  const decision = classifyDeepResearchTopic({
    text: "오늘 서울 날씨가 어떤지 알려줘",
    webSearchRequested: true,
  });
  assert.equal(decision.suggested, false);
  assert.deepEqual([...decision.signals], ["recency"]);
  assert.equal(decision.refusal, "no_depth_signal");
});

test("a request for sources is read from the text, and the switch is not one", () => {
  for (const webSearchRequested of [false, true]) {
    const decision = classifyDeepResearchTopic({
      text: RESEARCH_QUESTION,
      webSearchRequested,
    });
    assert.ok(
      decision.signals.includes("explicit_research_request"),
      String(webSearchRequested)
    );
  }
  const switchOnly = classifyDeepResearchTopic({
    text: "오늘 서울 날씨가 어떤지 알려줘",
    webSearchRequested: true,
  });
  assert.ok(!switchOnly.signals.includes("explicit_research_request"));
});

test("the switch does not turn a rewrite into a research question", () => {
  // The refusal reads `no_depth_signal` rather than `writing_or_translation`,
  // because with the switch on `kind: "research"` outranks `kind: "writing"` in
  // lib/taskProfileCore.ts and the writing exclusion never sees this turn. No
  // card under a rewrite is the requirement, and refusing on `writing:vocabulary`
  // to recover the label would cost the case below -- a research question that
  // happens to name its output format.
  const decision = classifyDeepResearchTopic({
    text: "이 문단을 자연스럽게 다듬어줘",
    webSearchRequested: true,
  });
  assert.equal(decision.suggested, false);
  assert.equal(decision.refusal, "no_depth_signal");
});

test("naming a report as the output format does not disqualify research", () => {
  const decision = classifyDeepResearchTopic({
    text: "최근 시장 자료를 조사해서 분석 보고서를 작성해줘",
    webSearchRequested: true,
  });
  assert.equal(decision.suggested, true);
  assert.ok(decision.signals.includes("domain_depth"));
});

/* ------------------------------------------------------------- the offer */

const TURN = {
  conversationId: "c1",
  promptId: "p1",
  text: RESEARCH_QUESTION,
};

const suggestion = (overrides = {}) =>
  deriveDeepResearchSuggestion({
    conversationId: "c1",
    turn: TURN,
    selectedModelIds: ["gpt-5-6-luna"],
    disabledModelIds: [],
    modelStatuses: { "gpt-5-6-luna": "idle" },
    availability: "available",
    isDeepResearchRunning: false,
    resolvedTopicKeys: [],
    offeredTopics: [],
    ...overrides,
  });

test("requirement 1: a completed answer to a suitable question is offered", () => {
  const decision = suggestion();
  assert.equal(decision.offered, true);
  assert.equal(decision.refusal, null);
  assert.equal(decision.promptId, "p1");
  assert.equal(decision.topicKey, deepResearchTopicKey(RESEARCH_QUESTION));
});

test("requirement 2: nothing is offered while an answer is still streaming", () => {
  for (const status of ["loading", "responding"]) {
    const decision = suggestion({ modelStatuses: { "gpt-5-6-luna": status } });
    assert.equal(decision.offered, false, status);
    assert.equal(decision.refusal, "still_generating", status);
  }
});

test("requirement 3: an unsuitable question is not offered even when complete", () => {
  const decision = suggestion({
    turn: { ...TURN, text: "다음 문장을 영어로 번역해줘: 회의는 취소되었습니다" },
  });
  assert.equal(decision.offered, false);
  assert.equal(decision.refusal, "topic_not_suitable");
});

test("requirement 4: a question already on Deep Research is never offered it", () => {
  assert.equal(
    suggestion({
      selectedModelIds: ["gpt-5-6-luna", DEEP_RESEARCH_MODEL_ID],
      modelStatuses: { "gpt-5-6-luna": "idle", [DEEP_RESEARCH_MODEL_ID]: "idle" },
    }).refusal,
    "already_deep_research"
  );
  assert.equal(
    suggestion({ isDeepResearchRunning: true }).refusal,
    "deep_research_in_progress"
  );
  // A send that was itself deep research records no turn, so there is nothing
  // for the offer to be about.
  assert.equal(suggestion({ turn: null }).refusal, "no_turn");
});

test("requirement 5: three panels answering one question produce one offer", () => {
  // The decision is keyed on the question, not on an answer: the same input
  // with three finished models is still a single `offered` carrying a single
  // promptId, and the shells render it once in the dock.
  const decision = suggestion({
    selectedModelIds: ["a", "b", "c"],
    modelStatuses: { a: "idle", b: "idle", c: "idle" },
  });
  assert.equal(decision.offered, true);
  assert.equal(decision.promptId, "p1");
});

test("requirement 5: one panel still working holds the whole offer back", () => {
  const decision = suggestion({
    selectedModelIds: ["a", "b", "c"],
    modelStatuses: { a: "idle", b: "idle", c: "responding" },
  });
  assert.equal(decision.offered, false);
  assert.equal(decision.refusal, "still_generating");
});

test("a paused panel is outside the question and does not hold it back", () => {
  const decision = suggestion({
    selectedModelIds: ["a", "b"],
    disabledModelIds: ["b"],
    modelStatuses: { a: "idle", b: "responding" },
  });
  assert.equal(decision.offered, true);
});

test("every answer failed leaves nothing to expand", () => {
  for (const statuses of [
    { a: "error", b: "cancelled" },
    { a: "error", b: "error" },
  ]) {
    const decision = suggestion({
      selectedModelIds: ["a", "b"],
      modelStatuses: statuses,
    });
    assert.equal(decision.offered, false);
    assert.equal(decision.refusal, "no_usable_answer");
  }
});

test("requirement 8: a settled topic stops being offered in this conversation", () => {
  const decision = suggestion({
    resolvedTopicKeys: [deepResearchTopicKey(RESEARCH_QUESTION)],
  });
  assert.equal(decision.offered, false);
  assert.equal(decision.refusal, "resolved");
});

test("requirement 8: a topic already shown is not offered under a later question", () => {
  const topicKey = deepResearchTopicKey(RESEARCH_QUESTION);
  const decision = suggestion({
    turn: { ...TURN, promptId: "p2" },
    offeredTopics: [{ topicKey, promptId: "p1" }],
  });
  assert.equal(decision.offered, false);
  assert.equal(decision.refusal, "already_offered");
});

test("requirement 8: the card that recorded the offer is not refused by it", () => {
  // The shells report "shown" the moment the card appears, so the entry is
  // written while its own card is still on screen. A rule that could not tell
  // the two apart would make the card vanish on the frame after it arrived.
  const decision = suggestion({
    offeredTopics: [
      { topicKey: deepResearchTopicKey(RESEARCH_QUESTION), promptId: "p1" },
    ],
  });
  assert.equal(decision.offered, true);
});

test("a different topic shown earlier does not silence this one", () => {
  const decision = suggestion({
    offeredTopics: [{ topicKey: "something else entirely", promptId: "p0" }],
  });
  assert.equal(decision.offered, true);
});

test("requirement 8: the topic key ignores case and surrounding whitespace", () => {
  assert.equal(
    deepResearchTopicKey("  Market Outlook For EV Batteries  "),
    deepResearchTopicKey("market outlook for ev batteries")
  );
  assert.equal(
    suggestion({
      turn: { ...TURN, text: `  ${RESEARCH_QUESTION}  ` },
      resolvedTopicKeys: [deepResearchTopicKey(RESEARCH_QUESTION)],
    }).refusal,
    "resolved"
  );
});

test("requirement 9: a viewer who cannot run Deep Research is offered nothing", () => {
  assert.equal(
    suggestion({ availability: "unavailable" }).refusal,
    "feature_unavailable"
  );
  assert.equal(
    suggestion({ availability: "sign_in_required" }).refusal,
    "sign_in_required"
  );
  assert.equal(suggestion({ availability: "plan_locked" }).refusal, "plan_locked");
  for (const availability of ["unavailable", "sign_in_required", "plan_locked"]) {
    assert.equal(suggestion({ availability }).offered, false, availability);
  }
});

test("a turn recorded in another conversation is not offered on this screen", () => {
  assert.equal(
    suggestion({ conversationId: "c2" }).refusal,
    "conversation_changed"
  );
  assert.equal(suggestion({ conversationId: null }).refusal, "conversation_changed");
});

test("a refused offer carries no question with it", () => {
  const decision = suggestion({ availability: "plan_locked" });
  assert.equal(decision.promptId, null);
  assert.equal(decision.text, null);
  assert.equal(decision.topicKey, null);
  assert.deepEqual([...decision.signals], []);
});

test("requirement 3: the switch travels with the turn, and a lookup is refused", () => {
  // The production shape: `ChatPageClient` records the switch on the turn, so
  // the offer has to be refused here, at the decision both shells call, and not
  // only in the classifier called without it.
  const decision = suggestion({
    turn: {
      ...TURN,
      text: "오늘 서울 날씨가 어떤지 알려줘",
      webSearchRequested: true,
    },
  });
  assert.equal(decision.offered, false);
  assert.equal(decision.refusal, "topic_not_suitable");
});

test("a research question asked with the switch on is still offered", () => {
  const decision = suggestion({ turn: { ...TURN, webSearchRequested: true } });
  assert.equal(decision.offered, true);
  assert.equal(decision.refusal, null);
});

test("the expansion runs at the depth the setup sheet opens on", () => {
  assert.equal(DEEP_RESEARCH_DEFAULT_DEPTH, "standard");
});
