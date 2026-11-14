import assert from "node:assert/strict";
import test from "node:test";

import { ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS,
  promoteEngineeringAgentV22Draft } from
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
  return { resolved, failures: new Map(), readLapsed: async () => null,
    readPending: async () => pending,
    stillPending: async () => true, stillLapsed: async () => true,
    reissue: async (input) => { resolved.push({ reissue: input }); },
    expireLapsed: async (workItemId, reason) => {
      resolved.push({ expire: { workItemId, reason } }); },
    prQueueFull: async () => false,
    loadStored: async () => t1,
    resolve: async (input) => {
      resolved.push(input);
      return input.candidate ? { publishWorkItemId: "publish-1" } :
        { kept: true };
    }, reviewPrEnabled: () => false, ...overrides };
};
const t2 = { ...t1, tier: { tier: "T2", findings: [] }, imageProofDigest: null,
  candidate: { ...t1.candidate, changes: [{ path: "components/chat/x.tsx" }] } };

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
  ];
  for (const [stored, reason] of cases) {
    const value = ports({ loadStored: async () => {
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

test("with its switch on, a T2 verdict opens an owner review item; T1 stays ordinary", async () => {
  const value = ports({ reviewPrEnabled: () => true, loadStored: async () => t2 });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value),
    { outcome: "review_promoted" });
  assert.equal(value.resolved[0].ownerReview, true);
  assert.deepEqual(value.resolved[0].candidate, {
    expectedTreeId: t2.candidate.expectedTreeId,
    baseCommitterDate: t2.candidate.baseCommitterDate, imageProofDigest: null });
  const ordinary = ports({ reviewPrEnabled: () => true });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(ordinary),
    { outcome: "promoted" });
  assert.equal(ordinary.resolved[0].ownerReview, false);
  // Off, or a patch that does not qualify: an ordinary owner draft, as before.
  for (const [enabled, stored] of [
    [false, t2],
    [true, { ...t2, candidate: { ...t2.candidate,
      changes: [{ path: ".github/workflows/ci.yml" }] } }],
    [true, { ...t2, patchDigest: "f".repeat(64) }],
    [true, { ok: false, reason: "patch_unavailable" }],
  ]) {
    const kept = ports({ reviewPrEnabled: () => enabled, loadStored: async () => stored });
    assert.equal((await promoteEngineeringAgentV22Draft(kept)).outcome, "kept");
    assert.equal(kept.resolved[0].candidate, null);
  }
  // The database still refusing it is an ordinary draft, like a T1 refusal.
  const refused = ports({ reviewPrEnabled: () => true, loadStored: async () => t2 });
  refused.resolve = async (input) => {
    refused.resolved.push(input);
    if (input.candidate) throw new Error("Database error. Code: `23514`.");
    return { kept: true };
  };
  assert.deepEqual(await promoteEngineeringAgentV22Draft(refused),
    { outcome: "kept", reason: "publish_refused" });
});

test("a lapsed owner review item is reissued on T1 or T2 while on, and closed when off", async () => {
  const lapsed = { ...pending, workItemId: "publish-1",
    expectedTreeId: t1.candidate.expectedTreeId, ownerReview: true };
  for (const stored of [t1, t2]) {
    const value = ports({ readLapsed: async () => lapsed,
      reviewPrEnabled: () => true, loadStored: async () => stored });
    assert.deepEqual(await promoteEngineeringAgentV22Draft(value), { outcome: "reissued" });
    assert.equal(value.resolved[0].reissue.workItemId, "publish-1");
  }
  const off = ports({ readLapsed: async () => lapsed, loadStored: async () => t2 });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(off),
    { outcome: "reissue_refused", reason: "review_pr_off" });
  assert.deepEqual(off.resolved, [{ expire: { workItemId: "publish-1", reason: "review_pr_off" } }]);
  // An ordinary item is never kept alive by a T2 verdict, switch or not.
  const ordinary = ports({ readLapsed: async () => ({ ...lapsed, ownerReview: false }),
    reviewPrEnabled: () => true, loadStored: async () => t2 });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(ordinary),
    { outcome: "reissue_refused", reason: "tier_changed" });
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
    expectedTreeId: t1.candidate.expectedTreeId, ownerReview: false };
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
    // Closed, so it neither holds the queue nor comes first again.
    assert.deepEqual(refused.resolved, [{ expire: { workItemId: "publish-1", reason } }]);
  }
  const unreadable = ports({ readLapsed: async () => lapsed,
    loadStored: async () => { throw new Error("github_unavailable"); } });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(unreadable),
    { outcome: "reissue_refused", reason: "tier_evidence_unavailable",
      workItemId: "publish-1", stage: "authorization", error: "Error", code: null });
  assert.equal(unreadable.resolved.length, 0);
});

