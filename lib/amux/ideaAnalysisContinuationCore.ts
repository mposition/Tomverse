import {
  inspectAmuxAnalysisChunk,
  type AmuxAnalysisChunkInspection,
  type AmuxPermittedTargetRef,
} from "./ideaAnalysisChunkCore.ts";
import {
  assessAmuxOutputCursorHistory,
  type AmuxAnalysisOutputPage,
  type AmuxOutputCursorDecision,
} from "./ideaOutputCursorCore.ts";

/**
 * Dark, pure boundary joining one parsed model response to app-derived source
 * ordinals. The model never supplies ordinals or an output part index. A single
 * checked history snapshot determines the prior continuation kind for the
 * parser and the next output cursor for the range guard.
 *
 * This does not authenticate DB rows, the source plan, preview, owner audit,
 * lease or budget. The future writer must verify those first and persist the
 * parsed response and cursor in one transaction. No caller may treat this
 * result alone as permission to send source text or register a card.
 */
export type AmuxAnalysisContinuationInput = {
  raw: string;
  expectedPreviewId: string;
  expectedChunkIndex: number;
  expectedRevisionChunkIndex: number;
  permittedSourceRefIds: readonly string[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
  sourceUnitCount: number;
  coveredStartOrdinal: number;
  coveredEndOrdinal: number;
  history: unknown;
};

export type AmuxAnalysisContinuationInspection =
  | { ok: true; parsed: Extract<AmuxAnalysisChunkInspection, { ok: true }>;
      cursor: Extract<AmuxOutputCursorDecision, { decision: "cursor_consistent" }> }
  | { ok: false; stage: "owner_input"; reason: "new_source_plan_required";
      parsed: Extract<AmuxAnalysisChunkInspection, { ok: true }> }
  | { ok: false; stage: "history"; reason: "history_invalid" | "history_closed" }
  | { ok: false; stage: "chunk"; code: Extract<AmuxAnalysisChunkInspection, { ok: false }>["code"] }
  | { ok: false; stage: "cursor"; reason: Extract<AmuxOutputCursorDecision, { decision: "hold" }>["reason"] };

const PAGE_KEYS = ["chunkIndex", "coveredStartOrdinal", "coveredEndOrdinal",
  "remainingStartOrdinal", "remainingEndOrdinal", "coverageStatus",
  "outputPartIndex", "outputPending"] as const;

function snapshotPage(raw: unknown): AmuxAnalysisOutputPage | null {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== PAGE_KEYS.length ||
        !PAGE_KEYS.every((key) => "value" in (descriptors[key] ?? {}))) return null;
    const page = Object.fromEntries(PAGE_KEYS.map((key) => [key, descriptors[key].value])) as
      AmuxAnalysisOutputPage;
    if (!Number.isSafeInteger(page.outputPartIndex) || page.outputPartIndex < 0 ||
        typeof page.outputPending !== "boolean") return null;
    return Object.freeze(page);
  } catch {
    return null;
  }
}

