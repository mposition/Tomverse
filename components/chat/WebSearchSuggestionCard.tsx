"use client";

import { Globe } from "lucide-react";

import type { WebSearchSuggestionCopy } from "@/components/chat/webSearchSuggestionCopy";
import type { WebSearchSuggestionState } from "@/lib/webSearchRetrySuggestion";

/**
 * The offer to answer this question again with web search on.
 *
 * Decision: `lib/webSearchRetrySuggestion.ts`. This component renders what
 * that module decided and nothing else -- it has no rule of its own about when
 * an offer is appropriate, so desktop and mobile cannot drift.
 *
 * ## Shape borrowed, decision not
 *
 * Structurally this is `DeepResearchSuggestionCard`: the same region in the
 * bottom dock, the same icon-plus-text-plus-actions row, the same polite live
 * region, the same fixed ids. That is deliberate -- the contract asks for the
 * two offers to be visually and behaviourally consistent, and two cards that
 * sit in the same place should not have two different keyboard orders.
 *
 * What is not shared is the accent. Deep Research owns violet
 * (`accent-deep-research-*`) and web search owns sky (`accent-web-search-*`);
 * AGENTS.md keeps roles separate even where the values agree, and here they do
 * not even agree. Sharing a component would have meant one of the two roles
 * borrowing the other's colour or a `role` prop threading a token name through
 * markup, which is how a reserved gradient escapes.
 *
 * ## What it must not look like
 *
 * Not a warning, in any state. The `unsupported` and `blocked` states are
 * telling the user something the product cannot do, and dressing that in red
 * would read as an error they caused. `role="region"` with a name, never
 * `role="alert"`, and it never moves focus -- someone already typing their
 * next question must not lose the caret to a card that appeared under them.
 *
 * ## Why `primary` can be null
 *
 * `unsupported` and `blocked` render no primary button at all rather than a
 * disabled one. A disabled "웹에서 확인" is a promise the product then refuses
 * to keep, which is the same dead end this feature removes, one screen later.
 */

export type WebSearchSuggestionCardProps = {
  copy: WebSearchSuggestionCopy;
  /** Which of the four states this is, mirrored onto the DOM for tests. */
  state: WebSearchSuggestionState;
  /** True from the press until the request has been accepted or refused. */
  isStarting: boolean;
  /** Absent when `copy.primary` is null; never called in that case. */
  onConfirm: () => void;
  onDismiss: () => void;
};

/*
  Fixed ids rather than `useId`, for the same reason the Deep Research card
  uses them: exactly one shell is mounted at a time and each renders at most
  one card, so nothing else ever carries these -- and being hook-free is what
  lets the unit runner call this component directly.
*/
const TITLE_ID = "web-search-suggestion-title";
const DESCRIPTION_ID = "web-search-suggestion-description";

export function WebSearchSuggestionCard({
  copy,
  state,
  isStarting,
  onConfirm,
  onDismiss,
}: WebSearchSuggestionCardProps) {
  const titleId = TITLE_ID;
  const descriptionId = DESCRIPTION_ID;

  return (
    <div className="w-full shrink-0 px-4 md:px-6">
      <section
        data-testid="web-search-suggestion"
        data-state={state}
        data-starting={isStarting ? "true" : "false"}
        role="region"
        aria-labelledby={titleId}
        aria-busy={isStarting}
        className="mx-auto mb-2 w-full max-w-4xl rounded-2xl border border-accent-web-search-200 bg-accent-web-search-50 px-3 py-3 dark:border-accent-web-search-800 dark:bg-accent-web-search-950/30"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-accent-web-search-600 dark:text-accent-web-search-300"
              aria-hidden="true"
            >
              <Globe className="h-4 w-4" />
            </span>
            {/*
              `min-w-0` on the text column and wrapping everywhere: the
              description is a full sentence in seven languages and the card
              has to survive it at 320px without pushing the dock sideways.
            */}
            <div className="min-w-0">
              <p
                id={titleId}
                className="text-xs font-bold text-zinc-900 dark:text-white"
              >
                {copy.title}
              </p>
              <p
                id={descriptionId}
                className="mt-0.5 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300"
              >
                {copy.description}
              </p>
              {copy.estimate && (
                <p
                  data-testid="web-search-suggestion-estimate"
                  className="mt-1 text-[11px] font-semibold text-accent-web-search-600 dark:text-accent-web-search-300"
                >
                  {copy.estimate}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {copy.primary && (
              <button
                type="button"
                data-testid="web-search-suggestion-confirm"
                onClick={onConfirm}
                disabled={isStarting}
                aria-disabled={isStarting}
                /*
                  Both actions name the offer they belong to, so a screen
                  reader user who lands on the button alone still hears what is
                  being searched for and what it may cost -- the estimate is
                  part of the description this points at.
                */
                aria-describedby={descriptionId}
                className="rounded-xl bg-accent-web-search-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-accent-web-search-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copy.primary}
              </button>
            )}
            <button
              type="button"
              data-testid="web-search-suggestion-dismiss"
              onClick={onDismiss}
              disabled={isStarting}
              aria-disabled={isStarting}
              aria-describedby={descriptionId}
              className="rounded-xl border border-accent-web-search-200 bg-white px-3 py-2 text-[11px] font-bold text-accent-web-search-800 transition hover:bg-accent-web-search-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-accent-web-search-800 dark:bg-zinc-950 dark:text-accent-web-search-300 dark:hover:bg-accent-web-search-950"
            >
              {copy.dismiss}
            </button>
          </div>
        </div>
        {/*
          Polite, and empty until there is something to say: the re-run's real
          progress is the panels' own streaming state, which this does not
          duplicate. It exists so the disabled buttons are not the only
          evidence that the press was received.
        */}
        <p
          data-testid="web-search-suggestion-status"
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {isStarting ? copy.starting : ""}
        </p>
      </section>
    </div>
  );
}
