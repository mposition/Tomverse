import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxAnalysisContinuation } from "../lib/amux/ideaAnalysisContinuationCore.ts";

const sourceRef = "idea:opaque-source";
const feature = { ref: "feature_existing_01", kind: "node", level: "feature" };

const card = (chunkIndex) => ({
  kind: "card",
  localId: `c${chunkIndex}:card-1`,
  cardType: "story",
  storyKind: "general",
  title: "Preserve an independently testable task",
  problem: "A project-scale idea needs more than one output page.",
  scopeIn: ["Record the next bounded proposal"],
  scopeOut: ["Do not register or execute a worker"],
  completionCriteria: ["One proposal is visible for operator review"],
  featureRef: feature.ref,
  parentStoryRef: null,
  dependencyRefs: [],
  duplicateCandidateRefs: [],
  taskRole: null,
  executionGrade: null,
  executionBrief: null,
  sourceRefIds: [sourceRef],
});

const chunk = (chunkIndex, overrides = {}) => ({
  schemaVersion: 2,
  previewId: `preview-${chunkIndex}`,
  chunkIndex,
  outcome: "propose",
  coverageStatus: "complete",
  continuationKind: null,
  ownerQuestion: null,
  coveredScope: "One confirmed source unit was analyzed.",
  remainingScope: null,
  units: [card(chunkIndex)],
  ...overrides,
});

const inspect = (value, overrides = {}) => inspectAmuxAnalysisContinuation({
  raw: JSON.stringify(value),
  expectedPreviewId: value.previewId,
  expectedChunkIndex: value.chunkIndex,
  expectedRevisionChunkIndex: value.chunkIndex,
  permittedSourceRefIds: [sourceRef],
  permittedTargetRefs: [feature],
  sourceUnitCount: 1,
  coveredStartOrdinal: 0,
  coveredEndOrdinal: 0,
  history: [],
  ...overrides,
});

test("output remainder stays on the same source ordinal and advances a server-derived part", () => {
  const first = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "output",
    remainingScope: "More independently testable tasks remain from this unit.",
  }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.cursor.nextCursor, { sourceOrdinal: 0, outputPartIndex: 1 });
  assert.equal(first.cursor.candidate.outputPartIndex, 0);

  const second = inspect(chunk(1), { history: [first.cursor.candidate] });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.cursor.candidate.outputPartIndex, 1);
  assert.equal(second.cursor.nextCursor, null);
});

test("input continuation advances only after the previous source unit closes", () => {
  const first = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "input",
    remainingScope: "The second confirmed source unit remains.",
  }), { sourceUnitCount: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.cursor.nextCursor, { sourceOrdinal: 1, outputPartIndex: 0 });
  const second = inspect(chunk(1), {
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [first.cursor.candidate],
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.cursor.nextCursor, null);
});

test("a new revision resets the cursor locally but preserves global chunk IDs", () => {
  const first = inspect(chunk(5, {
    coverageStatus: "more", continuationKind: "input",
    remainingScope: "The next source unit remains.",
  }), { expectedRevisionChunkIndex: 0, sourceUnitCount: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.cursor.candidate.chunkIndex, 5);
  assert.deepEqual(first.cursor.nextCursor,
    { sourceOrdinal: 1, outputPartIndex: 0 },
    "the next cursor is source-local, not a second global chunk identity");
  const second = inspect(chunk(6), {
    expectedRevisionChunkIndex: 1,
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [first.cursor.candidate],
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.cursor.candidate.chunkIndex, 6);
  assert.deepEqual(inspect(chunk(7), {
    expectedRevisionChunkIndex: 1,
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [first.cursor.candidate],
  }), { ok: false, stage: "history", reason: "history_invalid" });
  assert.deepEqual(inspect(chunk(6), {
    expectedRevisionChunkIndex: 0, history: [first.cursor.candidate],
  }), { ok: false, stage: "history", reason: "history_invalid" });
  assert.deepEqual(inspect(chunk(5), { expectedRevisionChunkIndex: 6 }),
    { ok: false, stage: "history", reason: "history_invalid" });
  assert.deepEqual(inspect(chunk(5), { expectedRevisionChunkIndex: -1 }),
    { ok: false, stage: "history", reason: "history_invalid" });
});

test("model-declared completion cannot close an unvisited source ordinal", () => {
  assert.deepEqual(inspect(chunk(0), { sourceUnitCount: 2 }),
    { ok: false, stage: "cursor", reason: "remaining_mismatch" });
});

test("output remainder cannot be replaced by a cardless rejection or skipped source", () => {
  const first = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "output",
    remainingScope: "More cards remain.",
  }), { sourceUnitCount: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const rejection = chunk(1, { outcome: "reject", units: [] });
  assert.deepEqual(inspect(rejection, { history: [first.cursor.candidate] }),
    { ok: false, stage: "chunk", code: "schema_rejected" });
  assert.deepEqual(inspect(chunk(1), {
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [first.cursor.candidate],
  }), { ok: false, stage: "cursor", reason: "output_cursor_mismatch" });
});

test("owner question pauses this source plan rather than silently consuming its unit", () => {
  const first = inspect(chunk(0, {
    outcome: "needs_information", coverageStatus: "needs_owner_input",
    continuationKind: "input", ownerQuestion: "Which part should be analyzed next?",
    remainingScope: "The second source unit needs the operator's answer.", units: [],
  }), { sourceUnitCount: 2 });
  assert.equal(first.ok, false);
  assert.equal(first.stage, "owner_input");
  if (first.stage !== "owner_input") return;
  assert.equal(first.reason, "new_source_plan_required");
  assert.equal("cursor" in first, false);
  const stalePausedPage = {
    chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    remainingStartOrdinal: 1, remainingEndOrdinal: 1,
    coverageStatus: "needs_owner_input", outputPartIndex: 0, outputPending: false,
  };
  assert.deepEqual(inspect(chunk(1), {
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [stalePausedPage],
  }), { ok: false, stage: "history", reason: "history_closed" });
});

test("an owner question on the final source unit also pauses without claiming completion", () => {
  const paused = inspect(chunk(0, {
    outcome: "needs_information", coverageStatus: "needs_owner_input",
    continuationKind: null, ownerQuestion: "Which feature owns this work?",
    remainingScope: null, units: [],
  }));
  assert.equal(paused.stage, "owner_input");
  assert.equal("cursor" in paused, false);
});

test("an input continuation past the final source unit is held", () => {
  assert.deepEqual(inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "input",
    remainingScope: "A source is allegedly left.",
  })), { ok: false, stage: "cursor", reason: "remaining_mismatch" });
});

