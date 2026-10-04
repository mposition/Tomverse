import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import { sealAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** A first, idea-only analysis can finish without a continuation worker.
 * This prepares encrypted DB values but never writes or authorizes a call.
 * Its caller must still prove that the confirmed preview belongs to ideaId,
 * that this exact response came from its fenced invocation, and that the
 * source-plan/lease/budget/audit guards all hold under the app DB writer. */
export function prepareFirstIdeaOnlyAnalysisDraft(input: {
  ideaId: string;
  previewId: string;
  raw: string;
  keys: AmuxContentKeys;
  unitIds?: readonly string[];
}):
  | { decision: "ready"; draft: SealedAmuxAnalysisDraft;
      coveredStartOrdinal: 0; coveredEndOrdinal: 0; outputPartIndex: 0 }
  | { decision: "hold"; reason: "invalid_result" | "owner_input" | "continuation_required" } {
  const inspected = inspectAmuxAnalysisContinuation({
    raw: input.raw,
    expectedPreviewId: input.previewId,
    expectedChunkIndex: 0,
    expectedRevisionChunkIndex: 0,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: [],
    sourceUnitCount: 1,
    coveredStartOrdinal: 0,
    coveredEndOrdinal: 0,
    history: [],
  });
  if (!inspected.ok) return { decision: "hold",
    reason: inspected.stage === "owner_input" ? "owner_input" : "invalid_result" };
  if (inspected.cursor.nextCursor !== null ||
      inspected.parsed.chunk.coverageStatus !== "complete" ||
      inspected.parsed.chunk.continuationKind !== null) {
    return { decision: "hold", reason: "continuation_required" };
  }
  const sealed = sealAmuxAnalysisDraft({ ...input,
    expectedPreviewId: input.previewId,
    expectedChunkIndex: 0,
    expectedRevisionChunkIndex: 0,
    previousContinuationKind: null,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: [],
  });
  if (!sealed.ok) return { decision: "hold", reason: "invalid_result" };
  return { decision: "ready", draft: sealed.draft,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: 0 };
}
