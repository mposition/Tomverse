import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import type { AmuxPermittedTargetRef } from "./ideaAnalysisChunkCore.ts";
import { sealAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from
  "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** Pure, bounded continuation after one verified first output page. The caller
 * must authenticate the stored cursor and target refs before using this result;
 * it cannot grant a model call, DB write or card registration. */
export function prepareSecondIdeaOnlyAnalysisDraft(input: {
  ideaId: string; previewId: string; raw: string; keys: AmuxContentKeys;
  priorPage: AmuxAnalysisOutputPage;
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
}):
  | { decision: "ready" | "partial"; draft: SealedAmuxAnalysisDraft;
      coveredStartOrdinal: 0; coveredEndOrdinal: 0; outputPartIndex: 1;
      remainingStartOrdinal: 0 | null; remainingEndOrdinal: 0 | null }
  | { decision: "hold"; reason: "invalid_result" | "owner_input" |
      "continuation_required" } {
  const inspected = inspectAmuxAnalysisContinuation({
    raw: input.raw, expectedPreviewId: input.previewId,
    expectedChunkIndex: 1, expectedRevisionChunkIndex: 1,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: input.permittedTargetRefs,
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history: [input.priorPage],
  });
  if (!inspected.ok) return { decision: "hold",
    reason: inspected.stage === "owner_input" ? "owner_input" : "invalid_result" };
  const complete = inspected.cursor.nextCursor === null &&
    inspected.parsed.chunk.coverageStatus === "complete" &&
    inspected.parsed.chunk.continuationKind === null;
  const partial = inspected.cursor.nextCursor?.sourceOrdinal === 0 &&
    inspected.cursor.nextCursor.outputPartIndex === 2 &&
    inspected.parsed.chunk.coverageStatus === "more" &&
    inspected.parsed.chunk.continuationKind === "output";
  if (!complete && !partial) {
    return { decision: "hold", reason: "continuation_required" };
  }
  const sealed = sealAmuxAnalysisDraft({ ...input,
    expectedPreviewId: input.previewId,
    expectedChunkIndex: 1, expectedRevisionChunkIndex: 1,
    previousContinuationKind: "output",
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: input.permittedTargetRefs,
  });
  if (!sealed.ok) return { decision: "hold", reason: "invalid_result" };
  return { decision: complete ? "ready" : "partial", draft: sealed.draft,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: 1,
    remainingStartOrdinal: partial ? 0 : null,
    remainingEndOrdinal: partial ? 0 : null };
}
