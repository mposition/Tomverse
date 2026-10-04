import assert from "node:assert/strict";
import test from "node:test";

import { assessAmuxOutputCursorHistory } from "../lib/amux/ideaOutputCursorCore.ts";

const page = (overrides = {}) => ({
  chunkIndex: 0,
  coveredStartOrdinal: 0,
  coveredEndOrdinal: 0,
  remainingStartOrdinal: 1,
  remainingEndOrdinal: 1,
  coverageStatus: "more",
  outputPartIndex: 0,
  outputPending: false,
  ...overrides,
});

const assess = (candidate, history = [], sourceUnitCount = 2,
  verifiedOwnerResolutions = []) => assessAmuxOutputCursorHistory({
  sourceUnitCount, history, verifiedOwnerResolutions, candidate,
});

test("one source ordinal may produce multiple bounded output pages", () => {
  const first = page({ coveredEndOrdinal: 0,
    remainingStartOrdinal: 0, outputPending: true });
  const firstResult = assess(first);
  assert.equal(firstResult.decision, "cursor_consistent");
  if (firstResult.decision === "cursor_consistent") {
    assert.deepEqual(firstResult.nextCursor, { sourceOrdinal: 0, outputPartIndex: 1 });
  }
  const second = page({ chunkIndex: 1, outputPartIndex: 1,
    coveredStartOrdinal: 0, coveredEndOrdinal: 0 });
  const secondResult = assess(second, [first]);
  assert.equal(secondResult.decision, "cursor_consistent");
  if (secondResult.decision === "cursor_consistent") {
    assert.deepEqual(secondResult.nextCursor, { sourceOrdinal: 1, outputPartIndex: 0 });
  }
  const third = page({ chunkIndex: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    remainingStartOrdinal: null, remainingEndOrdinal: null,
    coverageStatus: "complete" });
  assert.deepEqual(assess(third, [first, second]), {
    decision: "cursor_consistent", nextCursor: null, requiresOwnerInput: false,
    candidate: third,
  });
});

test("overflow on the final source ordinal can finish in a later part", () => {
  const first = page({ coveredEndOrdinal: 0, remainingStartOrdinal: 0,
    remainingEndOrdinal: 0, outputPending: true });
  const final = page({ chunkIndex: 1, outputPartIndex: 1,
    remainingStartOrdinal: null, remainingEndOrdinal: null,
    coverageStatus: "complete" });
  assert.equal(assess(first, [], 1).decision, "cursor_consistent");
  assert.equal(assess(final, [first], 1).decision, "cursor_consistent");
});

test("a pending output cursor cannot skip, repeat, or jump to a new source", () => {
  const first = page({ remainingStartOrdinal: 0, outputPending: true });
  assert.deepEqual(assess(page({ chunkIndex: 1, coveredStartOrdinal: 1,
    coveredEndOrdinal: 1, remainingStartOrdinal: null, remainingEndOrdinal: null,
    coverageStatus: "complete" }), [first]),
  { decision: "hold", reason: "output_part_mismatch" });
  assert.deepEqual(assess(page({ chunkIndex: 1, outputPartIndex: 2 }), [first]),
    { decision: "hold", reason: "output_part_mismatch" });
  assert.deepEqual(assess(page({ chunkIndex: 1, outputPartIndex: 1,
    coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    remainingStartOrdinal: null, remainingEndOrdinal: null,
    coverageStatus: "complete" }), [first]),
  { decision: "hold", reason: "output_cursor_mismatch" });
  assert.deepEqual(assess(page({ chunkIndex: 1, outputPartIndex: 1,
    remainingStartOrdinal: 0, outputPending: true }), [first]).decision,
    "cursor_consistent");
});

test("a closed output part cannot be resumed or overlap an input ordinal", () => {
  const first = page();
  assert.deepEqual(assess(page({ chunkIndex: 1, outputPartIndex: 1 }), [first]),
    { decision: "hold", reason: "output_part_mismatch" });
  assert.deepEqual(assess(page({ chunkIndex: 1, coveredStartOrdinal: 0 }), [first]),
    { decision: "hold", reason: "source_invalid" });
});

