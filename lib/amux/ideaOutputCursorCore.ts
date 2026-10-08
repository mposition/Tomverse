import {
  assessAmuxAnalysisCoverageHistory,
  type AmuxAnalysisCoveredRange,
} from "./ideaSourceCoverageCore.ts";

/**
 * Dark AMUX v4 output-page cursor guard. A source unit may yield more than the
 * eight-card response cap, so a page can leave outputPending=true and the next
 * page must revisit exactly its final source ordinal with a larger part index.
 * The source guard checks the collapsed input ranges after this page chain is
 * checked. Neither guard proves the model found every semantic requirement.
 *
 * The future writer must derive outputPending from a validated, nonempty
 * remaining-output declaration; verify the owner preview, immutable source
 * plan, canonical human audit proofs and DB lease; and enforce size and call
 * limits. This pure function does none of those things and authorizes no write.
 */
export type AmuxAnalysisOutputPage = AmuxAnalysisCoveredRange & {
  outputPartIndex: number;
  outputPending: boolean;
};

export type AmuxOutputCursorDecision =
  | { decision: "cursor_consistent"; nextCursor: {
      sourceOrdinal: number; outputPartIndex: number;
    } | null; requiresOwnerInput: boolean; candidate: AmuxAnalysisOutputPage }
  | { decision: "hold"; reason: "metadata_incomplete" | "history_invalid" |
      "chunk_index_mismatch" | "output_part_mismatch" | "output_cursor_mismatch" |
      "remaining_mismatch" | "owner_input_required" | "source_invalid" };

const PAGE_KEYS = ["chunkIndex", "coveredStartOrdinal", "coveredEndOrdinal",
  "remainingStartOrdinal", "remainingEndOrdinal", "coverageStatus",
  "outputPartIndex", "outputPending"] as const;
const AUDIT_KEYS = ["chunkIndex", "auditLogId"] as const;

function exactData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        !keys.every((key) => "value" in (descriptors[key] ?? {}))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key] = descriptors[key].value;
    return result;
  } catch {
    return null;
  }
}

const ordinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readPage(value: unknown): AmuxAnalysisOutputPage | null {
  const data = exactData(value, PAGE_KEYS);
  if (!data || !ordinal(data.chunkIndex) || !ordinal(data.coveredStartOrdinal) ||
      !ordinal(data.coveredEndOrdinal) || !ordinal(data.outputPartIndex) ||
      typeof data.outputPending !== "boolean" ||
      (data.remainingStartOrdinal !== null && !ordinal(data.remainingStartOrdinal)) ||
      (data.remainingEndOrdinal !== null && !ordinal(data.remainingEndOrdinal)) ||
      (data.remainingStartOrdinal === null) !== (data.remainingEndOrdinal === null) ||
      (data.coverageStatus !== "complete" && data.coverageStatus !== "more" &&
       data.coverageStatus !== "needs_owner_input")) return null;
  return {
    chunkIndex: data.chunkIndex,
    coveredStartOrdinal: data.coveredStartOrdinal,
    coveredEndOrdinal: data.coveredEndOrdinal,
    remainingStartOrdinal: data.remainingStartOrdinal,
    remainingEndOrdinal: data.remainingEndOrdinal,
    coverageStatus: data.coverageStatus,
    outputPartIndex: data.outputPartIndex,
    outputPending: data.outputPending,
  };
}

function readArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length)) return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !("value" in descriptor)) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function remainderMatches(page: AmuxAnalysisOutputPage, total: number): boolean {
  if (page.coveredStartOrdinal > page.coveredEndOrdinal ||
      page.coveredEndOrdinal >= total) return false;
  if (page.outputPending) {
    return page.coverageStatus === "more" &&
      page.remainingStartOrdinal === page.coveredEndOrdinal &&
      page.remainingEndOrdinal === total - 1;
  }
  if (page.coveredEndOrdinal === total - 1) {
    return page.remainingStartOrdinal === null && page.remainingEndOrdinal === null &&
      page.coverageStatus !== "more";
  }
  return page.remainingStartOrdinal === page.coveredEndOrdinal + 1 &&
    page.remainingEndOrdinal === total - 1 && page.coverageStatus !== "complete";
}

