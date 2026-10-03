import { amuxCanonicalJson } from "./boardImportCore.ts";
import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import { snapshotAmuxPermittedTarget, type AmuxPermittedTargetRef } from
  "./ideaAnalysisChunkCore.ts";
import { sealAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from
  "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

/** Pure, bounded continuation after one verified first output page. The caller
 * must prove the confirmed preview belongs to ideaId, the response came from
 * its fenced invocation, and source-plan/lease/budget/audit guards all hold.
 * This result cannot grant a model call, DB write or card registration. */
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
  const { ideaId, previewId, raw, keys, priorPage, permittedTargetRefs } = input;
  if (!Array.isArray(permittedTargetRefs)) {
    return { decision: "hold", reason: "invalid_result" };
  }
  const targetSnapshots = permittedTargetRefs.map(snapshotAmuxPermittedTarget);
  if (targetSnapshots.some((target) => target === null)) {
    return { decision: "hold", reason: "invalid_result" };
  }
  const targets = targetSnapshots as AmuxPermittedTargetRef[];
  const inspected = inspectAmuxAnalysisContinuation({
    raw, expectedPreviewId: previewId,
    expectedChunkIndex: 1, expectedRevisionChunkIndex: 1,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: targets,
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history: [priorPage],
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
  const sealed = sealAmuxAnalysisDraft({ ideaId, keys,
    raw: amuxCanonicalJson(inspected.parsed.chunk),
    expectedPreviewId: previewId,
    expectedChunkIndex: 1, expectedRevisionChunkIndex: 1,
    previousContinuationKind: "output",
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: targets,
  });
  if (!sealed.ok || sealed.draft.coverageStatus !== inspected.parsed.chunk.coverageStatus ||
      sealed.draft.continuationKind !== inspected.parsed.chunk.continuationKind ||
      sealed.draft.outcome !== inspected.parsed.chunk.outcome) {
    return { decision: "hold", reason: "invalid_result" };
  }
  return { decision: complete ? "ready" : "partial", draft: sealed.draft,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: 1,
    remainingStartOrdinal: partial ? 0 : null,
    remainingEndOrdinal: partial ? 0 : null };
}
