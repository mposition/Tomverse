import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import { AMUX_V4_ANALYSIS_PROMPT_VERSION } from "./ideaAnalysisPromptCore.ts";
import type { AmuxAnalysisSchemaRejectAt, AmuxPermittedTargetRef } from
  "./ideaAnalysisChunkCore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import type { AmuxSessionReviewDetail } from "./ideaSessionReviewCore.ts";

/**
 * Re-runs the plan writer's inspection of a session page on the answer, so the
 * operator sees which check refused it. Only the closed code, and for a schema
 * refusal the schema's own rule, field name and unit position, leave; nothing
 * of the answer does.
 */
export function amuxSessionPageRefusalDetail(raw: string, page: {
  previewId: string; chunkIndex: number;
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
  history: readonly AmuxAnalysisOutputPage[];
}): { detail: AmuxSessionReviewDetail; at?: AmuxAnalysisSchemaRejectAt } {
  const inspected = inspectAmuxAnalysisContinuation({
    raw, expectedPreviewId: page.previewId, expectedChunkIndex: page.chunkIndex,
    expectedRevisionChunkIndex: page.chunkIndex, permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: page.permittedTargetRefs, sourceUnitCount: 1,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, history: page.history,
    templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
  });
  if (inspected.ok) return { detail: "draft_refused" };
  switch (inspected.stage) {
    case "chunk":
      return inspected.code === "schema_rejected" && inspected.at ?
        { detail: "chunk_schema_rejected", at: inspected.at } : { detail: `chunk_${inspected.code}` };
    case "history": return { detail: inspected.reason };
    case "cursor": return { detail: `cursor_${inspected.reason}` };
    case "owner_input": return { detail: "owner_question_unreadable" };
  }
}

/** The kept answer of a first page: its context is fixed (one operator idea, no
 * history, no inherited target references, the claim as preview id), so this
 * reaches the same verdict the writer reached. */
export const amuxSessionReviewFirstPageDetail = (raw: string, claimId: string) =>
  amuxSessionPageRefusalDetail(raw, { previewId: claimId, chunkIndex: 0,
    permittedTargetRefs: [], history: [] });
