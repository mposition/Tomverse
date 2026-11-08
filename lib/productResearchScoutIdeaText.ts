/**
 * The text of a Scout suggestion, shared by the AMUX send
 * (app/api/admin/product-research/suggestions/[suggestionId]/route.ts) and the
 * console's copy button. It imports nothing, so the browser and the Scout's
 * own node script (through lib/productResearchScoutCore.ts) can both load it.
 */

export type ScoutSuggestionText = {
  readonly subject: string;
  readonly title: string;
  readonly area: string;
  readonly severity: string;
  readonly evidence: string;
  readonly suggestion: string;
};

/** The AMUX idea text an operator sends from a suggestion: what, where, why, what to change. */
export function suggestionIdeaText(input: ScoutSuggestionText): string {
  return [
    `[Scout 제안] ${input.title}`,
    `대상: ${input.subject} · 영역: ${input.area} · 심각도: ${input.severity}`,
    `근거: ${input.evidence}`,
    `제안: ${input.suggestion}`,
  ].join("\n");
}

/**
 * The same idea as a brief to paste into a local coding CLI: the idea text,
 * the page it is about when there is one, and when the work is done.
 */
export function suggestionWorkBrief(
  input: ScoutSuggestionText & { readonly url: string | null },
  labels: { readonly url: string; readonly done: string },
): string {
  return [suggestionIdeaText(input), ...(input.url ? [`${labels.url}: ${input.url}`] : []), labels.done].join("\n");
}
