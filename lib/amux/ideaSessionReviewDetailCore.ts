import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION } from "./ideaAnalysisPromptCore.ts";
import type { AmuxSessionReviewDetail } from "./ideaSessionReviewCore.ts";

/**
 * Re-runs the plan writer's inspection of a first session page on the kept
 * answer, so the owner sees which check refused it. The first page's context
 * is fixed (one operator idea, no history, no inherited target references, the
 * claim as preview id), so this reaches the same verdict the writer reached.
 * Only the closed code leaves; nothing of the answer does.
 */
export function amuxSessionReviewFirstPageDetail(raw: string,
  claimId: string): AmuxSessionReviewDetail {
  const inspected = inspectAmuxAnalysisContinuation({
    raw, expectedPreviewId: claimId, expectedChunkIndex: 0,
    expectedRevisionChunkIndex: 0, permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: [], sourceUnitCount: 1, coveredStartOrdinal: 0,
    coveredEndOrdinal: 0, history: [],
    templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
  });
  if (inspected.ok) return "draft_refused";
  switch (inspected.stage) {
    case "chunk": return `chunk_${inspected.code}`;
    case "history": return inspected.reason;
    case "cursor": return `cursor_${inspected.reason}`;
    case "owner_input": return "owner_question_unreadable";
  }
}
