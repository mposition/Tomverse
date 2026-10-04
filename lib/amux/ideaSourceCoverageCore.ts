/**
 * Numeric INPUT-source continuity check for AMUX v4 analysis chunks. Only
 * app-derived source ordinals belong here; model-authored coveredScope and
 * remainingScope text is untrusted. A "complete" range means only that the
 * current immutable source plan's input ordinals have been visited. It does
 * not prove semantic completeness or that every proposed card was emitted.
 *
 * The caller must bind every row to one immutable source plan, verify the
 * confirmed transfer preview and lease, and pause on needs_owner_input. The
 * internal single-step check reads only its immediate predecessor; a writer
 * must use the exported history check on the complete ordered chain. A verified
 * owner-resolution audit is required to cross a needs_owner_input pause.
 * The caller must prove audit ownership and source-plan binding in the DB;
 * an audit ID string by itself is not an authorization. If an owner's answer
 * changes a visited source unit, create a new source-plan revision rather than
 * reusing an ordinal. The source-plan builder must split every unit to fit the
 * confirmed 8 KiB input cap; this core checks no byte limits.
 *
 * Output overflow (for example, >8 cards from one source unit) needs its own
 * explicit continuation cursor and guard. This INPUT guard cannot represent
 * that case. No writer may interpret range_consistent as permission to store
 * a chunk or silently omit overflowing output until an output guard exists.
 * Budget/deadline pauses are package state outside this range record: retain
 * the last nextExpectedOrdinal and expose it without fabricating a chunk.
 * This core writes no state and authorizes no CLI call or card.
 */
export type AmuxAnalysisCoveredRange = {
  chunkIndex: number;
  coveredStartOrdinal: number;
  coveredEndOrdinal: number;
  remainingStartOrdinal: number | null;
  remainingEndOrdinal: number | null;
  coverageStatus: "complete" | "more" | "needs_owner_input";
};

export type AmuxAnalysisCandidateRange = AmuxAnalysisCoveredRange;

export type AmuxAnalysisCoverageDecision =
  | { decision: "range_consistent"; nextExpectedOrdinal: number | null;
      requiresOwnerInput: boolean; candidate: AmuxAnalysisCandidateRange }
  | { decision: "hold"; reason: "metadata_incomplete" | "previous_invalid" |
      "already_complete" | "owner_input_required" | "chunk_index_mismatch" | "range_gap" |
      "range_overlap" | "range_out_of_bounds" | "remaining_mismatch" |
      "premature_complete" };

const exactData = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        !keys.every((key) => "value" in (descriptors[key] ?? {}))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key] = descriptors[key].value;
    return result;
  } catch {
    return null;
  }
};

const ordinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const rangeKeys = ["chunkIndex", "coveredStartOrdinal", "coveredEndOrdinal",
  "remainingStartOrdinal", "remainingEndOrdinal", "coverageStatus"] as const;

function readRange(value: unknown): AmuxAnalysisCoveredRange | null {
  const data = exactData(value, rangeKeys);
  if (!data || !ordinal(data.chunkIndex) || !ordinal(data.coveredStartOrdinal) ||
      !ordinal(data.coveredEndOrdinal) ||
      (data.remainingStartOrdinal !== null && !ordinal(data.remainingStartOrdinal)) ||
      (data.remainingEndOrdinal !== null && !ordinal(data.remainingEndOrdinal)) ||
      (data.remainingStartOrdinal === null) !== (data.remainingEndOrdinal === null)) return null;
  if (data.coverageStatus !== "complete" && data.coverageStatus !== "more" &&
      data.coverageStatus !== "needs_owner_input") return null;
  const range: AmuxAnalysisCoveredRange = {
    chunkIndex: data.chunkIndex,
    coveredStartOrdinal: data.coveredStartOrdinal,
    coveredEndOrdinal: data.coveredEndOrdinal,
    remainingStartOrdinal: data.remainingStartOrdinal,
    remainingEndOrdinal: data.remainingEndOrdinal,
    coverageStatus: data.coverageStatus,
  };
  return range;
}

