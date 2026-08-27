/**
 * The web-search offer's strings, resolved from `locales/*.ts`.
 *
 * Separate from the card for the two reasons `deepResearchSuggestionCopy.ts`
 * is: this half runs in the ordinary unit lane (the card pulls in
 * `lucide-react`, which does not load under `--conditions=react-server`), and
 * keeping the interpolation here means the component holds no template, no
 * placeholder and no number of its own.
 *
 * ## Nothing from the user's question reaches these strings
 *
 * The card could say "서울의 현재 날씨를 웹에서 확인해 드릴까요?" if the place
 * and the subject could be pulled out of the question reliably. They cannot,
 * not without a model call this module has already ruled out for cost and
 * latency -- and the failure mode is loud: a wrong noun makes the product look
 * like it misread the question, and the raw text carries the user's own
 * markdown, so `**서울** 날씨` would surface its asterisks in a plain-text
 * card. So every string here is fixed copy from the dictionary, and
 * `tests/webSearchSuggestionCopy.test.mjs` holds that there is no
 * question-shaped placeholder to fill.
 *
 * ## The four states are four different sentences
 *
 * They are not one sentence with a disabled button. A card that says "웹에서
 * 확인" over a control that cannot search is the dead end this feature exists
 * to remove, moved one screen later -- so `unsupported` and `blocked` have no
 * primary action at all, and their `primary` is null rather than a disabled
 * label.
 */

import type { WebSearchSuggestionState } from "@/lib/webSearchRetrySuggestion";

export type WebSearchSuggestionCopy = {
  title: string;
  description: string;
  /** Already interpolated; null when there is no trustworthy figure. */
  estimate: string | null;
  /** Null in the states with nothing to press. */
  primary: string | null;
  /** Always present: every state can be put away. */
  dismiss: string;
  /** Announced politely while a re-run is being started. */
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
 * Turns the dictionary into this card's strings for one state.
 *
 * `surchargeCredits` is the upper bound of the extra credits a searching
 * re-run may reserve, from `deriveWebSearchComposerState` -- the composer's
 * own arithmetic, not a second one. Null (or zero, which means no selected
 * model charges for search) drops the line rather than printing a zero, and
 * there is no fallback number anywhere in this file.
 *
 * The estimate is only shown on `enable`: it describes what pressing the
 * button would cost, and the other three states have no button to cost
 * anything.
 */
export const resolveWebSearchSuggestionCopy = ({
  t,
  state,
  surchargeCredits,
}: {
  t: (key: string) => string;
  state: WebSearchSuggestionState;
  surchargeCredits: number | null;
}): WebSearchSuggestionCopy => {
  const dismiss = t("chat.webSearchSuggestionDismiss");
  const starting = t("chat.webSearchSuggestionStarting");

  if (state === "unsupported") {
    return {
      title: t("chat.webSearchSuggestionUnsupportedTitle"),
      description: t("chat.webSearchSuggestionUnsupportedDescription"),
      estimate: null,
      primary: null,
      dismiss,
      starting,
    };
  }

  if (state === "blocked") {
    return {
      title: t("chat.webSearchSuggestionBlockedTitle"),
      description: t("chat.webSearchSuggestionBlockedDescription"),
      estimate: null,
      primary: null,
      dismiss,
      starting,
    };
  }

  if (state === "error") {
    return {
      title: t("chat.webSearchSuggestionErrorTitle"),
      description: t("chat.webSearchSuggestionErrorDescription"),
      estimate: null,
      primary: t("chat.webSearchSuggestionRetry"),
      dismiss,
      starting,
    };
  }

  return {
    title: t("chat.webSearchSuggestionTitle"),
    description: t("chat.webSearchSuggestionDescription"),
    estimate:
      surchargeCredits && surchargeCredits > 0
        ? interpolate(t("chat.webSearchSuggestionEstimate"), {
            credits: surchargeCredits,
          })
        : null,
    primary: t("chat.webSearchSuggestionConfirm"),
    dismiss,
    starting,
  };
};