class GitHubReadError extends Error {
  constructor(code) { super(`secret patch text ${code}`); this.name = "EngineeringAgentGitHubReadError"; this.code = code; }
}

test("an evidence read that throws leaves the draft pending, then keeps it after its rounds", async () => {
  const failures = new Map();
  let reads = 0;
  const round = () => promoteEngineeringAgentV22Draft(ports({ failures,
    loadStored: async (item, still, onStage) => {
      reads++;
      onStage("patch_read");
      onStage("candidate_rebuild");
      throw new GitHubReadError("transport_error");
    } }));
  for (let attempt = 1; attempt < ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS; attempt++) {
    const value = ports({ failures, loadStored: async (item, still, onStage) => {
      reads++;
      onStage("candidate_rebuild");
      throw new GitHubReadError("transport_error");
    } });
    // The failure's class, code and step reach the log line; its message never does.
    assert.deepEqual(await promoteEngineeringAgentV22Draft(value), {
      outcome: "retry", reason: "tier_evidence_unavailable",
      workItemId: pending.workItemId, attempt, stage: "candidate_rebuild",
      error: "EngineeringAgentGitHubReadError", code: "transport_error" });
    assert.equal(value.resolved.length, 0);
    assert.equal(failures.get(pending.workItemId), attempt);
  }
  const last = await round();
  assert.deepEqual(last, { outcome: "kept", reason: "tier_evidence_unavailable",
    workItemId: pending.workItemId,
    attempt: ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS,
    stage: "candidate_rebuild", error: "EngineeringAgentGitHubReadError",
    code: "transport_error" });
  assert.doesNotMatch(JSON.stringify(last), /secret patch text/);
  assert.equal(reads, ENGINEERING_AGENT_V22_TIER_EVIDENCE_ATTEMPTS);
  assert.equal(failures.size, 0);
});

test("a read that succeeds after a throw is judged as usual and forgets the failure", async () => {
  const failures = new Map();
  const thrown = ports({ failures, loadStored: async () => {
    throw Object.assign(new Error("Can't reach database server"), { code: "P1001" }); } });
  const first = await promoteEngineeringAgentV22Draft(thrown);
  assert.equal(first.outcome, "retry");
  assert.equal(first.stage, "authorization");
  assert.equal(first.code, "P1001");
  const recovered = ports({ failures });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(recovered),
    { outcome: "promoted" });
  assert.equal(failures.size, 0);
  // A code that is not a short identifier is not logged.
  const odd = await promoteEngineeringAgentV22Draft(ports({ loadStored: async () => {
    throw Object.assign(new Error("x"), { code: "contains spaces / and a path" }); } }));
  assert.equal(odd.code, null);
});

test("a draft whose read threw goes behind the others for the next round", async () => {
  const failures = new Map([["draft-0", 1]]);
  let behind = null;
  const value = ports({ failures, readPending: async (set) => {
    behind = [...set];
    return pending;
  } });
  assert.deepEqual(await promoteEngineeringAgentV22Draft(value), { outcome: "promoted" });
  assert.deepEqual(behind, ["draft-0"]);
  // The other draft's success leaves the failing one's count as it was.
  assert.equal(failures.get("draft-0"), 1);
});
