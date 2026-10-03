import assert from "node:assert/strict";
import test from "node:test";

import { prepareSecondIdeaOnlyAnalysisDraft } from
  "../lib/amux/ideaSecondAnalysisDraftCore.ts";
import { openAmuxContent } from "../lib/amux/ideaCrypto.ts";

const keys = { masterKeyId: "test-master", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "test-digest",
  digestKey: Buffer.alloc(32, 7) };
const priorPage = { chunkIndex: 0, coveredStartOrdinal: 0,
  coveredEndOrdinal: 0, remainingStartOrdinal: 0,
  remainingEndOrdinal: 0, coverageStatus: "more", outputPartIndex: 0,
  outputPending: true };
const feature = { ref: "c0:node-2", kind: "node", level: "feature" };
const card = { kind: "card", localId: "c1:card-0", cardType: "story",
  storyKind: "general", title: "Review a second card",
  problem: "The first page did not cover the entire idea.",
  scopeIn: ["Show the second page"], scopeOut: ["Do not register cards"],
  completionCriteria: ["The second page is independently reviewable"],
  featureRef: feature.ref, parentStoryRef: null, dependencyRefs: [],
  duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
  executionBrief: null, sourceRefIds: ["operator_idea"] };
const chunk = (overrides = {}) => ({ schemaVersion: 2,
  previewId: "preview-02", chunkIndex: 1, outcome: "propose",
  coverageStatus: "complete", continuationKind: null, ownerQuestion: null,
  coveredScope: "The remaining work was proposed.", remainingScope: null,
  units: [card], ...overrides });
const prepare = (value, overrides = {}) => prepareSecondIdeaOnlyAnalysisDraft({
  ideaId: "idea-01", previewId: "preview-02", raw: JSON.stringify(value),
  keys, priorPage, permittedTargetRefs: [feature], ...overrides,
});

test("a second page closes one output cursor with separately sealed units", () => {
  const result = prepare(chunk());
  assert.equal(result.decision, "ready");
  if (result.decision !== "ready") return;
  assert.deepEqual([result.coveredStartOrdinal, result.coveredEndOrdinal,
    result.outputPartIndex, result.remainingStartOrdinal,
    result.remainingEndOrdinal], [0, 0, 1, null, null]);
  assert.equal(result.draft.units.length, 1);
  const unit = result.draft.units[0];
  const plain = openAmuxContent(unit.body, "analysis_draft", unit.id, keys);
  assert.equal(JSON.parse(plain.toString("utf8")).title, card.title);
  assert.equal(JSON.stringify(result).includes(card.title), false);
});

test("a second partial page keeps an explicit third-page output cursor", () => {
  const result = prepare(chunk({ coverageStatus: "more",
    continuationKind: "output", remainingScope: "More tasks remain." }));
  assert.equal(result.decision, "partial");
  if (result.decision !== "partial") return;
  assert.deepEqual([result.outputPartIndex, result.remainingStartOrdinal,
    result.remainingEndOrdinal], [1, 0, 0]);
});

test("closed history, forged targets and a cardless rejection fail closed", () => {
  assert.deepEqual(prepare(chunk(), { priorPage: {
    ...priorPage, outputPending: false, remainingStartOrdinal: null,
    remainingEndOrdinal: null,
  } }), { decision: "hold", reason: "invalid_result" });
  assert.deepEqual(prepare(chunk({ units: [{ ...card,
    featureRef: "c0:forged" }] })),
  { decision: "hold", reason: "invalid_result" });
  assert.deepEqual(prepare(chunk({ outcome: "reject", units: [] })),
  { decision: "hold", reason: "invalid_result" });
});

test("a mutable caller cannot change the response between cursor judgement and sealing", () => {
  let reads = 0;
  const input = { ideaId: "idea-01", previewId: "preview-02", keys,
    priorPage, permittedTargetRefs: [feature] };
  Object.defineProperty(input, "raw", { get() {
    reads += 1;
    return JSON.stringify(reads === 1 ? chunk() :
      chunk({ outcome: "reject", units: [] }));
  } });
  const result = prepareSecondIdeaOnlyAnalysisDraft(input);
  assert.equal(reads, 1);
  assert.equal(result.decision, "ready");
  if (result.decision === "ready") {
    assert.equal(result.draft.outcome, "propose");
    assert.equal(result.draft.units.length, 1);
  }
});

test("throwing or sparse target inputs return a hold instead of escaping the boundary", () => {
  const base = { ideaId: "idea-01", previewId: "preview-02",
    raw: JSON.stringify(chunk()), keys, priorPage };
  const sparse = Array(1);
  const growingLength = new Proxy([feature], {
    get(target, key, receiver) {
      if (key === "length") throw new Error("length must be snapshotted");
      return Reflect.get(target, key, receiver);
    },
  });
  const throwingIndex = [feature];
  Object.defineProperty(throwingIndex, 0, { get() { throw new Error("no getters"); } });
  const excessive = Array.from({ length: 513 }, () => feature);
  for (const permittedTargetRefs of [sparse, throwingIndex, excessive]) {
    assert.deepEqual(prepareSecondIdeaOnlyAnalysisDraft({
      ...base, permittedTargetRefs,
    }), { decision: "hold", reason: "invalid_result" });
  }
  assert.equal(prepareSecondIdeaOnlyAnalysisDraft({
    ...base, permittedTargetRefs: growingLength,
  }).decision, "ready");
  const throwingInput = { ...base, permittedTargetRefs: [feature] };
  Object.defineProperty(throwingInput, "raw", { get() { throw new Error("never escape"); } });
  assert.deepEqual(prepareSecondIdeaOnlyAnalysisDraft(throwingInput),
    { decision: "hold", reason: "invalid_result" });
});