test("closed and malformed history never opens another analysis chunk", () => {
  const closed = inspect(chunk(0));
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.deepEqual(inspect(chunk(1), { history: [closed.cursor.candidate] }),
    { ok: false, stage: "history", reason: "history_closed" });
  assert.deepEqual(inspect(chunk(1), { history: Array(1) }),
    { ok: false, stage: "history", reason: "history_invalid" });
  const accessor = Object.defineProperty({}, "outputPending", { get() { throw new Error("never read"); } });
  assert.deepEqual(inspect(chunk(1), { history: [accessor] }),
    { ok: false, stage: "history", reason: "history_invalid" });
});

test("one descriptor snapshot defeats a Proxy that lies on ordinary property reads", () => {
  const first = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "output",
    remainingScope: "More cards remain.",
  }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const deceptive = new Proxy(first.cursor.candidate, {
    get(target, key, receiver) {
      if (key === "outputPending") return false;
      if (key === "remainingStartOrdinal") return 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(inspect(chunk(1, { outcome: "reject", units: [] }),
    { history: [deceptive] }),
  { ok: false, stage: "chunk", code: "schema_rejected" });

  const earlierInput = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "input",
    remainingScope: "A second source unit remains.",
  }), { sourceUnitCount: 2 });
  assert.equal(earlierInput.ok, true);
  if (!earlierInput.ok) return;
  assert.equal(inspect(chunk(1, { outcome: "reject", units: [] }), {
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [earlierInput.cursor.candidate],
  }).ok, true, "a genuine input continuation does not inherit the output-only rejection rule");
});

test("malformed part metadata and model-forged preview identity fail closed", () => {
  const first = inspect(chunk(0, {
    coverageStatus: "more", continuationKind: "output",
    remainingScope: "More cards remain.",
  }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(inspect(chunk(1), { history: [{ ...first.cursor.candidate, outputPartIndex: "0" }] }),
    { ok: false, stage: "history", reason: "history_invalid" });
  const getter = { ...first.cursor.candidate };
  Object.defineProperty(getter, "outputPartIndex", { get() { throw new Error("never read"); } });
  assert.deepEqual(inspect(chunk(1), { history: [getter] }),
    { ok: false, stage: "history", reason: "history_invalid" });
  assert.deepEqual(inspect({ ...chunk(0), previewId: "forged" },
    { expectedPreviewId: "preview-0" }),
  { ok: false, stage: "chunk", code: "schema_rejected" });
});

test("noninteger source ordinal and overflowing output part are held by the cursor guard", () => {
  assert.deepEqual(inspect(chunk(0), { coveredEndOrdinal: "0" }),
    { ok: false, stage: "cursor", reason: "metadata_incomplete" });
  const overflow = {
    chunkIndex: 0, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
    remainingStartOrdinal: 0, remainingEndOrdinal: 0,
    coverageStatus: "more", outputPartIndex: Number.MAX_SAFE_INTEGER,
    outputPending: true,
  };
  assert.deepEqual(inspect(chunk(1), { history: [overflow] }),
    { ok: false, stage: "cursor", reason: "metadata_incomplete" });
});
