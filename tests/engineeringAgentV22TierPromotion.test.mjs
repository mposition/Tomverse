import assert from "node:assert/strict";
import test from "node:test";

import { promoteEngineeringAgentV22Draft } from
  "../lib/engineeringAgentV22TierPromotion.ts";

const pending = { workItemId: "draft-1", runId: "123456789012",
  attemptId: "attempt-1", taskId: "card-1", modeAtStart: "t1",
  patchDigest: "a".repeat(64), baseSha: "b".repeat(40) };
const t1 = { ok: true, runId: pending.runId, taskId: pending.taskId,
  baseSha: pending.baseSha, patchBody: "diff", patchDigest: pending.patchDigest,
  candidate: { expectedTreeId: "c".repeat(40),
    baseCommitterDate: "1791336934 +1000" },
  tier: { tier: "T1", findings: [] }, imageProofDigest: "e".repeat(64) };

const ports = (overrides = {}) => {
  const resolved = [];
  return { resolved, readPending: async () => pending,
    loadStored: async () => t1,
    resolve: async (input) => {
      resolved.push(input);
      return input.candidate ? { publishWorkItemId: "publish-1" } :
        { kept: true };
    }, ...overrides };
};

test("nothing pending reads nothing", async () => {
  let loads = 0;
  const value = ports({ readPending: async () => null,
    loadStored: async () => { loads++; return t1; } });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "none" });
  assert.equal(loads, 0);
  assert.equal(value.resolved.length, 0);
});

test("a T1 verdict on the pending patch promotes it with its candidate", async () => {
  const value = ports();
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "promoted" });
  assert.deepEqual(value.resolved[0].candidate, {
    expectedTreeId: t1.candidate.expectedTreeId,
    baseCommitterDate: t1.candidate.baseCommitterDate,
    imageProofDigest: t1.imageProofDigest });
  assert.equal(value.resolved[0].workItemId, pending.workItemId);
});

test("anything short of T1 on this exact patch keeps an owner draft", async () => {
  const cases = [
    [{ ...t1, tier: { tier: "T2", findings: [] } }, "tier_two"],
    [{ ok: false, reason: "publication_not_authorized" },
      "publication_not_authorized"],
    [{ ok: false, reason: "Not A Code" }, "tier_evidence_unavailable"],
    [{ ...t1, patchDigest: "f".repeat(64) }, "tier_evidence_unavailable"],
    [{ ...t1, imageProofDigest: null }, "tier_evidence_unavailable"],
    [null, "tier_evidence_unavailable"],
  ];
  for (const [stored, reason] of cases) {
    const value = ports({ loadStored: async () => {
      if (stored === null) throw new Error("github_unavailable");
      return stored;
    } });
    assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
      { outcome: "kept", reason });
    assert.equal(value.resolved[0].candidate, null);
  }
  const shadow = ports({ readPending: async () =>
    ({ ...pending, modeAtStart: "shadow" }) });
  assert.equal((await promoteEngineeringAgentV22Draft(shadow)).outcome, "kept");
  assert.equal(shadow.resolved[0].candidate, null);
});

test("a draft no longer pending is left alone, and a refused write is not hidden", async () => {
  assert.deepEqual(await promoteEngineeringAgentV22Draft(ports({
    resolve: async () => ({ kept: false }) })), { outcome: "stale" });
  await assert.rejects(promoteEngineeringAgentV22Draft(ports({
    resolve: async () => { throw new Error("the owner queue is full"); } })),
  /owner queue is full/);
});
