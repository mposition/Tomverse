import type {
  Citation,
  SingleReviewResult,
} from "../packages/chat-core/src/review";

export type ReviewEvidenceItem = {
  id: string;
  section:
    | "consensus"
    | "contradictions"
    | "differences"
    | "missingPoints"
    | "verificationNeeded";
  ordinal: number;
  text: string;
  citations: Citation[];
};

/** Display projection only: no claim, judgement or source label is inferred. */
export function reviewEvidenceItems(
  result: SingleReviewResult,
): ReviewEvidenceItem[] {
  return [
    ...result.contradictions.map((item, ordinal) => ({
      ...item,
      ordinal,
      section: "contradictions" as const,
    })),
    ...result.differences.map((item, ordinal) => ({
      text: item.issue,
      citations: item.positions,
      ordinal,
      section: "differences" as const,
    })),
    ...result.missingPoints.map((text, ordinal) => ({
      text,
      citations: [],
      ordinal,
      section: "missingPoints" as const,
    })),
    ...result.verificationNeeded.map((text, ordinal) => ({
      text,
      citations: [],
      ordinal,
      section: "verificationNeeded" as const,
    })),
    ...result.consensus.map((item, ordinal) => ({
      ...item,
      ordinal,
      section: "consensus" as const,
    })),
  ].map((item) => ({ ...item, id: `${item.section}:${item.ordinal}` }));
}

/** Exact display highlight. A missing quote is never approximated or replaced. */
export function reviewQuoteRange(content: string, quote: string) {
  if (!quote.trim()) return null;
  const start = content.indexOf(quote);
  return start < 0 ? null : { start, end: start + quote.length };
}
