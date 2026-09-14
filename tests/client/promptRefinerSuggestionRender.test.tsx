import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";

import { PromptRefinerSuggestionPanel } from "@/components/chat/PromptRefinerSuggestionPanel";
import { promptRefinerCopy } from "@/lib/promptRefinerCopy";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  type BoundPromptRefinerSuggestion,
} from "@/lib/promptRefinerSuggestion";

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const propsOf = (node: ReactNode, found: Record<string, unknown>[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Record<string, unknown> };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const findTestId = (node: ReactNode, id: string) =>
  propsOf(node).find((props) => props["data-testid"] === id);

const suggestion: BoundPromptRefinerSuggestion = {
  requestId: "request_1",
  suggestionId: "suggestion_1",
  sourcePrompt: "원문 질문",
  refinedPrompt: "목표와 출력 형식을 포함한 제안 문장",
  refinerVersion: "suggest-v1",
  inputScope: PROMPT_REFINER_INPUT_SCOPE,
};

const render = (overrides: Record<string, unknown> = {}) =>
  PromptRefinerSuggestionPanel({
    offered: true,
    language: "ko",
    currentPrompt: suggestion.sourcePrompt,
    state: { status: "ready", suggestion },
    onRequest: () => {},
    onUseSuggestion: () => {},
    onKeepOriginal: () => {},
    ...overrides,
  } as Parameters<typeof PromptRefinerSuggestionPanel>[0]);

test("not offered means no teaser, disabled row or layout cost", () => {
  assert.equal(render({ offered: false }), null);
});

test("a changed draft cannot render a late proposal", () => {
  const rendered = render({ currentPrompt: "원문 질문과 새 입력" });
  assert.equal(findTestId(rendered, "prompt-refiner-ready"), undefined);
  assert.ok(findTestId(rendered, "prompt-refiner-idle"));
});

test("the ready state shows proposal and two explicit choices", () => {
  const rendered = render();
  assert.ok(findTestId(rendered, "prompt-refiner-ready"));
  assert.equal(
    findTestId(rendered, "prompt-refiner-proposal")?.children,
    suggestion.refinedPrompt
  );
  assert.ok(findTestId(rendered, "prompt-refiner-use"));
  assert.ok(findTestId(rendered, "prompt-refiner-keep-original"));
  assert.equal(textOf(rendered).includes(suggestion.sourcePrompt), false);
});

test("requesting and failure copy promise that the original remains unchanged", () => {
  const request = {
    requestId: suggestion.requestId,
    prompt: suggestion.sourcePrompt,
  };
  const requesting = render({ state: { status: "requesting", request } });
  assert.ok(findTestId(requesting, "prompt-refiner-requesting"));
  assert.match(textOf(requesting), /원문은 그대로 유지/);
  const failed = render({
    state: { status: "failed", request, failureCode: "internal" },
  });
  assert.ok(findTestId(failed, "prompt-refiner-failed"));
  assert.match(textOf(failed), /원문은 바뀌지 않았/);
  assert.equal(textOf(failed).includes("internal"), false);
});

test("all seven locales offer explicit accept and keep-original decisions", () => {
  for (const language of Object.keys(promptRefinerCopy) as Array<
    keyof typeof promptRefinerCopy
  >) {
    const rendered = render({ language });
    const text = textOf(rendered);
    assert.ok(text.includes(promptRefinerCopy[language].useProposal), language);
    assert.ok(text.includes(promptRefinerCopy[language].keepOriginal), language);
  }
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
    const text = textOf(render({ language })).toLowerCase();
    for (const word of forbidden) {
      assert.equal(text.includes(word.toLowerCase()), false, `${language}: ${word}`);
    }
  }
});
