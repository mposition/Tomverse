/**
 * The expansion offer's strings, resolved from `locales/*.ts`.
 *
 * Separate from the card for two reasons. It is the half that can be executed
 * in the ordinary unit lane -- the card pulls in `lucide-react`, which does
 * not load under `--conditions=react-server` -- and keeping the interpolation
 * here means the component holds no template, no placeholder and no number of
 * its own.
 *
 * Nothing in this file is a literal a user reads. `{duration}` is filled with
 * the same approved `chat.deepResearchEstimatedTimeValue` phrase the Deep
 * Research setup sheet shows, and `{credits}` with a figure the caller got
 * from `getWeightedUsageCredits` -- the catalogue's own arithmetic, not a
 * second one. When there is no credit figure to be had, the caller passes
 * null and the shorter line is used; there is no fallback number anywhere
 * here.
 */

export type DeepResearchSuggestionCopy = {
  title: string;
  description: string;
  /** Already interpolated; null when no estimate can be trusted. */
  estimate: string | null;
  expand: string;
  dismiss: string;
  /** Announced politely while the run is being started. */
  starting: string;
};

const interpolate = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

/**
 * Turns the dictionary into this card's strings.
 *
 * `estimatedCredits` is null whenever the credit value could not be resolved
 * from the catalogue -- an unknown model, a catalogue that has not loaded --
 * and the estimate line then names only the duration, which is a fixed
 * approved phrase rather than a computed one. Neither number is ever invented
 * here: there is no fallback literal in this file.
 */
export const resolveDeepResearchSuggestionCopy = ({
  t,
  estimatedCredits,
}: {
  t: (key: string) => string;
  estimatedCredits: number | null;
}): DeepResearchSuggestionCopy => {
  const duration = t("chat.deepResearchEstimatedTimeValue");
  const estimate =
    estimatedCredits === null
      ? interpolate(t("chat.deepResearchSuggestionEstimateTimeOnly"), {
          duration,
        })
      : interpolate(t("chat.deepResearchSuggestionEstimate"), {
          duration,
          credits: estimatedCredits,
        });

  return {
    title: t("chat.deepResearchSuggestionTitle"),
    description: t("chat.deepResearchSuggestionDescription"),
    estimate,
    expand: t("chat.deepResearchSuggestionExpand"),
    dismiss: t("chat.deepResearchSuggestionDismiss"),
    starting: t("chat.deepResearchSuggestionStarting"),
  };
};
