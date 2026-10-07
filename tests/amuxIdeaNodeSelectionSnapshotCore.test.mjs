import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { assembleAmuxV4NodeSelection } from
  "../lib/amux/ideaNodeSelectionSnapshotCore.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (digit) => ({ digest: digit.repeat(64), keyId: key.digestKeyId });

function fixture(action = "select_existing_node") {
  const proposal = { kind: "node", localId: "c0:node-0",
    level: "initiative", title: "Existing direction",
    description: "Explicitly map this proposal", parentRef: null };
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
    hierarchy: [], target: { id: "node_00000001", level: "initiative",
      parentId: null, revision: 0, content: keyed("8"), state: "active",
      approvedDecisionId: "decision_00002" }, sourceParentRef: null,
    duplicateScan: { scanVersion: "node-title-v1",
      checkedAtIso: "2026-10-05T01:00:00.000Z", query: keyed("d"),
      result: keyed("e"), complete: true, candidates: [] },
    action, decisionReason: action === "link_existing_node" ?
      "Existing node is the approved owner choice" : null, key };
}

test("selecting an approved node binds exact target metadata without copying text", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4NodeSelection(input);
  assert.ok(snapshot);
  assert.equal(snapshot.target.id, input.target.id);
  assert.equal(snapshot.nodeProposal, null);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    input.duplicateScan, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(input.proposal.description), false);
});

test("linking needs reason and altered source or hierarchy fails closed", () => {
  const linked = fixture("link_existing_node");
  const snapshot = assembleAmuxV4NodeSelection(linked);
  assert.ok(snapshot);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    linked.duplicateScan, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(linked.decisionReason), false);
  linked.decisionReason = null;
  assert.equal(assembleAmuxV4NodeSelection(linked), null);

  const mismatch = fixture();
  mismatch.target.parentId = "node_00000002";
  assert.equal(assembleAmuxV4NodeSelection(mismatch), null);
  const altered = fixture();
  altered.unit.bodyDigest = "0".repeat(64);
  assert.equal(assembleAmuxV4NodeSelection(altered), null);
});
