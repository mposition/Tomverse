"use client";

import { useRef, useState } from "react";

import { PromptRefinerSuggestionPanel } from "@/components/chat/PromptRefinerSuggestionPanel";
import {
  PROMPT_REFINER_INPUT_SCOPE,
  type BoundPromptRefinerSuggestion,
  type PromptRefinerUiState,
} from "@/lib/promptRefinerSuggestion";

const SOURCE_PROMPT = "원문 질문";

const suggestionFor = (
  requestId: string,
  suggestionId: string
): BoundPromptRefinerSuggestion => ({
  requestId,
  suggestionId,
  sourcePrompt: SOURCE_PROMPT,
  refinedPrompt: "목표와 출력 형식을 포함한 제안 문장",
  refinerVersion: "suggest-v1",
  inputScope: PROMPT_REFINER_INPUT_SCOPE,
});

export function PromptRefinerFocusHarness({
  initialState,
}: {
  initialState: "idle" | "ready";
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestSequence = useRef(0);
  const [draft, setDraft] = useState(SOURCE_PROMPT);
  const [state, setState] = useState<PromptRefinerUiState>(() =>
    initialState === "ready"
      ? { status: "ready", suggestion: suggestionFor("request_mount", "suggestion_mount") }
      : { status: "idle" }
  );

  const finishRequest = () => {
    if (state.status !== "requesting") return;
    setState({
      status: "ready",
      suggestion: suggestionFor(
        state.request.requestId,
        `suggestion_${state.request.requestId}`
      ),
    });
  };

  const failRequest = () => {
    if (state.status !== "requesting") return;
    setState({
      status: "failed",
      request: state.request,
      failureCode: "fixture_failure",
    });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-3 p-4">
      <label htmlFor="prompt-refiner-fixture-textarea" className="text-sm font-bold">
        Prompt Refiner focus fixture
      </label>
      <PromptRefinerSuggestionPanel
        offered
        language="ko"
        currentPrompt={draft}
        state={state}
        onRequest={(sourcePrompt) => {
          requestSequence.current += 1;
          setState({
            status: "requesting",
            request: {
              requestId: `request_${requestSequence.current}`,
              prompt: sourcePrompt,
            },
          });
        }}
        onUseSuggestion={() => {
          setState({ status: "idle" });
          requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        }}
        onKeepOriginal={() => {
          setState({ status: "idle" });
          requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        }}
      />
      <textarea
        ref={textareaRef}
        id="prompt-refiner-fixture-textarea"
        data-testid="prompt-refiner-fixture-textarea"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-24 rounded-xl border border-zinc-300 p-3"
      />
      <button
        type="button"
        data-testid="prompt-refiner-fixture-ready"
        onClick={finishRequest}
        className="min-h-11 rounded-xl border border-zinc-300 px-3"
      >
        Resolve fixture request
      </button>
      <button
        type="button"
        data-testid="prompt-refiner-fixture-failed"
        onClick={failRequest}
        className="min-h-11 rounded-xl border border-zinc-300 px-3"
      >
        Fail fixture request
      </button>
    </main>
  );
}
