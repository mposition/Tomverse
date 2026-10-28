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
  return { resolved, readLapsed: async () => null,
    readPending: async () => pending,
    stillPending: async () => true, stillLapsed: async () => true,
    reissue: async (input) => { resolved.push({ reissue: input }); },
    prQueueFull: async () => false,
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

test("a full pull request queue reads no tier; every pending draft waits", async () => {
  let loads = 0;
  const value = ports({ prQueueFull: async () => true,
    loadStored: async () => { loads++; return t1; } });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "waiting" });
  assert.equal(loads, 0);
  assert.equal(value.resolved.length, 0);
});

test("a refused promotion becomes an ordinary draft, never pending again", async () => {
  const value = ports();
  value.resolve = async (input) => {
    value.resolved.push(input);
    if (input.candidate) throw new Error("Database error. Code: `23514`. the owner queue is full");
    return { kept: true };
  };
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "kept", reason: "publish_refused" });
  assert.deepEqual(value.resolved.map((input) => input.candidate === null),
    [false, true]);
  assert.deepEqual(await promoteEngineeringAgentV22Draft(ports({
    resolve: async () => ({ kept: false }) })), { outcome: "stale" });
  await assert.rejects(promoteEngineeringAgentV22Draft(ports({
    resolve: async () => { throw new Error("database_unavailable"); },
    loadStored: async () => ({ ok: false, reason: "patch_unavailable" }) })),
  /database_unavailable/);
});

test("a transient failure of a promotion leaves the draft pending for a later round", async () => {
  const value = ports();
  value.resolve = async (input) => {
    value.resolved.push(input);
    throw new Error("connection reset");
  };
  await assert.rejects(promoteEngineeringAgentV22Draft(value), /connection reset/);
  assert.equal(value.resolved.length, 1);
});

test("a publish item whose capability lapsed is judged again before any draft", async () => {
  const lapsed = { ...pending, workItemId: "publish-1",
    expectedTreeId: t1.candidate.expectedTreeId };
  let snapshotChecked = 0;
  const value = ports({ readLapsed: async () => lapsed,
    stillLapsed: async () => { snapshotChecked++; return true; },
    loadStored: async (item, still) => { await still(); return t1; },
    readPending: async () => { throw new Error("no draft is read"); } });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "reissued" });
  assert.equal(snapshotChecked, 1);
  assert.equal(value.resolved[0].reissue.workItemId, "publish-1");
  assert.equal(value.resolved[0].reissue.candidate.baseCommitterDate,
    t1.candidate.baseCommitterDate);
  // A full queue does not hold back a reissue: the item already counts in it.
  const full = ports({ readLapsed: async () => lapsed,
    prQueueFull: async () => true });
  assert.equal((await promoteEngineeringAgentV22Draft(full)).outcome, "reissued");
  for (const [stored, reason] of [
    [{ ...t1, tier: { tier: "T2", findings: [] } }, "tier_changed"],
    [{ ...t1, candidate: { ...t1.candidate, expectedTreeId: "f".repeat(40) } },
      "tier_changed"],
    [{ ok: false, reason: "publication_not_authorized" },
      "publication_not_authorized"],
  ]) {
    const refused = ports({ readLapsed: async () => lapsed,
      loadStored: async () => stored });
    assert.deepEqual(await promoteEngineeringAgentV22Draft(refused),
      { outcome: "reissue_refused", reason });
    assert.equal(refused.resolved.length, 0);
  }
});
