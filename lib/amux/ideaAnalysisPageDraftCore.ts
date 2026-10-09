import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import type { AmuxPermittedTargetRef } from "./ideaAnalysisChunkCore.ts";
import { sealInspectedAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from
  "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** One response page, not one whole idea. This pure boundary does not prove
 * owner confirmation, source-plan identity, DB history or a fenced invocation.
 * The app writer must bind those before persisting a page or opening a next
 * preview. A remainder is never silently converted into completion. */
export function prepareAmuxAnalysisPageDraft(input: {
  ideaId: string;
  previewId: string;
  raw: string;
  keys: AmuxContentKeys;
  unitIds?: readonly string[];
  chunkIndex: number;
  revisionChunkIndex: number;
  permittedSourceRefIds: readonly string[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
  sourceUnitCount: number;
  coveredStartOrdinal: number;
  coveredEndOrdinal: number;
  history: readonly AmuxAnalysisOutputPage[];
}):
  | { decision: "ready"; draft: SealedAmuxAnalysisDraft;
      page: AmuxAnalysisOutputPage;
      nextCursor: { sourceOrdinal: number; outputPartIndex: number } | null }
  | { decision: "needs_owner_input"; draft: SealedAmuxAnalysisDraft;
      coveredStartOrdinal: number; coveredEndOrdinal: number }
  | { decision: "hold"; reason: "invalid_result" } {
  const inspected = inspectAmuxAnalysisContinuation({
    raw: input.raw,
    expectedPreviewId: input.previewId,
    expectedChunkIndex: input.chunkIndex,
    expectedRevisionChunkIndex: input.revisionChunkIndex,
    permittedSourceRefIds: input.permittedSourceRefIds,
    permittedTargetRefs: input.permittedTargetRefs,
    sourceUnitCount: input.sourceUnitCount,
    coveredStartOrdinal: input.coveredStartOrdinal,
    coveredEndOrdinal: input.coveredEndOrdinal,
    history: input.history,
  });
  if (!inspected.ok && inspected.stage !== "owner_input") {
    return { decision: "hold", reason: "invalid_result" };
  }
  const sealed = sealInspectedAmuxAnalysisDraft({
    ideaId: input.ideaId,
    keys: input.keys,
    unitIds: input.unitIds,
    inspected: inspected.parsed,
  });
  if (!sealed.ok) return { decision: "hold", reason: "invalid_result" };
  if (!inspected.ok) {
    return { decision: "needs_owner_input", draft: sealed.draft,
      coveredStartOrdinal: input.coveredStartOrdinal,
      coveredEndOrdinal: input.coveredEndOrdinal };
  }
  return { decision: "ready", draft: sealed.draft,
    page: inspected.cursor.candidate,
    nextCursor: inspected.cursor.nextCursor };
}