test("remaining metadata cannot claim completion while output is pending", () => {
  assert.deepEqual(assess(page({ outputPending: true })),
    { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assess(page({ outputPending: true, remainingStartOrdinal: 0,
    coverageStatus: "complete" })),
  { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assess(page({ coveredEndOrdinal: 1, outputPending: true,
    remainingStartOrdinal: 1, coverageStatus: "needs_owner_input" })),
  { decision: "hold", reason: "remaining_mismatch" });
  assert.deepEqual(assess(page({ outputPartIndex: Number.MAX_SAFE_INTEGER,
    outputPending: true, remainingStartOrdinal: 0 })),
  { decision: "hold", reason: "output_part_mismatch" });
});

test("owner-input pauses still require a human audit-bound resolution", () => {
  const paused = page({ coverageStatus: "needs_owner_input" });
  const next = page({ chunkIndex: 1, coveredStartOrdinal: 1,
    coveredEndOrdinal: 1, remainingStartOrdinal: null,
    remainingEndOrdinal: null, coverageStatus: "complete" });
  assert.deepEqual(assess(next, [paused]),
    { decision: "hold", reason: "owner_input_required" });
  assert.equal(assess(next, [paused], 2,
    [{ chunkIndex: 0, auditLogId: "owner-audit-1" }]).decision, "cursor_consistent");
  assert.deepEqual(assess(next, [paused], 2,
    [{ chunkIndex: 1, auditLogId: "owner-audit-1" }]),
  { decision: "hold", reason: "history_invalid" });
});

test("multi-part owner pauses bind proof to the terminal page exactly once", () => {
  const root = page({ remainingStartOrdinal: 0, outputPending: true });
  const paused = page({ chunkIndex: 1, outputPartIndex: 1,
    coverageStatus: "needs_owner_input" });
  const next = page({ chunkIndex: 2, coveredStartOrdinal: 1,
    coveredEndOrdinal: 1, remainingStartOrdinal: null,
    remainingEndOrdinal: null, coverageStatus: "complete" });
  assert.deepEqual(assess(next, [root, paused]),
    { decision: "hold", reason: "owner_input_required" });
  assert.equal(assess(next, [root, paused], 2,
    [{ chunkIndex: 1, auditLogId: "owner-audit-1" }]).decision, "cursor_consistent");
  assert.deepEqual(assess(next, [root, paused], 2,
    [{ chunkIndex: 0, auditLogId: "owner-audit-1" }]),
  { decision: "hold", reason: "history_invalid" });
  assert.deepEqual(assess(next, [root, paused], 2,
    [{ chunkIndex: 1, auditLogId: "owner-audit-1" },
      { chunkIndex: 1, auditLogId: "owner-audit-2" }]),
  { decision: "hold", reason: "history_invalid" });
  assert.deepEqual(assess({ ...next, chunkIndex: 1 }, [page()], 2,
    [{ chunkIndex: 0, auditLogId: "owner-audit-1" }]),
  { decision: "hold", reason: "history_invalid" });
});

test("the entire page history is checked, not only its final page", () => {
  const first = page({ remainingStartOrdinal: 0, outputPending: true });
  const corrupt = page({ chunkIndex: 1, outputPartIndex: 1,
    coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    remainingStartOrdinal: null, remainingEndOrdinal: null,
    coverageStatus: "complete" });
  const candidate = page({ chunkIndex: 2, coveredStartOrdinal: 1,
    coveredEndOrdinal: 1, remainingStartOrdinal: null,
    remainingEndOrdinal: null, coverageStatus: "complete" });
  assert.deepEqual(assess(candidate, [first, corrupt]),
    { decision: "hold", reason: "history_invalid" });
});

test("untrusted getters and sparse arrays never grant a cursor", () => {
  const sparse = Array(1);
  assert.deepEqual(assess(page({ chunkIndex: 1 }), sparse),
    { decision: "hold", reason: "metadata_incomplete" });
  const source = page();
  Object.defineProperty(source, "outputPending", { get() { throw new Error("read"); } });
  assert.deepEqual(assess(source), { decision: "hold", reason: "metadata_incomplete" });
  const history = [page()];
  let reads = 0;
  Object.defineProperty(history, 0, { get() { reads += 1; return page(); } });
  assert.deepEqual(assess(page({ chunkIndex: 1 }), history),
    { decision: "hold", reason: "metadata_incomplete" });
  assert.equal(reads, 0);
  assert.deepEqual(assessAmuxOutputCursorHistory({ sourceUnitCount: 0,
    history: [], verifiedOwnerResolutions: [], candidate: page() }),
  { decision: "hold", reason: "metadata_incomplete" });
  assert.deepEqual(assessAmuxOutputCursorHistory({ sourceUnitCount: 2,
    history: [], verifiedOwnerResolutions: [], candidate: page(), extra: true }),
  { decision: "hold", reason: "metadata_incomplete" });
  assert.deepEqual(assess(page({ chunkIndex: 2 }), [page()]),
    { decision: "hold", reason: "chunk_index_mismatch" });
});
