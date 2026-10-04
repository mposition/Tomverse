import assert from "node:assert/strict";
import test from "node:test";

import { assessAmuxAnalysisCoverageHistory } from "../lib/amux/ideaSourceCoverageCore.ts";

const assessAmuxAnalysisCoverage = ({ sourceUnitCount, previous, candidate }) =>
  assessAmuxAnalysisCoverageHistory({ sourceUnitCount,
    history: previous === null ? [] : [previous], verifiedOwnerResolutions: [], candidate });

const first = (overrides = {}) => ({
  sourceUnitCount: 5,
  previous: null,
  candidate: {
    chunkIndex: 0,
    coveredStartOrdinal: 0,
    coveredEndOrdinal: 1,
    remainingStartOrdinal: 2,
    remainingEndOrdinal: 4,
    coverageStatus: "more",
    ...overrides,
  },
});

test("a bounded first range leaves a visible next ordinal", () => {
  assert.deepEqual(assessAmuxAnalysisCoverage(first()), {
    decision: "range_consistent",
    nextExpectedOrdinal: 2,
    requiresOwnerInput: false,
    candidate: first().candidate,
  });
});

test("subsequent ranges are consecutive and can complete the trusted source plan", () => {
  const priorRange = {
    chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 1,
    remainingStartOrdinal: 2, remainingEndOrdinal: 4, coverageStatus: "more",
  };
  assert.deepEqual(assessAmuxAnalysisCoverage({
    sourceUnitCount: 5,
    previous: priorRange,
    candidate: {
      chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 4,
      remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
    },
  }), {
    decision: "range_consistent", nextExpectedOrdinal: null, requiresOwnerInput: false,
    candidate: {
      chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 4,
      remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
    },
  });
});

test("gaps and overlaps are rejected without silently dropping source ordinals", () => {
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coveredStartOrdinal: 1 })),
    { decision: "hold", reason: "range_gap" });
  const previous = {
    chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 1,
    remainingStartOrdinal: 2, remainingEndOrdinal: 4, coverageStatus: "more",
  };
  assert.deepEqual(assessAmuxAnalysisCoverage({
    sourceUnitCount: 5, previous,
    candidate: {
      chunkIndex: 1, coveredStartOrdinal: 1, coveredEndOrdinal: 3,
      remainingStartOrdinal: 4, remainingEndOrdinal: 4, coverageStatus: "more",
    },
  }), { decision: "hold", reason: "range_overlap" });
});

test("completion cannot hide an unprocessed tail or a remaining range", () => {
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coverageStatus: "complete",
    remainingStartOrdinal: null, remainingEndOrdinal: null })),
  { decision: "hold", reason: "premature_complete" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coveredEndOrdinal: 4,
    coverageStatus: "complete" })),
  { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null })),
  { decision: "hold", reason: "remaining_mismatch" });
});

test("owner-input state preserves the exact remainder but never implies permission to call again", () => {
  const result = assessAmuxAnalysisCoverage(first({ coverageStatus: "needs_owner_input" }));
  assert.equal(result.decision, "range_consistent");
  if (result.decision === "range_consistent") {
    assert.equal(result.requiresOwnerInput, true);
    assert.equal(result.nextExpectedOrdinal, 2);
  }
  const next = {
    chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5,
    previous: first({ coverageStatus: "needs_owner_input" }).candidate, candidate: next }),
  { decision: "hold", reason: "owner_input_required" });
  const finalQuestion = assessAmuxAnalysisCoverage(first({ coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "needs_owner_input" }));
  assert.equal(finalQuestion.decision, "range_consistent");
  if (finalQuestion.decision === "range_consistent") {
    assert.equal(finalQuestion.requiresOwnerInput, true);
    assert.equal(finalQuestion.nextExpectedOrdinal, null);
  }
});

test("completed and malformed predecessor states cannot accept another chunk", () => {
  const complete = {
    chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  const candidate = {
    chunkIndex: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5, previous: complete, candidate }),
    { decision: "hold", reason: "already_complete" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5,
    previous: { ...complete, remainingStartOrdinal: 3, remainingEndOrdinal: 4 }, candidate }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5,
    previous: { ...complete, remainingStartOrdinal: 5, remainingEndOrdinal: 4 }, candidate }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5,
    previous: { ...complete, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
      remainingStartOrdinal: 2, remainingEndOrdinal: 4 }, candidate }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ sourceUnitCount: 5,
    previous: { ...complete, coveredEndOrdinal: 2 }, candidate }),
  { decision: "hold", reason: "previous_invalid" });
});

test("chunk index, bounds, and missing remainder fail closed", () => {
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ chunkIndex: 2 })),
    { decision: "hold", reason: "chunk_index_mismatch" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coveredEndOrdinal: 5 })),
    { decision: "hold", reason: "range_out_of_bounds" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ remainingStartOrdinal: null,
    remainingEndOrdinal: null })),
  { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ remainingStartOrdinal: 3 })),
    { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ remainingEndOrdinal: 3 })),
    { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assessAmuxAnalysisCoverage(first({ coveredEndOrdinal: 4,
    remainingStartOrdinal: 4, remainingEndOrdinal: 4,
    coverageStatus: "needs_owner_input" })),
  { decision: "hold", reason: "remaining_mismatch" });
});

