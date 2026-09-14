import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PromptRefinerSuggestionPanel } from "@/components/chat/PromptRefinerSuggestionPanel";
import { promptRefinerCopy } from "@/lib/promptRefinerCopy";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  type BoundPromptRefinerSuggestion,
} from "@/lib/promptRefinerSuggestion";

const hasTestId = (markup: string, id: string) =>
  markup.includes(`data-testid="${id}"`);
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, " ");

const suggestion: BoundPromptRefinerSuggestion = {
  requestId: "request_1",
  suggestionId: "suggestion_1",
  sourcePrompt: "원문 질문",
  refinedPrompt: "목표와 출력 형식을 포함한 제안 문장",
  refinerVersion: "suggest-v1",
  inputScope: PROMPT_REFINER_INPUT_SCOPE,
};

const render = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(PromptRefinerSuggestionPanel, {
      offered: true,
      language: "ko",
      currentPrompt: suggestion.sourcePrompt,
      state: { status: "ready", suggestion },
      onRequest: () => {},
      onUseSuggestion: () => {},
      onKeepOriginal: () => {},
      ...overrides,
    } as Parameters<typeof PromptRefinerSuggestionPanel>[0])
  );

test("not offered means no teaser, disabled row or layout cost", () => {
  assert.equal(render({ offered: false }), "");
});

test("a changed draft cannot render a late proposal", () => {
  const rendered = render({ currentPrompt: "원문 질문과 새 입력" });
  assert.equal(hasTestId(rendered, "prompt-refiner-ready"), false);
  assert.equal(hasTestId(rendered, "prompt-refiner-idle"), true);
});

test("the ready state shows proposal and two explicit choices", () => {
  const rendered = render();
  assert.equal(hasTestId(rendered, "prompt-refiner-ready"), true);
  assert.equal(rendered.includes(suggestion.refinedPrompt), true);
  assert.equal(hasTestId(rendered, "prompt-refiner-use"), true);
  assert.equal(hasTestId(rendered, "prompt-refiner-keep-original"), true);
  assert.equal(rendered.includes(suggestion.sourcePrompt), false);
  assert.match(rendered, /role="status"/);
  assert.match(rendered, /aria-live="polite"/);
  assert.match(rendered, /tabindex="-1"/);
  assert.equal((rendered.match(/min-h-11/g) ?? []).length, 2);
});

test("requesting and failure copy promise that the original remains unchanged", () => {
  const request = {
    requestId: suggestion.requestId,
    prompt: suggestion.sourcePrompt,
  };
  const requesting = render({ state: { status: "requesting", request } });
  assert.equal(hasTestId(requesting, "prompt-refiner-requesting"), true);
  assert.match(requesting, /원문은 그대로 유지/);
  assert.match(requesting, /tabindex="-1"/);
  const failed = render({
    state: { status: "failed", request, failureCode: "internal" },
  });
  assert.equal(hasTestId(failed, "prompt-refiner-failed"), true);
  assert.match(failed, /원문은 바뀌지 않았/);
  assert.equal(failed.includes("internal"), false);
  assert.equal((failed.match(/min-h-11/g) ?? []).length, 1);
});

test("all seven locales offer explicit accept and keep-original decisions", () => {
  for (const language of Object.keys(promptRefinerCopy) as Array<
    keyof typeof promptRefinerCopy
  >) {
    const rendered = render({ language });
    assert.ok(rendered.includes(promptRefinerCopy[language].useProposal), language);
    assert.ok(rendered.includes(promptRefinerCopy[language].keepOriginal), language);
  }
});

test("request refusal is visible, bounded by the request schema, and has a 44px target", () => {
  const idle = { status: "idle" as const };
  const empty = render({ currentPrompt: "", state: idle });
  assert.match(empty, /disabled=""/);
  assert.ok(empty.includes(promptRefinerCopy.ko.promptEmpty));
  assert.equal((empty.match(/min-h-11/g) ?? []).length, 1);

  const tooLong = render({ currentPrompt: "a".repeat(16_001), state: idle });
  assert.ok(tooLong.includes(promptRefinerCopy.ko.promptTooManyCharacters));
  assert.match(tooLong, /disabled=""/);

  const tooLarge = render({ currentPrompt: "한".repeat(11_000), state: idle });
  assert.ok(tooLarge.includes(promptRefinerCopy.ko.promptTooManyBytes));
  assert.match(tooLarge, /disabled=""/);
});

test("a blocked decision states its reason instead of exposing a dead control", () => {
  const rendered = render({ interactionBlockReason: "composition_active" });
  assert.ok(rendered.includes(promptRefinerCopy.ko.compositionActive));
  assert.equal((rendered.match(/disabled=""/g) ?? []).length, 2);
});

test("IME composition keeps the idle row's visible copy stable", () => {
  const idle = { status: "idle" as const };
  const ordinary = render({ state: idle });
  const composing = render({
    state: idle,
    interactionBlockReason: "composition_active",
  });
  assert.ok(visibleText(ordinary).includes(promptRefinerCopy.ko.actionDescription));
  assert.ok(visibleText(composing).includes(promptRefinerCopy.ko.actionDescription));
  assert.equal(
    visibleText(composing).includes(promptRefinerCopy.ko.compositionActive),
    false
  );
  assert.ok(composing.includes(promptRefinerCopy.ko.compositionActive));
});

test("rendered copy never names the internal refiner model or makes a superiority claim", () => {
  const forbidden = [
    "provider",
    "model",
    "best",
    "optimal",
    "smartest",
    "가장 좋은",
    "최적",
    "gpt",
    "claude",
  ];
  for (const language of Object.keys(promptRefinerCopy) as Array<
    keyof typeof promptRefinerCopy
  >) {
    const text = render({ language }).toLowerCase();
    for (const word of forbidden) {
      assert.equal(text.includes(word.toLowerCase()), false, `${language}: ${word}`);
    }
  }
});
