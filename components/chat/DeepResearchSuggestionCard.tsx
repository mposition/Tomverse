"use client";

import { Microscope } from "lucide-react";

import type { DeepResearchSuggestionCopy } from "@/components/chat/deepResearchSuggestionCopy";

/**
 * The offer to take a finished answer further with Deep Research.
 *
 * Decision: `lib/deepResearchSuggestion.ts`. This component renders what that
 * module decided and nothing else -- it has no rule of its own about when an
 * offer is appropriate, so desktop and mobile cannot drift.
 *
 * ## What it must not look like
 *
 * The answer above it is finished and correct. So this card says what a second
 * pass would *add*, never that what is on screen is missing something: no
 * warning colour, no alert role, no "the answer may be incomplete". It is the
 * quietest thing in the bottom dock.
 *
 * It also never moves focus. A card that stole the caret after every answer
 * would interrupt someone already typing their next question, and a screen
 * reader user is met by it in reading order like any other region rather than
 * by an interruption. `role="region"` with a name, not `role="alert"`.
 *
 * ## Why the copy arrives as a prop
 *
 * The strings live in `locales/*.ts` like every other user-facing phrase in
 * this app, and `resolveDeepResearchSuggestionCopy` below is what turns `t`
 * into them -- including the interpolation, so the card holds no template and
 * no number of its own. Taking the result as a prop is also what makes this
 * component callable in `tests/client/`, where there is no LanguageProvider to
 * hang a hook on.
 *
 * ## Estimates
 *
 * `copy.estimate` is null when there is no trustworthy number to show, and the
 * line is then absent rather than filled with a guess. The values themselves
 * come from the same places the setup sheet reads: `getWeightedUsageCredits`
 * for the credits, the approved `chat.deepResearchEstimatedTimeValue` phrase
 * for the duration. Nothing here is a literal.
 */

export type DeepResearchSuggestionCardProps = {
  copy: DeepResearchSuggestionCopy;
  /** True from the press until the request has been accepted or refused. */
  isStarting: boolean;
  onExpand: () => void;
  onDismiss: () => void;
};

/*
  Fixed ids rather than `useId`.

  Exactly one of the two shells is mounted at a time (`ChatPageClient` chooses
  by viewport, not by CSS) and each renders at most one card, so there is never
  a second element carrying these. Being hook-free is also what lets the
  contract above be executed: the unit runner can call this component directly,
  where a hook would have no dispatcher to run against.
*/
const TITLE_ID = "deep-research-suggestion-title";
const DESCRIPTION_ID = "deep-research-suggestion-description";

export function DeepResearchSuggestionCard({
  copy,
  isStarting,
  onExpand,
  onDismiss,
}: DeepResearchSuggestionCardProps) {
  const titleId = TITLE_ID;
  const descriptionId = DESCRIPTION_ID;

  return (
    <div className="w-full shrink-0 px-4 md:px-6">
      <section
        data-testid="deep-research-suggestion"
        data-starting={isStarting ? "true" : "false"}
        role="region"
        aria-labelledby={titleId}
        aria-busy={isStarting}
        className="mx-auto mb-2 w-full max-w-4xl rounded-2xl border border-accent-deep-research-200 bg-accent-deep-research-50 px-3 py-3 dark:border-accent-deep-research-800 dark:bg-accent-deep-research-950/30"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-accent-deep-research-600 dark:text-accent-deep-research-400"
              aria-hidden="true"
            >
              <Microscope className="h-4 w-4" />
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
                  data-testid="deep-research-suggestion-estimate"
                  className="mt-1 text-[11px] font-semibold text-accent-deep-research-700 dark:text-accent-deep-research-400"
                >
                  {copy.estimate}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              data-testid="deep-research-suggestion-expand"
              onClick={onExpand}
              disabled={isStarting}
              aria-disabled={isStarting}
              /*
                Both actions name the offer they belong to, so a screen reader
                user who lands on the button alone still hears which answer is
                being expanded and what it will cost -- the estimate is part of
                the description this points at.
              */
              aria-describedby={descriptionId}
              className="rounded-xl bg-accent-deep-research-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-accent-deep-research-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copy.expand}
            </button>
            <button
              type="button"
              data-testid="deep-research-suggestion-dismiss"
              onClick={onDismiss}
              disabled={isStarting}
              aria-disabled={isStarting}
              aria-describedby={descriptionId}
              className="rounded-xl border border-accent-deep-research-200 bg-white px-3 py-2 text-[11px] font-bold text-accent-deep-research-800 transition hover:bg-accent-deep-research-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-accent-deep-research-800 dark:bg-zinc-950 dark:text-accent-deep-research-400 dark:hover:bg-accent-deep-research-950"
            >
              {copy.dismiss}
            </button>
          </div>
        </div>
        {/*
          Polite, and empty until there is something to say: the run's real
          progress is the deep research chip and the panel's own status, which
          this does not duplicate. It exists so the disabled buttons are not
          the only evidence that the press was received.
        */}
        <p
          data-testid="deep-research-suggestion-status"
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
