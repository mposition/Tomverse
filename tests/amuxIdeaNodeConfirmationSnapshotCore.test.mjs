import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";
import { assembleAmuxV4NodeConfirmation } from
  "../lib/amux/ideaNodeConfirmationSnapshotCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
const keyed = (digit) => ({ digest: digit.repeat(64), keyId: key.digestKeyId });
const proposal = () => ({ kind: "node", localId: "c0:node-0",
  level: "initiative", title: "A strategic Initiative",
  description: "One bounded strategic area", parentRef: null });

function fixture() {
  const node = proposal();
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(node), "utf8"),
    "analysis_draft", "draft_0000001", key);
  const scan = { scanVersion: "node-title-v1",
    checkedAtIso: "2026-10-05T01:00:00.000Z", query: keyed("d"),
    result: keyed("e"), complete: true, candidates: [] };
  return { ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001", ownerSession: keyed("1"),
    nodeId: "node_00000001",
    unit: { id: "draft_0000001", localRef: node.localId,
      bodyDigest: body.digest, bodyDigestKeyId: body.digestKeyId },
    proposal: node, preview: { id: "preview_00001",
      payloadDigest: "3".repeat(64), payloadDigestKeyId: key.digestKeyId,
      scopeApprovalId: null, scopeDigest: null, scopeDigestKeyId: null },
    hierarchy: [], sourceParentRef: null, duplicateScan: scan,
    decisionReason: null, key };
}

test("one Initiative requires a separate body-free owner confirmation", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4NodeConfirmation(input);
  assert.ok(snapshot);
  assert.equal(snapshot.action, "create_node");
  assert.equal(snapshot.nodeProposal.id, input.nodeId);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key,
    input.duplicateScan, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(input.proposal.description), false);
});

test("altered proposal, missing parent or unexplained duplicate fails closed", () => {
  const altered = fixture();
  altered.unit.bodyDigest = "0".repeat(64);
  assert.equal(assembleAmuxV4NodeConfirmation(altered), null);

  const missingParent = fixture();
  missingParent.proposal.level = "epic";
  assert.equal(assembleAmuxV4NodeConfirmation(missingParent), null);

  const duplicate = fixture();
  duplicate.duplicateScan.candidates.push({ id: "node_00000002",
    level: "initiative", parentId: null, revision: 0,
    content: keyed("f"), archived: false });
  assert.equal(assembleAmuxV4NodeConfirmation(duplicate), null);
});
