import type { DocumentSpec } from "./generatedArtifactCore";
import { reviewInputKey, type ReviewChatSource } from "./reviewToChat";
import type { Language } from "./language";
import type { Citation } from "../packages/chat-core/src/review";
import { toSourceGrounding } from "./sourceGrounding";

export const reviewReportLabelKeys = {
  title: "chat.aiReviewTitle", quickTitle: "chat.quickDifferenceSummary", question: "reviewHandoff.question", sources: "reviewHandoff.sources",
  reviewer: "reviewHandoff.reviewer", quoteNote: "reviewHandoff.quoteNote", external: "reviewHandoff.external",
  limitations: "reviewHandoff.limitations", matched: "reviewHandoff.matched", unmatched: "reviewHandoff.unmatched",
  consensus: "chat.aiReviewConsensus", differences: "chat.aiReviewDifferences", contradictions: "chat.aiReviewContradictions",
  missingPoints: "chat.aiReviewMissingPoints", verificationNeeded: "chat.aiReviewVerificationNeeded",
  models: "chat.quickSummaryModelClaims", synthesis: "chat.aiReviewSynthesis", strengths: "chat.aiReviewStrengths",
  cautions: "chat.aiReviewCautions", commonConclusions: "chat.quickSummaryCommonConclusions",
  importantDifferences: "chat.quickSummaryImportantDifferences",
  grounding: "chat.aiReviewSourceGroundingOverall", quotesMatched: "chat.aiReviewSourceGroundingQuotesMatched",
  groundingUnavailable: "chat.aiReviewSourceGroundingUnavailable",
} as const;
export type ReviewReportLabels = Record<keyof typeof reviewReportLabelKeys, string>;
export const reviewReportLabels = (t: (key: string) => string) => Object.fromEntries(
  Object.entries(reviewReportLabelKeys).map(([name, key]) => [name, t(key)]),
) as ReviewReportLabels;

export type ReviewReportSelection = {
  kind: "review" | "quick"; reviewId: string; reviewMode: "balanced" | "evidence" | "action";
  includeSynthesis: boolean; reviewer: "primary" | "secondary"; fingerprint: string; language: Language;
};

/** Content digest only; possession never grants read, download or publication. */
export function reviewReportFingerprintInput(source: ReviewChatSource) {
  return JSON.stringify([source.kind, source.conversationId,
    source.kind === "review" ? [source.mode, source.includeSynthesis, source.reviewer] : null,
    JSON.parse(reviewInputKey(source.setup)), source.review.id, source.review.reviewerModelId, source.review.result, source.review.responseMap],
  (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export async function reviewReportSelection(source: ReviewChatSource, language: Language): Promise<ReviewReportSelection> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reviewReportFingerprintInput(source)));
  return { kind: source.kind, reviewId: source.review.id,
    reviewMode: source.kind === "review" ? source.mode : "balanced",
    includeSynthesis: source.kind === "review" && source.includeSynthesis,
    reviewer: source.kind === "review" ? source.reviewer : "primary", language,
    fingerprint: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("") };
}

/** Full saved report, without a model call, source transcript or web-check state. */
export function buildReviewAnalysisReport(source: ReviewChatSource, labels: ReviewReportLabels) {
  const question = source.setup.source?.question;
  if (!question || !source.review.id || source.review.responseMap.length < 2 ||
    (source.kind === "review" && (source.review.guest || source.review.persisted === false))) throw new Error("REVIEW_REPORT_UNAVAILABLE");
  const selected = source.kind === "review" ? source.review.result[source.reviewer] : null;
  if (source.kind === "review" && !selected) throw new Error("REVIEW_REPORT_UNAVAILABLE");
  const sections: Array<{ heading: string; text: string }> = [];
  const add = (key: keyof ReviewReportLabels, text: string) => { if (text) sections.push({ heading: labels[key], text }); };
  const citations = (items: Citation[]) => items.map(item => `${item.responseId} (${source.review.responseMap.find(row => row.responseId === item.responseId)?.modelName ?? item.responseId}): “${item.quote}” [${item.verified ? labels.matched : labels.unmatched}]`).join("\n");
  add("question", question);
  add("sources", source.review.responseMap.map(row => `${row.responseId}: ${row.modelName}`).join("\n"));
  add("reviewer", selected?.reviewerModelId ?? source.review.reviewerModelId);
  const grounding = toSourceGrounding(selected?.result ?? (source.kind === "quick" ? source.review.result : {}));
  add("grounding", grounding.available
    ? `${grounding.percent}% — ${labels.quotesMatched.replace("{matched}", String(grounding.matchedQuotes)).replace("{total}", String(grounding.totalQuotes))}`
    : labels.groundingUnavailable);
  if (source.kind === "review" && selected) {
    const result = selected.result;
    for (const key of ["consensus", "contradictions"] as const) result[key].forEach(item => add(key, `${item.text}\n${citations(item.citations)}`));
    result.differences.forEach(item => add("differences", `${item.issue}\n${item.positions.map(p => `${p.responseId}: ${p.position}\n${citations([p])}`).join("\n\n")}`));
    result.missingPoints.forEach(item => add("missingPoints", item));
    result.verificationNeeded.forEach(item => add("verificationNeeded", item));
    result.modelAssessments.forEach(item => add("models", `${item.responseId}\n${labels.strengths}:\n${item.strengths.join("\n")}\n${labels.cautions}:\n${item.cautions.join("\n")}`));
    add("synthesis", result.synthesis);
    result.limitations.forEach(item => add("limitations", item));
  } else if (source.kind === "quick") {
    for (const key of ["commonConclusions", "importantDifferences"] as const) source.review.result[key].forEach(item => add(key, `${item.text}\n${citations(item.citations)}`));
    source.review.result.modelKeyClaims.forEach(item => add("models", item.claims.map(c => `${c.claim}\n${citations([{ ...c, responseId: item.responseId }])}`).join("\n\n")));
    source.review.result.verificationNeeded.forEach(item => add("verificationNeeded", item));
  }
  const title = source.kind === "quick" ? labels.quickTitle : labels.title;
  const preamble = `${labels.quoteNote}\n${labels.external}`;
  const text = [title, preamble, ...sections.map(section => `${section.heading}\n${section.text}`)].join("\n\n");
  const spec: DocumentSpec = {
    filename: "answer-analysis.txt", format: "txt", title,
    // Source text is already bounded by the saved Review schema and turn limits.
    // It is trusted server projection, not a new model-authored document spec.
    blocks: [{ type: "paragraph", text: preamble }, ...sections.flatMap(section => [
      { type: "heading" as const, level: 2, text: section.heading }, { type: "paragraph" as const, text: section.text },
    ])],
  };
  return { title, question, sections, preamble, text, spec };
}
