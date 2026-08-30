import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_SEARCH_UNAVAILABLE_PROMPT,
  buildWebSearchCapabilitySystemPrompt,
  resolveWebSearchTurnState,
} from "../lib/webSearchCapabilityPrompt.ts";

/**
 * What the model is told about the live web.
 *
 * The subject here is the instruction, not the answer it produces: a prompt
 * cannot be unit-tested for its effect on a provider. What can be held is that
 * the paragraph exists exactly on the turns that need it, that it forbids the
 * thing that went wrong, and that it does not quietly acquire the two claims
 * it must never make.
 */

/* ------------------------------------------------------------ which turns */

test("a turn with the native tool attached is a searching turn", () => {
  assert.equal(
    resolveWebSearchTurnState({
      modelId: "gpt-5-6-luna",
      nativeSearchEnabled: true,
    }),
    "searching"
  );
});

test("the same model with the switch off is not", () => {
  assert.equal(
    resolveWebSearchTurnState({
      modelId: "gpt-5-6-luna",
      nativeSearchEnabled: false,
    }),
    "unavailable"
  );
});

test("a model that searches inside its own completion is searching, flag or no flag", () => {
  // Perplexity attaches no tool, so the caller's flag is false for it. Reading
  // the flag alone would tell a model that is about to search that it cannot.
  for (const modelId of [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/sonar-reasoning-pro",
  ]) {
    assert.equal(
      resolveWebSearchTurnState({ modelId, nativeSearchEnabled: false }),
      "searching",
      modelId
    );
  }
});

test("a model with no search this request may carry is unavailable", () => {
  for (const modelId of [
    // Nobody confirmed it can search.
    "gpt-5-4-mini",
    // No search at all.
    "grok-4-5",
  ]) {
    assert.equal(
      resolveWebSearchTurnState({ modelId, nativeSearchEnabled: false }),
      "unavailable",
      modelId
    );
  }
});

test("a turn carrying this application's own search tool is a searching turn", () => {
  // The contradiction this flag exists to prevent. Without it a Gemini turn
  // would be handed `WEB_SEARCH_UNAVAILABLE_PROMPT` -- told, in the same
  // request that carries a working `web_search` tool, that nothing in its
  // answer can come from the live web. The model would then either obey the
  // block and refuse to search, or search and open by saying it could not.
  for (const modelId of [
    "gemini-3-7-flash",
    "gemini-3-6-flash",
    "gemini-3-1-pro",
    "gemini-2-5-flash",
  ]) {
    assert.equal(
      resolveWebSearchTurnState({
        modelId,
        nativeSearchEnabled: false,
        appManagedSearchEnabled: true,
      }),
      "searching",
      modelId
    );
    assert.equal(
      buildWebSearchCapabilitySystemPrompt(
        resolveWebSearchTurnState({
          modelId,
          nativeSearchEnabled: false,
          appManagedSearchEnabled: true,
        })
      ),
      "",
      `${modelId}: a searching turn gets no "cannot search" paragraph`
    );
  }
});

test("the same model with the tool not registered is unavailable again", () => {
  // Off, or a deployment with no reachable backend. The caller's flag is the
  // whole input: this module does not re-derive dispatchability, so it cannot
  // disagree with the plan that decided it.
  assert.equal(
    resolveWebSearchTurnState({
      modelId: "gemini-3-6-flash",
      nativeSearchEnabled: false,
      appManagedSearchEnabled: false,
    }),
    "unavailable"
  );
});

/* -------------------------------------------------------------- the block */

/*
  Read with newlines collapsed. The paragraph is stored as wrapped lines for
  readability, and a rule that broke because a sentence happened to straddle a
  wrap would be a test about formatting rather than about the instruction.
*/
const prose = () =>
  WEB_SEARCH_UNAVAILABLE_PROMPT.replace(/\s+/g, " ").toLowerCase();

test("a searching turn is given no paragraph at all", () => {
  assert.equal(buildWebSearchCapabilitySystemPrompt("searching"), "");
});

test("a turn that cannot search is given the paragraph", () => {
  assert.equal(
    buildWebSearchCapabilitySystemPrompt("unavailable"),
    WEB_SEARCH_UNAVAILABLE_PROMPT
  );
  assert.ok(WEB_SEARCH_UNAVAILABLE_PROMPT.includes("# Current information"));
});

test("it forbids handing the search back to the user, anywhere", () => {
  /*
    Two staging observations, 2026-08-27, and the second is why this rule names
    no destination:

      기상청 날씨누리나 휴대폰 날씨 앱에서 서울을 검색해 확인해 주세요.
      앱에서 실시간 날씨를 요청해 주시면 최신 정보를 바탕으로 안내해 드릴게요.

    A block that forbade only the first moved the sentence indoors. What is
    wrong with it is not where it points but that it points at all.
  */
  const text = prose();
  assert.ok(text.includes("do not tell the user to go and get the information"));
  assert.ok(text.includes("anywhere"));
  assert.ok(text.includes("search engine"));
  assert.ok(text.includes("check the official"));
  // The half that was missing the first time.
  assert.ok(text.includes("not in this interface either"));
  assert.ok(text.includes("re-send the question"));
});

test("it requires an answer, not just a report of the limit", () => {
  /*
    The same run showed the other half not landing: the answer stopped at
    "실시간 날씨 정보에는 접근할 수 없어" and said nothing about what late-August
    Seoul is usually like. Permissive wording produced a refusal; this is
    imperative.
  */
  const text = prose();
  assert.ok(text.includes("then answer the question"));
  assert.ok(text.includes("never stop at the limitation"));
});

test("it forbids claiming a search that did not happen", () => {
  const text = prose();
  assert.ok(text.includes("never say or imply that you searched"));
  assert.ok(text.includes("never give a live figure"));
});

test("it never describes the offer the interface renders", () => {
  /*
    Deliberate, and the same rule the image block reached: a sentence cannot
    know whether this viewer's models can search, cannot carry the question,
    and cannot press itself. Describing the card would have the model promise
    something that may not appear -- and every string it could name lives in
    `locales/*.ts`, in seven languages this file does not read.
  */
  const text = prose();
  for (const forbidden of [
    "button",
    "click",
    "tap",
    "below your answer",
    "card",
    "웹에서 확인",
  ]) {
    assert.ok(!text.includes(forbidden), `names the control: ${forbidden}`);
  }
});

test("it does not tell the model to apologise or to pad the refusal", () => {
  // The answer is still worth writing. The limit is one short sentence, then
  // what general knowledge can honestly give.
  const text = prose();
  assert.ok(text.includes("one short sentence"));
  assert.ok(text.includes("honest general knowledge"));
  assert.ok(!text.includes("apolog"));
});

test("the paragraph stays small enough to sit on every non-searching turn", () => {
  // It is priced input on the majority of turns. A guard rather than a
  // measurement: what matters is that it cannot quietly grow into a page.
  assert.ok(WEB_SEARCH_UNAVAILABLE_PROMPT.length < 1200);
});
