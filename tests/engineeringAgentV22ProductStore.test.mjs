import assert from "node:assert/strict";
import test from "node:test";

import { ENGINEERING_AGENT_COMMIT_IDENTITY } from
  "../lib/engineeringAgentCore.ts";
import { openEngineeringAgentV22Product,
  reissueEngineeringAgentV22Capability,
  resolveEngineeringAgentV22Product } from
  "../lib/engineeringAgentV22ProductStore.ts";

const tx = { transactionMarker: "same-transaction" };
const patch = { text: "diff --git a/a.ts b/a.ts\n",
  sha256: "a".repeat(64), baseSha: "b".repeat(40) };
const candidate = { expectedTreeId: "c".repeat(40),
  baseCommitterDate: "1791336934 +1000", imageProofDigest: "e".repeat(64) };
const input = { workItemId: "draft-1", runId: "123456789012",
  taskId: "card-1", patchDigest: patch.sha256, baseSha: patch.baseSha,
  reason: "tier_two" };

test("settlement opens a draft only, pending a tier when the run may publish", async () => {
  const opened = [];
  const ports = { open: async (usedTx, request) => {
    opened.push({ usedTx, request });
    return { workItemId: `item-${opened.length}` };
  } };
  const pending = await openEngineeringAgentV22Product(tx,
    { runId: input.runId, patch, tierPending: true }, ports);
  await openEngineeringAgentV22Product(tx,
    { runId: input.runId, patch, tierPending: false }, ports);
  assert.equal(pending.kind, "t2_draft");
  assert.deepEqual(opened.map(({ usedTx, request }) =>
    [usedTx, request.kind, request.reason]), [
    [tx, "t2_draft", "tier_pending"],
    [tx, "t2_draft", "tier_evidence_unavailable"],
  ]);
});

test("a promotion and its one-use capability use the same transaction", async () => {
  const calls = [];
  const resolved = await resolveEngineeringAgentV22Product(tx,
    { ...input, candidate }, {
      resolve: async (usedTx, request) => {
        calls.push({ usedTx, request });
        return { publishWorkItemId: "item-1" };
      },
      issue: async (usedTx, request) => {
        calls.push({ usedTx, request });
        return { capabilityId: "cap-1", commitDigest: "d".repeat(64),
          expiresAt: new Date() };
      },
    });
  assert.deepEqual(resolved, { publishWorkItemId: "item-1" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].usedTx, tx);
  assert.equal(calls[1].usedTx, tx);
  assert.deepEqual(calls[0].request.promote, {
    expectedTreeId: candidate.expectedTreeId,
    imageProofDigest: candidate.imageProofDigest, ownerReview: false });
  assert.equal(calls[1].request.workItemId, "item-1");
  assert.deepEqual(calls[1].request.capability.commit,
    { identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
      baseCommitterDate: candidate.baseCommitterDate,
      runId: input.runId, cardRef: input.taskId });
});

test("an owner review promotion reaches the store as one, with or without gate evidence", async () => {
  const requests = [];
  await resolveEngineeringAgentV22Product(tx,
    { ...input, candidate: { ...candidate, imageProofDigest: null }, ownerReview: true }, {
      resolve: async (_tx, request) => { requests.push(request); return { publishWorkItemId: "item-3" }; },
      issue: async () => ({ capabilityId: "cap-3", commitDigest: "d".repeat(64), expiresAt: new Date() }),
    });
  assert.deepEqual(requests[0].promote, { expectedTreeId: candidate.expectedTreeId,
    imageProofDigest: null, ownerReview: true });
});

test("a kept draft issues no capability, and a failed issuer is not hidden", async () => {
  let issued = 0;
  const ports = {
    resolve: async (_tx, request) => request.promote ?
      { publishWorkItemId: "item-2" } : { kept: true },
    issue: async () => { issued++; throw new Error("issuer_refused"); },
  };
  assert.deepEqual(await resolveEngineeringAgentV22Product(tx,
    { ...input, candidate: null }, ports), { kept: true });
  assert.equal(issued, 0);
  await assert.rejects(resolveEngineeringAgentV22Product(tx,
    { ...input, candidate }, ports), /issuer_refused/);
  assert.equal(issued, 1);
  await assert.rejects(resolveEngineeringAgentV22Product(tx,
    { ...input, candidate: { ...candidate, baseCommitterDate: null } }, ports),
  /v22_publish_candidate_missing/);
  assert.equal(issued, 1);
});

test("a lapsed publish item's new capability binds the same commit fields", async () => {
  const issued = [];
  await reissueEngineeringAgentV22Capability(tx, { ...input,
    workItemId: "publish-1", candidate }, { issue: async (usedTx, request) => {
    issued.push({ usedTx, request });
    return { capabilityId: "cap-2", commitDigest: "d".repeat(64),
      expiresAt: new Date() };
  } });
  assert.equal(issued[0].usedTx, tx);
  assert.equal(issued[0].request.workItemId, "publish-1");
  assert.deepEqual(issued[0].request.capability, {
    baseSha: patch.baseSha, patchDigest: patch.sha256,
    expectedTreeId: candidate.expectedTreeId,
    commit: { identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
      baseCommitterDate: candidate.baseCommitterDate,
      runId: input.runId, cardRef: input.taskId } });
  await assert.rejects(reissueEngineeringAgentV22Capability(tx, { ...input,
    workItemId: "publish-1", candidate: { ...candidate, baseCommitterDate: null } },
  { issue: async () => { throw new Error("not reached"); } }),
  /v22_publish_candidate_missing/);
});