test("untrusted metadata getters, extra keys, and invalid counts never grant a range", () => {
  const throwing = { sourceUnitCount: 5, history: [], verifiedOwnerResolutions: [],
    candidate: first().candidate };
  Object.defineProperty(throwing, "sourceUnitCount", { get() { throw new Error("read"); } });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory(throwing),
    { decision: "hold", reason: "metadata_incomplete" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: [], verifiedOwnerResolutions: [], candidate: first().candidate, extra: true }),
    { decision: "hold", reason: "metadata_incomplete" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ ...first(), sourceUnitCount: 0 }),
    { decision: "hold", reason: "metadata_incomplete" });
  assert.deepEqual(assessAmuxAnalysisCoverage({ ...first(), candidate: {
    ...first().candidate, coveredEndOrdinal: Number.MAX_SAFE_INTEGER + 1,
  } }), { decision: "hold", reason: "metadata_incomplete" });
});

test("the writer-facing history check rejects a gap hidden before the last chunk", () => {
  const firstRange = first().candidate;
  const skipped = {
    chunkIndex: 1, coveredStartOrdinal: 3, coveredEndOrdinal: 3,
    remainingStartOrdinal: 4, remainingEndOrdinal: 4, coverageStatus: "more",
  };
  const finalRange = {
    chunkIndex: 2, coveredStartOrdinal: 4, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({
    sourceUnitCount: 5, history: [firstRange, skipped],
    verifiedOwnerResolutions: [], candidate: finalRange,
  }), { decision: "hold", reason: "previous_invalid" });
  const middle = { ...skipped, coveredStartOrdinal: 2 };
  assert.equal(assessAmuxAnalysisCoverageHistory({
    sourceUnitCount: 5, history: [firstRange, middle],
    verifiedOwnerResolutions: [], candidate: finalRange,
  }).decision, "range_consistent");
});

test("history inspection cannot skip an owner-input pause or sparse row", () => {
  const finalRange = {
    chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: [first({ coverageStatus: "needs_owner_input" }).candidate],
    verifiedOwnerResolutions: [], candidate: finalRange }),
  { decision: "hold", reason: "owner_input_required" });
  assert.equal(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: [first({ coverageStatus: "needs_owner_input" }).candidate],
    verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "audit-owner-resolution-1" }],
    candidate: finalRange }).decision, "range_consistent");
  const sparse = Array(2);
  sparse[1] = first().candidate;
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: sparse, verifiedOwnerResolutions: [], candidate: finalRange }),
  { decision: "hold", reason: "previous_invalid" });
  const accessorHistory = [first().candidate];
  let reads = 0;
  Object.defineProperty(accessorHistory, 0, { get() { reads += 1; return first().candidate; } });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: accessorHistory, verifiedOwnerResolutions: [], candidate: finalRange }),
  { decision: "hold", reason: "previous_invalid" });
  assert.equal(reads, 0);
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: [{ ...first().candidate, coverageStatus: "complete",
      remainingStartOrdinal: null, remainingEndOrdinal: null }],
    verifiedOwnerResolutions: [], candidate: finalRange }),
  { decision: "hold", reason: "previous_invalid" });
});

test("owner-resolution metadata must be a one-to-one well-formed reference", () => {
  const candidate = {
    chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "complete",
  };
  const paused = first({ coverageStatus: "needs_owner_input" }).candidate;
  const input = { sourceUnitCount: 5, history: [paused], candidate };
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "a-1" },
      { chunkIndex: 0, auditLogId: "a-2" }] }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    verifiedOwnerResolutions: [{ chunkIndex: 1, auditLogId: "a-1" }] }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "bad id" }] }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    history: [first().candidate], verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "a-1" }] }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "a-1" },
      { chunkIndex: 1, auditLogId: "a-2" }] }),
  { decision: "hold", reason: "previous_invalid" });
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ ...input,
    history: [paused, { chunkIndex: 1, coveredStartOrdinal: 2, coveredEndOrdinal: 3,
      remainingStartOrdinal: 4, remainingEndOrdinal: 4, coverageStatus: "needs_owner_input" }],
    verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "a-1" },
      { chunkIndex: 1, auditLogId: "a-1" }] }),
  { decision: "hold", reason: "previous_invalid" });
  const finalPause = { chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 4,
    remainingStartOrdinal: null, remainingEndOrdinal: null, coverageStatus: "needs_owner_input" };
  assert.deepEqual(assessAmuxAnalysisCoverageHistory({ sourceUnitCount: 5,
    history: [finalPause], verifiedOwnerResolutions: [{ chunkIndex: 0, auditLogId: "a-1" }],
    candidate: { ...candidate, coveredStartOrdinal: 4 } }),
  { decision: "hold", reason: "already_complete" });
});
