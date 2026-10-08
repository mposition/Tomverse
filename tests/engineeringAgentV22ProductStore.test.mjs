import assert from "node:assert/strict";
import test from "node:test";

import { ENGINEERING_AGENT_COMMIT_IDENTITY } from
  "../lib/engineeringAgentCore.ts";
import { openEngineeringAgentV22Product } from
  "../lib/engineeringAgentV22ProductStore.ts";

const tx = { transactionMarker: "same-transaction" };
const patch = { text: "diff --git a/a.ts b/a.ts\n",
  sha256: "a".repeat(64), baseSha: "b".repeat(40) };
const candidate = { expectedTreeId: "c".repeat(40),
  baseCommitterDate: "1791336934 +1000" };
const input = { runId: "123456789012", taskId: "card-1", patch,
  candidate };

test("T1 product and its one-use capability use the same transaction", async () => {
  const calls = [];
  const product = await openEngineeringAgentV22Product(tx,
    { ...input, publish: true }, {
      open: async (usedTx, request) => {
        calls.push({ usedTx, request });
        return { workItemId: "item-1" };
      },
      issue: async (usedTx, request) => {
        calls.push({ usedTx, request });
        return { capabilityId: "cap-1", commitDigest: "d".repeat(64),
          expiresAt: new Date() };
      },
    });
  assert.equal(product.kind, "publish");
  assert.equal(product.id, "item-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].usedTx, tx);
  assert.equal(calls[1].usedTx, tx);
  assert.equal(calls[0].request.kind, "publish");
  assert.equal(calls[1].request.workItemId, "item-1");
  assert.deepEqual(calls[1].request.capability.commit,
    { identity: ENGINEERING_AGENT_COMMIT_IDENTITY,
      baseCommitterDate: candidate.baseCommitterDate,
      runId: input.runId, cardRef: input.taskId });
});

test("T2 draft issues no capability, and a failed issuer is not hidden", async () => {
  let issued = 0;
  const ports = { open: async () => ({ workItemId: "item-2" }),
    issue: async () => { issued++; throw new Error("issuer_refused"); } };
  const draft = await openEngineeringAgentV22Product(tx,
    { ...input, publish: false, candidate: null }, ports);
  assert.equal(draft.kind, "t2_draft");
  assert.equal(issued, 0);
  await assert.rejects(openEngineeringAgentV22Product(tx,
    { ...input, publish: true }, ports), /issuer_refused/);
  assert.equal(issued, 1);
  await assert.rejects(openEngineeringAgentV22Product(tx,
    { ...input, publish: true, candidate: null }, ports),
  /v22_publish_candidate_missing/);
  assert.equal(issued, 1);
});
