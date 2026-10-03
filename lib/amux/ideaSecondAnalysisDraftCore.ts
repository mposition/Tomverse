import { amuxCanonicalJson } from "./boardImportCore.ts";
import { inspectAmuxAnalysisContinuation } from "./ideaAnalysisContinuationCore.ts";
import type { AmuxAnalysisOutputPage } from "./ideaOutputCursorCore.ts";
import { snapshotAmuxPermittedTarget, type AmuxPermittedTargetRef } from
  "./ideaAnalysisChunkCore.ts";
import { sealAmuxAnalysisDraft, type SealedAmuxAnalysisDraft } from
  "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";

type SecondDraftInput = {
  ideaId: string; previewId: string; raw: string; keys: AmuxContentKeys;
  priorPage: AmuxAnalysisOutputPage;
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
};
type SecondDraftResult =
  | { decision: "ready" | "partial"; draft: SealedAmuxAnalysisDraft;
      coveredStartOrdinal: 0; coveredEndOrdinal: 0; outputPartIndex: number;
      remainingStartOrdinal: 0 | null; remainingEndOrdinal: 0 | null }
  | { decision: "hold"; reason: "invalid_result" | "owner_input" |
      "continuation_required" };

/** Pure, bounded continuation after one verified first output page. The caller
 * must prove the confirmed preview belongs to ideaId, the response came from
 * its fenced invocation, and source-plan/lease/budget/audit guards all hold.
 * This result cannot grant a model call, DB write or card registration. */
export function prepareSecondIdeaOnlyAnalysisDraft(
  input: SecondDraftInput,
): SecondDraftResult {
  try {
    const { ideaId, previewId, raw, keys, priorPage, permittedTargetRefs } = input;
    return prepareIdeaOnlyOutputAnalysisDraft({ ideaId, previewId, raw, keys,
      permittedTargetRefs, chunkIndex: 1, history: [priorPage] });
  } catch { return { decision: "hold", reason: "invalid_result" }; }
}

/** Validate and seal any later output page of the same idea-only source.
 * The caller supplies every prior page from the verified DB chain and must
 * bind all target refs to those pages before using this pure result. */
export function prepareIdeaOnlyOutputAnalysisDraft(input: {
  ideaId: string; previewId: string; raw: string; keys: AmuxContentKeys;
  chunkIndex: number; history: readonly AmuxAnalysisOutputPage[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
}): SecondDraftResult {
  try { return prepareCheckedDraft(input); }
  catch { return { decision: "hold", reason: "invalid_result" }; }
}

function prepareCheckedDraft(input: Parameters<typeof prepareIdeaOnlyOutputAnalysisDraft>[0]): SecondDraftResult {
  const { ideaId, previewId, raw, keys, chunkIndex, history, permittedTargetRefs } = input;
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 1 ||
      !Array.isArray(history) ||
      Object.getOwnPropertyDescriptor(history, "length")?.value !== chunkIndex) {
    return { decision: "hold", reason: "invalid_result" };
  }
  if (!Array.isArray(permittedTargetRefs)) {
    return { decision: "hold", reason: "invalid_result" };
  }
  const length = Object.getOwnPropertyDescriptor(permittedTargetRefs, "length")?.value;
  if (!Number.isSafeInteger(length) || length > 512) {
    return { decision: "hold", reason: "invalid_result" };
  }
  const targetSnapshots: (AmuxPermittedTargetRef | null)[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(permittedTargetRefs, index);
    if (!descriptor || !("value" in descriptor)) {
      return { decision: "hold", reason: "invalid_result" };
    }
    targetSnapshots.push(snapshotAmuxPermittedTarget(descriptor.value));
  }
  if (targetSnapshots.some((target) => target === null)) {
    return { decision: "hold", reason: "invalid_result" };
  }
  const targets = targetSnapshots as AmuxPermittedTargetRef[];
  const inspected = inspectAmuxAnalysisContinuation({
    raw, expectedPreviewId: previewId,
    expectedChunkIndex: chunkIndex, expectedRevisionChunkIndex: chunkIndex,
    permittedSourceRefIds: ["operator_idea"],
    permittedTargetRefs: targets,
    sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    history,
  });
  if (!inspected.ok) return { decision: "hold",
    reason: inspected.stage === "owner_input" ? "owner_input" : "invalid_result" };
  const complete = inspected.cursor.nextCursor === null &&
    inspected.parsed.chunk.coverageStatus === "complete" &&
    inspected.parsed.chunk.continuationKind === null;
  const partial = inspected.cursor.nextCursor?.sourceOrdinal === 0 &&
    inspected.cursor.nextCursor.outputPartIndex === chunkIndex + 1 &&
    inspected.parsed.chunk.coverageStatus === "more" &&
    inspected.parsed.chunk.continuationKind === "output";
  if (!complete && !partial) {
    return { decision: "hold", reason: "continuation_required" };
  }
  const sealed = sealAmuxAnalysisDraft({ ideaId, keys,
    raw: amuxCanonicalJson(inspected.parsed.chunk),
    expectedPreviewId: previewId,
    expectedChunkIndex: chunkIndex, expectedRevisionChunkIndex: chunkIndex,
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
    coveredStartOrdinal: 0, coveredEndOrdinal: 0, outputPartIndex: chunkIndex,
    remainingStartOrdinal: partial ? 0 : null,
    remainingEndOrdinal: partial ? 0 : null };
}