export function assessAmuxOutputCursorHistory(raw: unknown): AmuxOutputCursorDecision {
  const hold = (reason: Extract<AmuxOutputCursorDecision, { decision: "hold" }>["reason"]):
    AmuxOutputCursorDecision => ({ decision: "hold", reason });
  const input = exactData(raw,
    ["sourceUnitCount", "history", "verifiedOwnerResolutions", "candidate"]);
  if (!input || !Number.isSafeInteger(input.sourceUnitCount) ||
      (input.sourceUnitCount as number) <= 0) return hold("metadata_incomplete");
  const total = input.sourceUnitCount as number;
  const history = readArray(input.history);
  const proofs = readArray(input.verifiedOwnerResolutions);
  const candidate = readPage(input.candidate);
  if (history === null || proofs === null || candidate === null ||
      proofs.length > history.length) return hold("metadata_incomplete");
  const pages: AmuxAnalysisOutputPage[] = [];
  for (const rawPage of history) {
    const page = readPage(rawPage);
    if (page === null) return hold("history_invalid");
    pages.push(page);
  }
  pages.push(candidate);
  const groups: AmuxAnalysisOutputPage[][] = [];
  let previous: AmuxAnalysisOutputPage | null = null;
  for (const page of pages) {
    const expectedIndex = previous === null ? 0 : previous.chunkIndex + 1;
    if (!Number.isSafeInteger(expectedIndex) || page.chunkIndex !== expectedIndex) {
      return hold(page === candidate ? "chunk_index_mismatch" : "history_invalid");
    }
    if (page.outputPending && !Number.isSafeInteger(page.outputPartIndex + 1)) {
      return hold(page === candidate ? "output_part_mismatch" : "history_invalid");
    }
    if (!remainderMatches(page, total)) {
      return hold(page === candidate ? "remaining_mismatch" : "history_invalid");
    }
    if (previous?.outputPending) {
      if (!Number.isSafeInteger(previous.outputPartIndex + 1) ||
          page.outputPartIndex !== previous.outputPartIndex + 1) {
        return hold(page === candidate ? "output_part_mismatch" : "history_invalid");
      }
      if (page.coveredStartOrdinal !== previous.coveredEndOrdinal ||
          page.coveredEndOrdinal !== previous.coveredEndOrdinal) {
        return hold(page === candidate ? "output_cursor_mismatch" : "history_invalid");
      }
      groups[groups.length - 1].push(page);
    } else {
      if (page.outputPartIndex !== 0) {
        return hold(page === candidate ? "output_part_mismatch" : "history_invalid");
      }
      groups.push([page]);
    }
    previous = page;
  }
  const virtualRanges: AmuxAnalysisCoveredRange[] = groups.map((group, index) => {
    const root = group[0];
    const last = group[group.length - 1];
    const atEnd = root.coveredEndOrdinal === total - 1;
    // "complete" here means the input ordinal has been visited, not that its
    // pending output is complete. Only this wrapper's nextCursor is authoritative
    // for output continuation; never expose the virtual status as package state.
    return {
      chunkIndex: index,
      coveredStartOrdinal: root.coveredStartOrdinal,
      coveredEndOrdinal: root.coveredEndOrdinal,
      remainingStartOrdinal: atEnd ? null : root.coveredEndOrdinal + 1,
      remainingEndOrdinal: atEnd ? null : total - 1,
      coverageStatus: last.outputPending ? (atEnd ? "complete" : "more") : last.coverageStatus,
    };
  });
  const virtualProofs: { chunkIndex: number; auditLogId: string }[] = [];
  const provedGroups = new Set<number>();
  for (const rawProof of proofs) {
    const proof = exactData(rawProof, AUDIT_KEYS);
    if (!proof || !ordinal(proof.chunkIndex) || proof.chunkIndex >= candidate.chunkIndex ||
        typeof proof.auditLogId !== "string") {
      return hold("history_invalid");
    }
    const groupIndex = groups.findIndex((group) =>
      group[group.length - 1].chunkIndex === proof.chunkIndex);
    if (groupIndex < 0 || provedGroups.has(groupIndex) ||
        groups[groupIndex][groups[groupIndex].length - 1].coverageStatus !== "needs_owner_input") {
      return hold("history_invalid");
    }
    provedGroups.add(groupIndex);
    virtualProofs.push({ chunkIndex: groupIndex, auditLogId: proof.auditLogId });
  }
  const lastRange = virtualRanges[virtualRanges.length - 1];
  const sourceResult = assessAmuxAnalysisCoverageHistory({ sourceUnitCount: total,
    history: virtualRanges.slice(0, -1), verifiedOwnerResolutions: virtualProofs,
    candidate: lastRange });
  if (sourceResult.decision === "hold") {
    return hold(sourceResult.reason === "owner_input_required" ?
      "owner_input_required" : "source_invalid");
  }
  return {
    decision: "cursor_consistent",
    nextCursor: candidate.outputPending ? {
      sourceOrdinal: candidate.coveredEndOrdinal,
      outputPartIndex: candidate.outputPartIndex + 1,
    } : candidate.coveredEndOrdinal === total - 1 ? null : {
      sourceOrdinal: candidate.coveredEndOrdinal + 1,
      outputPartIndex: 0,
    },
    requiresOwnerInput: candidate.coverageStatus === "needs_owner_input",
    candidate,
  };
}
