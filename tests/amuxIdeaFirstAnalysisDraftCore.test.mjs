import assert from "node:assert/strict";
import test from "node:test";

import { prepareFirstIdeaOnlyAnalysisDraft } from "../lib/amux/ideaFirstAnalysisDraftCore.ts";
import { openAmuxContent } from "../lib/amux/ideaCrypto.ts";

const keys = {
  masterKeyId: "test-master", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3),
  digestKeyId: "test-digest", digestKey: Buffer.alloc(32, 7),
};
const nodes = [
  { level: "initiative", parentRef: null, title: "Improve operator intake" },
  { level: "epic", parentRef: "c0:node-0", title: "Analyze ideas" },
  { level: "feature", parentRef: "c0:node-1", title: "Review analysis" },
].map((node, index) => ({ kind: "node", localId: `c0:node-${index}`,
  description: "A bounded operator proposal.", sourceRefIds: ["operator_idea"], ...node }));
const card = {
  kind: "card", localId: "c0:card-0", cardType: "story", storyKind: "general",
  title: "Review a suggested card", problem: "The operator needs a verified proposal.",
  scopeIn: ["Show the proposal"], scopeOut: ["Do not execute it"],
  completionCriteria: ["The operator can review the card"],
  featureRef: "c0:node-2", parentStoryRef: null,
  dependencyRefs: [], duplicateCandidateRefs: [], taskRole: null,
  executionGrade: null, executionBrief: null, sourceRefIds: ["operator_idea"],
};
const chunk = (overrides = {}) => ({
  schemaVersion: 2, previewId: "preview-01", chunkIndex: 0,
  outcome: "propose", coverageStatus: "complete", continuationKind: null,
  ownerQuestion: null, coveredScope: "The operator idea was analyzed.",
  remainingScope: null, units: [...nodes, card], ...overrides,
});
const prepare = (value) => prepareFirstIdeaOnlyAnalysisDraft({
  ideaId: "idea-01", previewId: "preview-01", raw: JSON.stringify(value), keys,
});

test("a complete first idea response becomes separately sealed units, not a card write", () => {
  const result = prepare(chunk());
  assert.equal(result.decision, "ready");
  if (result.decision !== "ready") return;
  assert.equal(result.draft.units.length, 4);
  assert.deepEqual(result.draft.units.map((unit) => unit.localRef),
    ["c0:node-0", "c0:node-1", "c0:node-2", "c0:card-0"]);
  const cardUnit = result.draft.units[3];
  const plain = openAmuxContent(cardUnit.body, "analysis_draft", cardUnit.id, keys);
  assert.equal(JSON.parse(plain.toString("utf8")).title, card.title);
  assert.equal(JSON.stringify(result).includes(card.title), false);
  assert.deepEqual([result.coveredStartOrdinal, result.coveredEndOrdinal,
    result.outputPartIndex], [0, 0, 0]);
});

test("an unfinished first response or owner question cannot masquerade as complete", () => {
  assert.deepEqual(prepare(chunk({ coverageStatus: "more", continuationKind: "output",
    remainingScope: "More cards remain." })),
  { decision: "hold", reason: "continuation_required" });
  assert.deepEqual(prepare(chunk({ outcome: "needs_information",
    coverageStatus: "needs_owner_input",
    ownerQuestion: "Which area is in scope?",
    units: [] })), { decision: "hold", reason: "owner_input" });
  assert.deepEqual(prepare(chunk({ units: [...nodes,
    { ...card, sourceRefIds: ["unapproved_source"] }] })),
  { decision: "hold", reason: "invalid_result" });
});
