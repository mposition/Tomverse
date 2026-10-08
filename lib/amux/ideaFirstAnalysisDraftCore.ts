import { prepareAmuxAnalysisPageDraft } from "./ideaAnalysisPageDraftCore.ts";
import type { SealedAmuxAnalysisDraft } from "./ideaAnalysisDraftSealCore.ts";
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
  const prepared = prepareAmuxAnalysisPageDraft({
    ideaId: input.ideaId,
    previewId: input.previewId,
    raw: input.raw,
    keys: input.keys,
    unitIds: input.unitIds,
    chunkIndex: 0,
    revisionChunkIndex: 0,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: [],
    sourceUnitCount: 1,
    coveredStartOrdinal: 0,
    coveredEndOrdinal: 0,
    history: [],
  });
  if (prepared.decision === "needs_owner_input") {
    return { decision: "hold", reason: "owner_input" };
  }
  if (prepared.decision !== "ready") {
    return { decision: "hold", reason: "invalid_result" };
  }
  if (prepared.nextCursor !== null ||
      prepared.draft.coverageStatus !== "complete" ||
      prepared.draft.continuationKind !== null) {
    return { decision: "hold", reason: "continuation_required" };
  }
  return { decision: "ready", draft: prepared.draft,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: 0 };
}
