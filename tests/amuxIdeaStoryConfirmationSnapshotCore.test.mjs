import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";
import { assembleAmuxV4StoryConfirmation } from
  "../lib/amux/ideaStoryConfirmationSnapshotCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (digit) => ({ digest: digit.repeat(64), keyId: key.digestKeyId });
const proposal = () => ({ kind: "card", localId: "c0:card-0", cardType: "story",
  storyKind: "general", title: "A bounded Story", problem: "One missing result",
  scopeIn: ["one result"], scopeOut: ["worker execution"],
  completionCriteria: ["one checked result"], featureRef: "c0:node-2",
  parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
  taskRole: null, executionGrade: null, executionBrief: null, sourceRefIds: [] });
const nodes = [
  { id: "initiative_001", level: "initiative", parentId: null, revision: 0,
    content: keyed("a"), state: "active", approvedDecisionId: "decision_initiative_01" },
  { id: "epic_00000001", level: "epic", parentId: "initiative_001", revision: 0,
    content: keyed("b"), state: "active", approvedDecisionId: "decision_epic_0001" },
  { id: "feature_00001", level: "feature", parentId: "epic_00000001", revision: 0,
    content: keyed("c"), state: "active", approvedDecisionId: "decision_feature_01" },
];
function fixture() {
  const card = proposal();
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(card), "utf8"),
    "analysis_draft", "draft_0000001", key);
  const scan = { scanVersion: "card-title-reference-v1",
    checkedAtIso: "2026-10-05T01:00:00.000Z", query: keyed("d"),
    result: keyed("e"), complete: true, candidates: [] };
  return { ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001", ownerSession: keyed("1"),
    unit: { id: "draft_0000001", localRef: card.localId,
      bodyDigest: body.digest, bodyDigestKeyId: body.digestKeyId },
    proposal: card, preview: { id: "preview_00001",
      payloadDigest: "3".repeat(64), payloadDigestKeyId: key.digestKeyId,
      scopeApprovalId: null, scopeDigest: null, scopeDigestKeyId: null },
    hierarchy: structuredClone(nodes), sourceFeatureRef: "c0:node-2",
    duplicateScan: scan, decisionReason: null, key };
}

test("verified Story builds a strict, body-free confirmation snapshot", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4StoryConfirmation(input);
  assert.ok(snapshot);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    input.duplicateScan, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(cardSecret), false);
});
const cardSecret = "One missing result";

test("unresolved feature or altered draft body cannot borrow approval", () => {
  const wrongFeature = fixture();
  wrongFeature.sourceFeatureRef = "another_feature";
  assert.equal(assembleAmuxV4StoryConfirmation(wrongFeature), null);
  const wrongDigest = fixture();
  wrongDigest.unit.bodyDigest = "0".repeat(64);
  assert.equal(assembleAmuxV4StoryConfirmation(wrongDigest), null);
});
