import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { assembleAmuxV4CardLink } from
  "../lib/amux/ideaCardLinkSnapshotCore.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (digit) => ({ digest: digit.repeat(64), keyId: key.digestKeyId });
const nodes = [
  { id: "initiative_001", level: "initiative", parentId: null, revision: 0,
    content: keyed("a"), state: "active", approvedDecisionId: "decision_initiative_01" },
  { id: "epic_00000001", level: "epic", parentId: "initiative_001", revision: 0,
    content: keyed("b"), state: "active", approvedDecisionId: "decision_epic_0001" },
  { id: "feature_00001", level: "feature", parentId: "epic_00000001", revision: 0,
    content: keyed("c"), state: "active", approvedDecisionId: "decision_feature_01" },
];

function fixture() {
  const proposal = { kind: "card", localId: "c0:card-0", cardType: "story",
    storyKind: "general", title: "Existing Story", problem: "One missing result",
    scopeIn: ["one result"], scopeOut: ["worker execution"],
    completionCriteria: ["one checked result"], featureRef: "c0:node-2",
    parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
    taskRole: null, executionGrade: null, executionBrief: null, sourceRefIds: [] };
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
    "analysis_draft", "draft_0000001", key);
  return { ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001", ownerSession: keyed("1"),
    unit: { id: "draft_0000001", localRef: proposal.localId,
      bodyDigest: body.digest, bodyDigestKeyId: body.digestKeyId },
    proposal, preview: { id: "preview_00001", payloadDigest: "3".repeat(64),
      payloadDigestKeyId: key.digestKeyId, scopeApprovalId: null,
      scopeDigest: null, scopeDigestKeyId: null },
    hierarchy: structuredClone(nodes), target: { kind: "card",
      id: "story_0000001", cardType: "story", storyKind: "general",
      featureNodeId: "feature_00001", sourceSystem: "admin-idea-v4",
      status: "backlog", revision: 0, content: keyed("f") },
    sourceFeatureRef: "c0:node-2",
    duplicateScan: { scanVersion: "card-title-reference-v1",
      checkedAtIso: "2026-10-05T01:00:00.000Z", query: keyed("d"),
      result: keyed("e"), complete: true, candidates: [] },
    decisionReason: "This is the same existing Story", key };
}

test("linking an existing v4 card binds its revision without copying work text", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4CardLink(input);
  assert.ok(snapshot);
  assert.equal(snapshot.action, "link_existing_card");
  assert.equal(snapshot.card, null);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    input.duplicateScan, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(input.proposal.problem), false);
  assert.equal(JSON.stringify(snapshot).includes(input.decisionReason), false);
});

test("cross-feature, mismatched subtype, missing reason and changed draft fail closed", () => {
  const wrongFeature = fixture();
  wrongFeature.target.featureNodeId = "another_feature";
  assert.equal(assembleAmuxV4CardLink(wrongFeature), null);
  const wrongSubtype = fixture();
  wrongSubtype.target.storyKind = "bug";
  assert.equal(assembleAmuxV4CardLink(wrongSubtype), null);
  const noReason = fixture();
  noReason.decisionReason = "";
  assert.equal(assembleAmuxV4CardLink(noReason), null);
  const changedDraft = fixture();
  changedDraft.unit.bodyDigest = "0".repeat(64);
  assert.equal(assembleAmuxV4CardLink(changedDraft), null);
});
