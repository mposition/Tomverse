import assert from "node:assert/strict";
import test from "node:test";

import { prepareAmuxAnalysisPageDraft } from
  "../lib/amux/ideaAnalysisPageDraftCore.ts";

const keys = {
  masterKeyId: "test-master", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3),
  digestKeyId: "test-digest", digestKey: Buffer.alloc(32, 7),
};
const feature = { ref: "feature-1", kind: "node", level: "feature" };
const source = "operator_idea";
const card = (chunkIndex, index) => ({
  kind: "card", localId: `c${chunkIndex}:card-${index}`,
  cardType: "story", storyKind: "general", title: `Story ${index}`,
  problem: "One independently reviewable requirement.",
  scopeIn: ["Review this requirement"], scopeOut: ["Do not execute it"],
  completionCriteria: ["The operator can review the proposal"],
  featureRef: feature.ref, parentStoryRef: null, dependencyRefs: [],
  duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
  executionBrief: null, sourceRefIds: [source],
});
const chunk = (index, overrides = {}) => ({
  schemaVersion: 2, previewId: `preview-${index}`, chunkIndex: index,
  outcome: "propose", coverageStatus: "complete", continuationKind: null,
  ownerQuestion: null, coveredScope: "The approved source unit was analyzed.",
  remainingScope: null, units: [card(index, 0)], ...overrides,
});
const prepare = (value, overrides = {}) => prepareAmuxAnalysisPageDraft({
  ideaId: "idea-1", previewId: value.previewId, raw: JSON.stringify(value),
  keys, chunkIndex: value.chunkIndex, revisionChunkIndex: value.chunkIndex,
  permittedSourceRefIds: [source], permittedTargetRefs: [feature],
  sourceUnitCount: 1, coveredStartOrdinal: 0, coveredEndOrdinal: 0,
  history: [], ...overrides,
});

test("nine proposals remain two pages, not one rejected package or a silent truncation", () => {
  const first = prepare(chunk(0, { coverageStatus: "more",
    continuationKind: "output", remainingScope: "One more story remains.",
    units: Array.from({ length: 8 }, (_, index) => card(0, index)) }));
  assert.equal(first.decision, "ready");
  if (first.decision !== "ready") return;
  assert.equal(first.draft.units.length, 8);
  assert.deepEqual(first.nextCursor, { sourceOrdinal: 0, outputPartIndex: 1 });
  assert.equal(first.page.outputPending, true);
  const second = prepare(chunk(1), { history: [first.page] });
  assert.equal(second.decision, "ready");
  if (second.decision !== "ready") return;
  assert.equal(second.draft.units.length, 1);
  assert.equal(second.page.outputPartIndex, 1);
  assert.equal(second.nextCursor, null);
});

test("source continuation visits the next ordinal and preserves global chunk identity", () => {
  const first = prepare(chunk(5, { coverageStatus: "more",
    continuationKind: "input", remainingScope: "The second source unit remains." }),
  { revisionChunkIndex: 0, sourceUnitCount: 2 });
  assert.equal(first.decision, "ready");
  if (first.decision !== "ready") return;
  assert.deepEqual(first.nextCursor, { sourceOrdinal: 1, outputPartIndex: 0 });
  const second = prepare(chunk(6), { revisionChunkIndex: 1,
    sourceUnitCount: 2, coveredStartOrdinal: 1, coveredEndOrdinal: 1,
    history: [first.page] });
  assert.equal(second.decision, "ready");
  if (second.decision === "ready") assert.equal(second.nextCursor, null);
});

test("owner question pauses instead of claiming full analysis or launching the next page", () => {
  const result = prepare(chunk(0, { outcome: "needs_information",
    coverageStatus: "needs_owner_input", continuationKind: "input",
    ownerQuestion: "Which subproject is in scope?",
    remainingScope: "The second source unit needs an owner answer.",
    units: [] }), { sourceUnitCount: 2 });
  assert.equal(result.decision, "needs_owner_input");
  if (result.decision === "needs_owner_input") assert.equal(result.draft.units.length, 0);
});

test("an owner question on the final source unit also pauses", () => {
  const result = prepare(chunk(0, { outcome: "needs_information",
    coverageStatus: "needs_owner_input", continuationKind: "input",
    ownerQuestion: "Which Feature is in scope?",
    remainingScope: "The Story needs an owner answer.", units: [] }));
  assert.equal(result.decision, "needs_owner_input");
});

test("a forged completion cannot skip source units", () => {
  assert.deepEqual(prepare(chunk(0), { sourceUnitCount: 2 }),
    { decision: "hold", reason: "invalid_result" });
});
