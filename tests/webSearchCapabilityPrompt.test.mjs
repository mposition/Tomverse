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
    // Native, but its per-query cost has no enforceable worst case, so the
    // dispatch refuses it and the caller's flag is false.
    "gemini-3-1-pro",
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

/* -------------------------------------------------------------- the block */

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

test("it forbids handing the search back to the user", () => {
  /*
    The failure this block exists for, in the model's own words on 2026-08-27:
    "기상청 날씨누리나 휴대폰 날씨 앱에서 서울을 검색해 확인해 주세요." A search
    engine is one control away from the user; naming it is the app declining
    work it is built to do.
  */
  const text = WEB_SEARCH_UNAVAILABLE_PROMPT.toLowerCase();
  assert.ok(text.includes("do not send the user elsewhere"));
  assert.ok(text.includes("search engines"));
  assert.ok(text.includes("check the official page"));
});

test("it forbids claiming a search that did not happen", () => {
  const text = WEB_SEARCH_UNAVAILABLE_PROMPT.toLowerCase();
  assert.ok(text.includes("never say or imply that you searched"));
  assert.ok(text.includes("never give a current figure"));
});

test("it never describes the offer the interface renders", () => {
  /*
    Deliberate, and the same rule the image block reached: a sentence cannot
    know whether this viewer's models can search, cannot carry the question,
    and cannot press itself. Describing the card would have the model promise
    something that may not appear -- and every string it could name lives in
    `locales/*.ts`, in seven languages this file does not read.
  */
  const text = WEB_SEARCH_UNAVAILABLE_PROMPT.toLowerCase();
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
  // The answer is still worth writing. The limit is one sentence, then what
  // general knowledge can honestly give.
  const text = WEB_SEARCH_UNAVAILABLE_PROMPT.toLowerCase();
  assert.ok(text.includes("one sentence"));
  assert.ok(text.includes("then give what you can from general knowledge"));
  assert.ok(!text.includes("apolog"));
});

test("the paragraph stays small enough to sit on every non-searching turn", () => {
  // It is priced input on the majority of turns. A guard rather than a
  // measurement: what matters is that it cannot quietly grow into a page.
  assert.ok(WEB_SEARCH_UNAVAILABLE_PROMPT.length < 900);
});
