"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";

import type { Language } from "@/lib/language";
import { promptRefinerCopy } from "@/lib/promptRefinerCopy";
import { diffPromptRefinerPreview } from "@/lib/promptRefinerPreviewDiff";
import {
  promptRefinerPromptProblem,
  visiblePromptRefinerState,
  type BoundPromptRefinerSuggestion,
  type PromptRefinerUiState,
} from "@/lib/promptRefinerSuggestion";

export type PromptRefinerInteractionBlockReason =
  | "composer_locked"
  | "composition_active";

export function PromptRefinerSuggestionPanel({
  offered,
  language,
  currentPrompt,
  state,
  interactionBlockReason = null,
  onRequest,
  onUseSuggestion,
  onKeepOriginal,
  onDismiss,
}: {
  /** One server-owned eligibility decision. False leaves no disabled teaser. */
  offered: boolean;
  language: Language;
  currentPrompt: string;
  state: PromptRefinerUiState;
  interactionBlockReason?: PromptRefinerInteractionBlockReason | null;
  onRequest: (sourcePrompt: string) => void;
  onUseSuggestion: (suggestion: BoundPromptRefinerSuggestion) => void;
  /** The state owner must leave `ready` after either decision. */
  onKeepOriginal: (suggestion: BoundPromptRefinerSuggestion) => void;
  /** Leave a failed request or read-only preview without changing the draft. */
  onDismiss: (requestId: string) => void;
}) {
  const copy = promptRefinerCopy[language] ?? promptRefinerCopy.en;
  const visible = visiblePromptRefinerState(state, currentPrompt);
  const readyRef = useRef<HTMLElement>(null);
  const requestingRef = useRef<HTMLDivElement>(null);
  const failedRetryRef = useRef<HTMLButtonElement>(null);
  const boundFocusTarget = !offered
    ? null
    : state.status === "requesting"
      ? `requesting:${state.request.requestId}`
      : state.status === "failed"
        ? `failed:${state.request.requestId}`
        : state.status === "ready"
          ? `ready:${state.suggestion.requestId}:${state.suggestion.suggestionId}`
          : null;
  const focusTarget = !offered
    ? null
    : visible?.status === "requesting"
      ? `requesting:${visible.request.requestId}`
      : visible?.status === "failed"
        ? `failed:${visible.request.requestId}`
        : visible?.status === "ready"
          ? `ready:${visible.suggestion.requestId}:${visible.suggestion.suggestionId}`
          : null;
  // Keep observed identity separate from visibility. A state that arrives
  // while the draft differs is observed but never queued for later focus; a
  // queued handoff that becomes hidden expires. Therefore editing back to the
  // exact source bytes cannot replay focus. Initialising from the first render
  // also prevents a remounted bound state from stealing focus on mount.
  const observedFocusTargetRef = useRef(boundFocusTarget);
  const pendingFocusTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusTarget) {
      observedFocusTargetRef.current = boundFocusTarget;
      pendingFocusTargetRef.current = null;
      return;
    }
    if (boundFocusTarget !== observedFocusTargetRef.current) {
      observedFocusTargetRef.current = boundFocusTarget;
      pendingFocusTargetRef.current = focusTarget;
    }
    if (pendingFocusTargetRef.current !== focusTarget) return;
    let focusElement: HTMLElement | null = null;
    if (focusTarget?.startsWith("requesting:")) {
      focusElement = requestingRef.current;
    } else if (focusTarget?.startsWith("failed:")) {
      focusElement = failedRetryRef.current?.disabled
        ? null
        : failedRetryRef.current;
    } else if (focusTarget?.startsWith("ready:")) {
      focusElement = readyRef.current;
    }
    if (!focusElement) return;
    focusElement.focus({ preventScroll: true });
    if (focusElement.ownerDocument.activeElement === focusElement) {
      pendingFocusTargetRef.current = null;
    }
  }, [boundFocusTarget, focusTarget, interactionBlockReason]);

  if (!offered) return null;

  const promptProblem = promptRefinerPromptProblem(currentPrompt);
  const requestProblemCopy =
    promptProblem === "empty"
      ? copy.promptEmpty
      : promptProblem === "too_many_characters"
        ? copy.promptTooManyCharacters
        : promptProblem === "too_many_bytes"
          ? copy.promptTooManyBytes
          : null;
  const interactionProblemCopy =
    interactionBlockReason === "composer_locked"
      ? copy.composerLocked
      : interactionBlockReason === "composition_active"
        ? copy.compositionActive
        : null;
  // IME composition flips on every Korean syllable. Keep visible row copy
  // stable during that transient state while retaining the reason in each
  // disabled control's accessible name.
  const visibleInteractionProblemCopy =
    interactionBlockReason === "composition_active"
      ? null
      : interactionProblemCopy;
  const interactionBlocked = interactionBlockReason !== null;

  // A changed draft invalidates every non-idle state. Render the ordinary
  // request action again, never the late proposal for the old bytes.
  if (!visible || visible.status === "idle") {
    return (
      <div
        data-testid="prompt-refiner-idle"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <span
          data-testid="prompt-refiner-request-description"
          className={`min-w-0 text-xs ${
            requestProblemCopy || visibleInteractionProblemCopy
              ? "text-amber-700 dark:text-amber-300"
              : "text-zinc-500 dark:text-zinc-400"
          }`}
        >
          {visibleInteractionProblemCopy ??
            requestProblemCopy ??
            copy.actionDescription}
        </span>
        <button
          type="button"
          data-testid="prompt-refiner-request"
          disabled={interactionBlocked || promptProblem !== null}
          aria-label={
            interactionProblemCopy || requestProblemCopy
              ? `${copy.action}. ${interactionProblemCopy ?? requestProblemCopy}`
              : copy.action
          }
          onClick={() => onRequest(currentPrompt)}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
          {copy.action}
        </button>
      </div>
    );
  }

  if (visible.status === "requesting") {
    return (
      <div
        ref={requestingRef}
        data-testid="prompt-refiner-requesting"
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        <Loader2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>{copy.requesting}</span>
      </div>
    );
  }

  if (visible.status === "failed") {
    return (
      <div
        data-testid="prompt-refiner-failed"
        role="status"
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"
      >
        <span className="min-w-0 flex-1">{copy.failed}</span>
        <button
          type="button"
          data-testid="prompt-refiner-dismiss-failed"
          disabled={interactionBlocked}
          aria-label={
            interactionProblemCopy
              ? `${copy.close}. ${interactionProblemCopy}`
              : copy.close
          }
          onClick={() => onDismiss(visible.request.requestId)}
          className="min-h-11 shrink-0 rounded-full border border-amber-300 bg-white px-3 font-bold transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-zinc-950 dark:hover:bg-amber-950/50"
        >
          {copy.close}
        </button>
        <button
          ref={failedRetryRef}
          type="button"
          data-testid="prompt-refiner-retry"
          disabled={interactionBlocked}
          aria-label={
            interactionProblemCopy
              ? `${copy.retry}. ${interactionProblemCopy}`
              : copy.retry
          }
          onClick={() => onRequest(visible.request.prompt)}
          className="min-h-11 shrink-0 rounded-full border border-amber-300 bg-white px-3 font-bold transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-zinc-950 dark:hover:bg-amber-950/50"
        >
          {copy.retry}
        </button>
      </div>
    );
  }

  const previewDiff = diffPromptRefinerPreview(
    visible.suggestion.sourcePrompt,
    visible.suggestion.refinedPrompt
  );

  if (visible.status === "accepted_preview") {
    return (
      <section
        data-testid="prompt-refiner-accepted-preview"
        role="status"
        aria-live="polite"
        aria-label={copy.comparisonLabel}
        className="min-w-0 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <p className="mb-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-200">
          {copy.originalLabel}
        </p>
        <p
          data-testid="prompt-refiner-accepted-preview-original"
          className="min-w-0 w-full max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-zinc-800 dark:text-zinc-100"
        >
          {previewDiff.commonPrefix}
          {previewDiff.removed ? (
            <del
              data-testid="prompt-refiner-accepted-preview-original-removed"
              className="rounded-sm bg-red-100 text-red-800 decoration-2 dark:bg-red-950/60 dark:text-red-200"
            >
              {previewDiff.removed}
            </del>
          ) : null}
          {previewDiff.commonSuffix}
        </p>
        <p className="mb-1.5 mt-3 text-xs font-bold text-zinc-700 dark:text-zinc-200">
          {copy.proposalLabel}
        </p>
        <p
          data-testid="prompt-refiner-accepted-preview-proposal"
          className="min-w-0 w-full max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-zinc-800 dark:text-zinc-100"
        >
          {previewDiff.commonPrefix}
          {previewDiff.added ? (
            <ins
              data-testid="prompt-refiner-accepted-preview-proposal-added"
              className="rounded-sm bg-blue-100 text-blue-900 decoration-2 underline dark:bg-blue-950/60 dark:text-blue-100"
            >
              {previewDiff.added}
            </ins>
          ) : null}
          {previewDiff.commonSuffix}
        </p>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {copy.previewOnly}
        </p>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            data-testid="prompt-refiner-dismiss-preview"
            disabled={interactionBlocked}
            aria-label={
              interactionProblemCopy
                ? `${copy.keepOriginal}. ${interactionProblemCopy}`
                : copy.keepOriginal
            }
            onClick={() => onDismiss(visible.suggestion.requestId)}
            className="min-h-11 rounded-full border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {copy.keepOriginal}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={readyRef}
      data-testid="prompt-refiner-ready"
      role="status"
      aria-live="polite"
      aria-label={copy.comparisonLabel}
      tabIndex={-1}
      className="min-w-0 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <p className="mb-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-200">
        {copy.originalLabel}
      </p>
      <p
        data-testid="prompt-refiner-original"
        className="min-w-0 w-full max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-zinc-800 dark:text-zinc-100"
      >
        {previewDiff.commonPrefix}
        {previewDiff.removed ? (
          <del
            data-testid="prompt-refiner-original-removed"
            className="rounded-sm bg-red-100 text-red-800 decoration-2 dark:bg-red-950/60 dark:text-red-200"
          >
            {previewDiff.removed}
          </del>
        ) : null}
        {previewDiff.commonSuffix}
      </p>
      <div className="mb-1.5 mt-3 flex items-center gap-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-200">
        <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
        {copy.proposalLabel}
      </div>
      <p
        data-testid="prompt-refiner-proposal"
        className="min-w-0 w-full max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-5 text-zinc-800 dark:text-zinc-100"
      >
        {previewDiff.commonPrefix}
        {previewDiff.added ? (
          <ins
            data-testid="prompt-refiner-proposal-added"
            className="rounded-sm bg-blue-100 text-blue-900 decoration-2 underline dark:bg-blue-950/60 dark:text-blue-100"
          >
            {previewDiff.added}
          </ins>
        ) : null}
        {previewDiff.commonSuffix}
      </p>
      {visibleInteractionProblemCopy ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {visibleInteractionProblemCopy}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="prompt-refiner-dismiss-ready"
          disabled={interactionBlocked}
          aria-label={
            interactionProblemCopy
              ? `${copy.close}. ${interactionProblemCopy}`
              : copy.close
          }
          onClick={() => onDismiss(visible.suggestion.requestId)}
          className="min-h-11 rounded-full border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {copy.close}
        </button>
        <button
          type="button"
          data-testid="prompt-refiner-keep-original"
          disabled={interactionBlocked}
          aria-label={
            interactionProblemCopy
              ? `${copy.keepOriginal}. ${interactionProblemCopy}`
              : copy.keepOriginal
          }
          onClick={() => onKeepOriginal(visible.suggestion)}
          className="min-h-11 rounded-full border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {copy.keepOriginal}
        </button>
        <button
          type="button"
          data-testid="prompt-refiner-use"
          disabled={interactionBlocked}
          aria-label={
            interactionProblemCopy
              ? `${copy.previewAction}. ${interactionProblemCopy}`
              : copy.previewAction
          }
          onClick={() => onUseSuggestion(visible.suggestion)}
          className="min-h-11 rounded-full bg-blue-600 px-3 text-xs font-bold text-white transition hover:bg-blue-500 disabled:opacity-50"
        >
          {copy.previewAction}
        </button>
      </div>
    </section>
  );
}
