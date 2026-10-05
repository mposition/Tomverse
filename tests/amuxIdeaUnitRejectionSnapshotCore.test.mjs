import assert from "node:assert/strict";
import test from "node:test";

import { amuxCanonicalJson } from "../lib/amux/boardImportCore.ts";
import { amuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { deriveAmuxIdeaUnitConfirmation } from
  "../lib/amux/ideaUnitConfirmationCore.ts";
import { assembleAmuxV4UnitRejection } from
  "../lib/amux/ideaUnitRejectionSnapshotCore.ts";

const key = { digestKeyId: "key_v1", digestKey: Buffer.alloc(32, 7) };
function fixture() {
  const proposal = { kind: "node", localId: "c0:node-0",
    level: "initiative", title: "Do not build this", description: "Invalid scope",
    parentRef: null, duplicateCandidateRefs: [], sourceRefIds: [] };
  const body = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
    "analysis_draft", "draft_0000001", key);
  return { ideaId: "idea_00000001", decisionId: "decision_00001",
    prepareRequestId: "00000000-0000-4000-8000-000000000001",
    actorUserId: "owner_0000001",
    ownerSession: { digest: "1".repeat(64), keyId: key.digestKeyId },
    unit: { id: "draft_0000001", localRef: proposal.localId,
      bodyDigest: body.digest, bodyDigestKeyId: body.digestKeyId },
    proposal,
    preview: { id: "preview_00001", payloadDigest: "2".repeat(64),
      payloadDigestKeyId: key.digestKeyId,
      scopeApprovalId: null, scopeDigest: null, scopeDigestKeyId: null },
    reason: "The scope conflicts with the approved portfolio", key };
}

test("reject decision binds an exact proposal and reason without retaining raw text", () => {
  const input = fixture();
  const snapshot = assembleAmuxV4UnitRejection(input);
  assert.ok(snapshot);
  assert.equal(snapshot.action, "reject_unit");
  assert.equal(snapshot.card, null);
  assert.equal(snapshot.nodeProposal, null);
  assert.equal(snapshot.target, null);
  assert.equal(deriveAmuxIdeaUnitConfirmation(snapshot, key, null, null).ok, true);
  assert.equal(JSON.stringify(snapshot).includes(input.reason), false);
  assert.equal(JSON.stringify(snapshot).includes(input.proposal.description), false);
});

test("reject decision refuses an altered proposal or missing reason", () => {
  const input = fixture();
  input.unit.bodyDigest = "0".repeat(64);
  assert.equal(assembleAmuxV4UnitRejection(input), null);
  input.unit = fixture().unit;
  input.reason = " ";
  assert.equal(assembleAmuxV4UnitRejection(input), null);
});