function assessOneAmuxAnalysisCoverage(
  raw: unknown, ownerInputResolved: boolean,
): AmuxAnalysisCoverageDecision {
  const hold = (reason: Extract<AmuxAnalysisCoverageDecision, { decision: "hold" }>["reason"]):
    AmuxAnalysisCoverageDecision => ({ decision: "hold", reason });
  const input = exactData(raw, ["sourceUnitCount", "previous", "candidate"]);
  if (!input || !Number.isSafeInteger(input.sourceUnitCount) ||
      (input.sourceUnitCount as number) <= 0) return hold("metadata_incomplete");
  const total = input.sourceUnitCount as number;
  const previous = input.previous === null ? null : readRange(input.previous);
  const candidate = readRange(input.candidate);
  if ((input.previous !== null && previous === null) || candidate === null) {
    return hold("metadata_incomplete");
  }
  if (previous !== null) {
    if ((previous.chunkIndex === 0 && previous.coveredStartOrdinal !== 0) ||
        previous.coveredStartOrdinal > previous.coveredEndOrdinal ||
        previous.coveredEndOrdinal >= total ||
        (previous.coverageStatus === "complete" &&
          (previous.coveredEndOrdinal !== total - 1 || previous.remainingStartOrdinal !== null)) ||
        (previous.coverageStatus === "more" && previous.remainingStartOrdinal === null) ||
        (previous.coverageStatus === "needs_owner_input" &&
          previous.remainingStartOrdinal === null && previous.coveredEndOrdinal !== total - 1) ||
        (previous.remainingStartOrdinal !== null &&
          (previous.coveredEndOrdinal >= total - 1 ||
           previous.remainingStartOrdinal !== previous.coveredEndOrdinal + 1 ||
           previous.remainingEndOrdinal !== total - 1 ||
           previous.remainingEndOrdinal === null ||
           previous.remainingStartOrdinal > previous.remainingEndOrdinal))) {
      return hold("previous_invalid");
    }
    if (previous.coverageStatus === "needs_owner_input" && !ownerInputResolved) {
      return hold("owner_input_required");
    }
    if (previous.remainingStartOrdinal === null) return hold("already_complete");
  }
  const expectedChunkIndex = previous === null ? 0 : previous.chunkIndex + 1;
  if (!Number.isSafeInteger(expectedChunkIndex) || candidate.chunkIndex !== expectedChunkIndex) {
    return hold("chunk_index_mismatch");
  }
  // A null remainder already returned already_complete above.
  const expectedStart = previous?.remainingStartOrdinal ?? 0;
  if (candidate.coveredStartOrdinal < expectedStart) return hold("range_overlap");
  if (candidate.coveredStartOrdinal > expectedStart) return hold("range_gap");
  if (candidate.coveredEndOrdinal < expectedStart || candidate.coveredEndOrdinal >= total) {
    return hold("range_out_of_bounds");
  }
  if (candidate.coverageStatus === "complete") {
    if (candidate.coveredEndOrdinal !== total - 1) return hold("premature_complete");
    if (candidate.remainingStartOrdinal !== null) return hold("remaining_mismatch");
    return { decision: "range_consistent", nextExpectedOrdinal: null,
      requiresOwnerInput: false, candidate };
  }
  if (candidate.coverageStatus === "needs_owner_input" && candidate.coveredEndOrdinal === total - 1 &&
      candidate.remainingStartOrdinal === null) {
    return { decision: "range_consistent", nextExpectedOrdinal: null,
      requiresOwnerInput: true, candidate };
  }
  if (candidate.coveredEndOrdinal === total - 1 ||
      candidate.remainingStartOrdinal !== candidate.coveredEndOrdinal + 1 ||
      candidate.remainingEndOrdinal !== total - 1) return hold("remaining_mismatch");
  return { decision: "range_consistent", nextExpectedOrdinal: candidate.remainingStartOrdinal,
    requiresOwnerInput: candidate.coverageStatus === "needs_owner_input", candidate };
}

type OwnerResolution = { chunkIndex: number; auditLogId: string };
const AUDIT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Validate every stored chunk from zero before accepting a new range. */
export function assessAmuxAnalysisCoverageHistory(raw: unknown): AmuxAnalysisCoverageDecision {
  const input = exactData(raw, ["sourceUnitCount", "history", "verifiedOwnerResolutions", "candidate"]);
  if (!input || !Number.isSafeInteger(input.sourceUnitCount) ||
      (input.sourceUnitCount as number) <= 0) {
    return { decision: "hold", reason: "metadata_incomplete" };
  }
  const total = input.sourceUnitCount as number;
  let history: unknown[];
  let ownerResolutions: unknown[];
  try {
    if (!Array.isArray(input.history) || !Array.isArray(input.verifiedOwnerResolutions)) {
      return { decision: "hold", reason: "previous_invalid" };
    }
    const historyLength = input.history.length;
    const resolutionLength = input.verifiedOwnerResolutions.length;
    if (!Number.isSafeInteger(historyLength) || historyLength > total ||
        !Number.isSafeInteger(resolutionLength) || resolutionLength > historyLength) {
      return { decision: "hold", reason: "previous_invalid" };
    }
    history = [];
    for (let index = 0; index < historyLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input.history, index);
      if (!descriptor || !("value" in descriptor)) {
        return { decision: "hold", reason: "previous_invalid" };
      }
      history.push(descriptor.value);
    }
    ownerResolutions = [];
    for (let index = 0; index < resolutionLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input.verifiedOwnerResolutions, index);
      if (!descriptor || !("value" in descriptor)) {
        return { decision: "hold", reason: "previous_invalid" };
      }
      ownerResolutions.push(descriptor.value);
    }
  } catch {
    return { decision: "hold", reason: "previous_invalid" };
  }
  const normalizedHistory = history.map((entry) => readRange(entry));
  if (normalizedHistory.some((entry) => entry === null)) {
    return { decision: "hold", reason: "previous_invalid" };
  }
  const verifiedHistory = normalizedHistory as AmuxAnalysisCoveredRange[];
  const resolved = new Set<number>();
  const auditIds = new Set<string>();
  for (const entry of ownerResolutions) {
    const proof = exactData(entry, ["chunkIndex", "auditLogId"]) as OwnerResolution | null;
    if (!proof || !ordinal(proof.chunkIndex) || proof.chunkIndex >= verifiedHistory.length ||
        typeof proof.auditLogId !== "string" || !AUDIT_ID.test(proof.auditLogId) ||
        verifiedHistory[proof.chunkIndex]?.coverageStatus !== "needs_owner_input" ||
        resolved.has(proof.chunkIndex) || auditIds.has(proof.auditLogId)) {
      return { decision: "hold", reason: "previous_invalid" };
    }
    resolved.add(proof.chunkIndex);
    auditIds.add(proof.auditLogId);
  }
  let previous: AmuxAnalysisCoveredRange | null = null;
  for (const historical of verifiedHistory) {
    const checked = assessOneAmuxAnalysisCoverage({ sourceUnitCount: total,
      previous, candidate: historical }, previous !== null && resolved.has(previous.chunkIndex));
    if (checked.decision !== "range_consistent") {
      return { decision: "hold", reason: "previous_invalid" };
    }
    previous = checked.candidate;
  }
  return assessOneAmuxAnalysisCoverage({ sourceUnitCount: total,
    previous, candidate: input.candidate }, previous !== null && resolved.has(previous.chunkIndex));
}