function snapshotHistory(raw: unknown, expectedRevisionChunkIndex: number): readonly AmuxAnalysisOutputPage[] | null {
  try {
    if (!Array.isArray(raw) || !Number.isSafeInteger(expectedRevisionChunkIndex) ||
        expectedRevisionChunkIndex < 0 ||
        Object.getOwnPropertyDescriptor(raw, "length")?.value !== expectedRevisionChunkIndex) return null;
    const copy: AmuxAnalysisOutputPage[] = [];
    for (let index = 0; index < expectedRevisionChunkIndex; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, index);
      if (!descriptor || !("value" in descriptor)) return null;
      const page = snapshotPage(descriptor.value);
      if (page === null) return null;
      copy.push(page);
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function priorContinuationKind(
  history: readonly AmuxAnalysisOutputPage[],
): "input" | "output" | null | "closed" {
  if (history.length === 0) return null;
  const previous = history[history.length - 1];
  if (previous.outputPending) return "output";
  return previous.remainingStartOrdinal === null ? "closed" : "input";
}

export function inspectAmuxAnalysisContinuation(
  input: AmuxAnalysisContinuationInput,
): AmuxAnalysisContinuationInspection {
  let fields: AmuxAnalysisContinuationInput;
  try {
    if (!input || typeof input !== "object") {
      return { ok: false, stage: "history", reason: "history_invalid" };
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = ["raw", "expectedPreviewId", "expectedChunkIndex", "expectedRevisionChunkIndex",
      "permittedSourceRefIds",
      "permittedTargetRefs", "sourceUnitCount", "coveredStartOrdinal", "coveredEndOrdinal", "history"];
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        !keys.every((key) => "value" in (descriptors[key] ?? {}))) {
      return { ok: false, stage: "history", reason: "history_invalid" };
    }
    fields = Object.fromEntries(keys.map((key) => [key, descriptors[key].value])) as
      AmuxAnalysisContinuationInput;
  } catch {
    return { ok: false, stage: "history", reason: "history_invalid" };
  }
  if (!Number.isSafeInteger(fields.expectedChunkIndex) || fields.expectedChunkIndex < 0 ||
      !Number.isSafeInteger(fields.expectedRevisionChunkIndex) ||
      fields.expectedRevisionChunkIndex < 0 ||
      fields.expectedRevisionChunkIndex > fields.expectedChunkIndex) {
    return { ok: false, stage: "history", reason: "history_invalid" };
  }
  const planStartChunkIndex = fields.expectedChunkIndex - fields.expectedRevisionChunkIndex;
  const history = snapshotHistory(fields.history, fields.expectedRevisionChunkIndex);
  if (history === null) return { ok: false, stage: "history", reason: "history_invalid" };
  if (history.some((page, index) => page.chunkIndex !== planStartChunkIndex + index)) {
    return { ok: false, stage: "history", reason: "history_invalid" };
  }
  // An owner answer changes the source-plan revision, so this history may not
  // be resumed by merely presenting an audit id. The new plan starts anew.
  if (history.some((page) => page.coverageStatus === "needs_owner_input")) {
    return { ok: false, stage: "history", reason: "history_closed" };
  }
  const previousKind = priorContinuationKind(history);
  if (previousKind === "closed") return { ok: false, stage: "history", reason: "history_closed" };

  const parsed = inspectAmuxAnalysisChunk({
    raw: fields.raw,
    expectedPreviewId: fields.expectedPreviewId,
    expectedChunkIndex: fields.expectedChunkIndex,
    expectedRevisionChunkIndex: fields.expectedRevisionChunkIndex,
    previousContinuationKind: previousKind,
    permittedSourceRefIds: fields.permittedSourceRefIds,
    permittedTargetRefs: fields.permittedTargetRefs,
  });
  if (!parsed.ok) return { ok: false, stage: "chunk", code: parsed.code };

  const { continuationKind, coverageStatus } = parsed.chunk;
  // A human question closes this source-plan run rather than producing an
  // executable next cursor. In particular, a question on the final source
  // ordinal cannot satisfy the ordinary completed-range cursor equation.
  if (coverageStatus === "needs_owner_input") {
    return fields.coveredStartOrdinal >= 0 &&
      fields.coveredStartOrdinal <= fields.coveredEndOrdinal &&
      fields.coveredEndOrdinal < fields.sourceUnitCount
      ? { ok: false, stage: "owner_input",
        reason: "new_source_plan_required", parsed }
      : { ok: false, stage: "cursor", reason: "remaining_mismatch" };
  }
  const remainingStartOrdinal = continuationKind === "output" ? fields.coveredEndOrdinal :
    continuationKind === "input" ? fields.coveredEndOrdinal + 1 : null;
  const remainingEndOrdinal = continuationKind === null ? null : fields.sourceUnitCount - 1;
  const previous = history[history.length - 1];
  const outputPartIndex = previous?.outputPending ? previous.outputPartIndex + 1 : 0;
  const candidate: AmuxAnalysisOutputPage = {
    chunkIndex: parsed.chunk.chunkIndex,
    coveredStartOrdinal: fields.coveredStartOrdinal,
    coveredEndOrdinal: fields.coveredEndOrdinal,
    remainingStartOrdinal,
    remainingEndOrdinal,
    coverageStatus,
    outputPartIndex,
    outputPending: continuationKind === "output",
  };
  const localCandidate: AmuxAnalysisOutputPage = {
    ...candidate,
    chunkIndex: fields.expectedRevisionChunkIndex,
  };
  const cursor = assessAmuxOutputCursorHistory({
    sourceUnitCount: fields.sourceUnitCount,
    history: history.map((page, index) => ({ ...page, chunkIndex: index })),
    verifiedOwnerResolutions: [],
    candidate: localCandidate,
  });
  if (cursor.decision === "hold") return { ok: false, stage: "cursor", reason: cursor.reason };
  return { ok: true, parsed, cursor: { ...cursor, candidate } };
}
