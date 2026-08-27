import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  arbitrateWebSearchOffer,
  WEB_SEARCH_SUPERSEDED_BY_DEEP_RESEARCH,
} from "../lib/answerSuggestionArbitration.ts";
import {
  classifyDeepResearchTopic,
  deriveDeepResearchSuggestion,
} from "../lib/deepResearchSuggestion.ts";
import {
  classifyWebSearchTopic,
  deriveWebSearchSuggestion,
} from "../lib/webSearchRetrySuggestion.ts";

/**
 * The rule that keeps one goal from becoming two paid offers.
 *
 * Each case runs the real classifiers and the real derive functions rather
 * than hand-built suggestion objects: what broke was not either module's own
 * logic but the belief that their outputs could not both be `offered`, and a
 * fixture asserting that belief would have passed while the screen showed two
 * cards.
 */

const CONVERSATION = "conv_arbitration";
const PROMPT = "prompt_arbitration";
const MODEL = "gpt-5-6-luna";

/**
 * The question this fix exists for: recency and a comparison request in one
 * sentence, which is the shape neither module refuses.
 */
const BOTH = "2026년 전고체 배터리 시장의 최신 자료를 비교해서 정리해줘";

/** The question the web search offer exists for, and a report must not take. */
const LIVE_LOOKUP = "오늘 서울 날씨 알려줘";

const webSearchInput = (text, overrides = {}) => ({
  conversationId: CONVERSATION,
  turn: {
    conversationId: CONVERSATION,
    promptId: PROMPT,
    text,
    webSearchRequested: false,
    searchExecuted: false,
  },
  selectedModelIds: [MODEL],
  disabledModelIds: [],
  modelStatuses: { [MODEL]: "idle" },
  availability: "available",
  retryFailure: null,
  resolvedTopicKeys: [],
  offeredTopics: [],
  ...overrides,
});

const deepResearchInput = (text, overrides = {}) => ({
  conversationId: CONVERSATION,
  turn: {
    conversationId: CONVERSATION,
    promptId: PROMPT,
    text,
    webSearchRequested: false,
  },
  selectedModelIds: [MODEL],
  disabledModelIds: [],
  modelStatuses: { [MODEL]: "idle" },
  availability: "available",
  isDeepResearchRunning: false,
  resolvedTopicKeys: [],
  offeredTopics: [],
  ...overrides,
});

/** Both offers for one question, arbitrated the way the shells arbitrate them. */
const offersFor = (text, { retryFailure = null } = {}) => {
  const deepResearch = deriveDeepResearchSuggestion(deepResearchInput(text));
  const webSearch = arbitrateWebSearchOffer({
    webSearch: deriveWebSearchSuggestion(webSearchInput(text, { retryFailure })),
    deepResearch,
    retryFailure,
  });
  return { webSearch, deepResearch };
};

/* ------------------------------------------------- the collision is real */

test("the reported question satisfies both classifiers", () => {
  // Without this the rest of the file would pass on a question that never
  // collided, which is how the original "they can never collide" test passed.
  const webSearch = classifyWebSearchTopic({ text: BOTH });
  const deepResearch = classifyDeepResearchTopic({ text: BOTH });

  assert.equal(webSearch.suggested, true);
  assert.ok(webSearch.signals.includes("recency"));
  assert.equal(deepResearch.suggested, true);
  assert.ok(deepResearch.signals.includes("recency"));
  assert.ok(deepResearch.signals.includes("multi_source_comparison"));
});

/* ----------------------------------------------------------- the rule */

test("a question that satisfies both is offered only Deep Research", () => {
  const { webSearch, deepResearch } = offersFor(BOTH);

  assert.equal(deepResearch.offered, true);
  assert.equal(webSearch.offered, false);
  assert.equal(webSearch.refusal, WEB_SEARCH_SUPERSEDED_BY_DEEP_RESEARCH);
});

test("the suppressed offer carries nothing the impression bookkeeping records", () => {
  // The shells write `offeredTopics` from these two fields. A card that was
  // never drawn must not answer "have we asked?" for a later turn.
  const { webSearch } = offersFor(BOTH);

  assert.equal(webSearch.topicKey, null);
  assert.equal(webSearch.promptId, null);
  assert.equal(webSearch.state, null);
  assert.deepEqual([...webSearch.signals], []);
});

/* ------------------------------------------- what must not be suppressed */

test("a plain live lookup keeps the search offer it exists for", () => {
  const { webSearch, deepResearch } = offersFor(LIVE_LOOKUP);

  assert.equal(deepResearch.offered, false);
  assert.equal(webSearch.offered, true);
  assert.equal(webSearch.state, "enable");
});

test("a failed re-run is still reported when Deep Research is offered", () => {
  // Reachable: a running Deep Research job refuses the expansion, so the search
  // card is shown and pressed; the job then finishes and the expansion becomes
  // offerable. Suppressing here would take the failure off screen.
  const { webSearch, deepResearch } = offersFor(BOTH, { retryFailure: "error" });

  assert.equal(deepResearch.offered, true);
  assert.equal(webSearch.offered, true);
  assert.equal(webSearch.state, "error");
});

test("an offer Deep Research does not contest is returned untouched", () => {
  const raw = deriveWebSearchSuggestion(webSearchInput(LIVE_LOOKUP));
  const arbitrated = arbitrateWebSearchOffer({
    webSearch: raw,
    deepResearch: deriveDeepResearchSuggestion(deepResearchInput(LIVE_LOOKUP)),
    retryFailure: null,
  });

  assert.equal(arbitrated, raw);
});

/* --------------------------------------------- both shells, one decision */

test("desktop and mobile arbitrate rather than rendering the raw offer", () => {
  for (const path of [
    "components/chat/DesktopChatShell.tsx",
    "components/chat/MobileChatShell.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.ok(
      source.includes("arbitrateWebSearchOffer({"),
      `${path} must arbitrate the web search offer`
    );
    assert.ok(
      !/const webSearchSuggestion = deriveWebSearchSuggestion\(/.test(source),
      `${path} must not render the underived offer`
    );
  }
});
