import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import { sealAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** A first, idea-only analysis may finish or retain an output continuation.
 * This prepares encrypted DB values but never writes or authorizes a call.
 * "ready" means a complete analysis record, not necessarily proposed cards;
 * "partial" retains proposed units and an explicit remaining-output cursor.
 * Its caller must still prove that the confirmed preview belongs to ideaId,
 * that this exact response came from its fenced invocation, and that the
 * source-plan/lease/budget/audit guards all hold under the app DB writer. */
export function prepareFirstIdeaOnlyAnalysisDraft(input: {
  ideaId: string;
  previewId: string;
  raw: string;
  keys: AmuxContentKeys;
}):
  | { decision: "ready" | "partial"; draft: SealedAmuxAnalysisDraft;
      coveredStartOrdinal: 0; coveredEndOrdinal: 0; outputPartIndex: 0;
      remainingStartOrdinal: 0 | null; remainingEndOrdinal: 0 | null }
  | { decision: "hold"; reason: "invalid_result" | "continuation_required" }
  | { decision: "hold"; reason: "owner_input"; ownerQuestion: string;
      remainingScope: string | null } {
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
  if (!inspected.ok) return inspected.stage === "owner_input" ?
    { decision: "hold", reason: "owner_input",
      ownerQuestion: inspected.parsed.chunk.ownerQuestion!,
      remainingScope: inspected.parsed.chunk.remainingScope } :
    { decision: "hold", reason: "invalid_result" };
  const complete = inspected.cursor.nextCursor === null &&
    inspected.parsed.chunk.coverageStatus === "complete" &&
    inspected.parsed.chunk.continuationKind === null;
  const partial = inspected.cursor.nextCursor?.sourceOrdinal === 0 &&
    inspected.cursor.nextCursor.outputPartIndex === 1 &&
    inspected.parsed.chunk.coverageStatus === "more" &&
    inspected.parsed.chunk.continuationKind === "output";
  if (!complete && !partial) {
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
  return { decision: complete ? "ready" : "partial", draft: sealed.draft,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: 0,
    remainingStartOrdinal: partial ? 0 : null,
    remainingEndOrdinal: partial ? 0 : null };
}
