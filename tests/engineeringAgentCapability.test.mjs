import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_TTL_MS,
  ENGINEERING_AGENT_VERIFIER_VERSION,
  decideConsumption,
  decideLastLook,
  issueCapability,
  postPushObservation,
  publisherTreeMatches,
} from "../lib/engineeringAgentCapability.ts";
import {
  CROSS_LOCK_ORDER,
  classifyState,
  decideMismatchAction,
  followsCrossLockOrder,
  resolveBOnAmuxTerminal,
} from "../lib/engineeringAgentStateMismatch.ts";

const NOW = new Date("2026-10-01T00:00:00Z");
const capability = issueCapability({
  baseSha: "b".repeat(40),
  patchDigest: "d".repeat(64),
  expectedTreeId: "e".repeat(40),
  verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
  policyVersion: 1,
  now: NOW,
});

/* Capability ---------------------------------------------------------- */

test("issuing checks every bound field", () => {
  assert.equal(capability.expiresAt.getTime() - capability.issuedAt.getTime(), CAPABILITY_TTL_MS);
  const base = {
    baseSha: "b".repeat(40),
    patchDigest: "d".repeat(64),
    expectedTreeId: "e".repeat(40),
    verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
    policyVersion: 1,
    now: NOW,
  };
  for (const overrides of [
    { baseSha: "B".repeat(40) },
    { patchDigest: "d".repeat(40) },
    { expectedTreeId: "e".repeat(39) },
    { verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION + 1 },
    { policyVersion: 0 },
  ]) {
    assert.throws(() => issueCapability({ ...base, ...overrides }), JSON.stringify(overrides));
  }
});

const consume = (overrides = {}) =>
  decideConsumption({
    capability,
    consumedAt: null,
    now: new Date(NOW.getTime() + 1000),
    currentVerifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
    currentPolicyVersion: 1,
    newFencingToken: "f".repeat(32),
    ...overrides,
  });

test("a capability is consumed once, only before it expires, only under the versions it was issued for", () => {
  assert.deepEqual(consume(), { allowed: true });
  assert.deepEqual(consume({ consumedAt: NOW }), { allowed: false, reason: "already_consumed" });
  assert.deepEqual(consume({ now: capability.expiresAt }), { allowed: false, reason: "expired" });
  assert.deepEqual(consume({ currentVerifierVersion: 2 }), {
    allowed: false,
    reason: "verifier_changed",
  });
  assert.deepEqual(consume({ currentPolicyVersion: 2 }), { allowed: false, reason: "policy_changed" });
  assert.deepEqual(consume({ newFencingToken: "short" }), { allowed: false, reason: "fencing_invalid" });
});

test("once consumed, expiry no longer matters -- consumption is not revocable", () => {
  // There is no function that un-consumes; a consumed capability answers
  // "already consumed" at any time, including after its expiry.
  assert.equal(
    consume({ consumedAt: NOW, now: new Date(capability.expiresAt.getTime() + 1) }).reason,
    "already_consumed",
  );
});

const look = (overrides = {}) =>
  decideLastLook({
    mode: "t1",
    frozen: false,
    killSwitch: false,
    amuxIncidentFrozen: false,
    halted: false,
    currentFencingToken: "a".repeat(32),
    presentedFencingToken: "a".repeat(32),
    consumedByWorkItemId: "wi-1",
    workItemId: "wi-1",
    ...overrides,
  });

test("the last look can only object or refuse", () => {
  assert.deepEqual(look(), { verdict: "no_objection" });
  const refusals = [
    [{ killSwitch: true }, "kill_switch"],
    [{ mode: "shadow" }, "mode_not_t1"],
    [{ mode: "off" }, "mode_not_t1"],
    [{ frozen: true }, "frozen"],
    [{ amuxIncidentFrozen: true }, "amux_incident"],
    [{ halted: true }, "halted"],
    [{ presentedFencingToken: "b".repeat(32) }, "stale_fencing_token"],
    [{ currentFencingToken: null }, "stale_fencing_token"],
    [{ consumedByWorkItemId: null }, "capability_not_consumed_by_this_item"],
    [{ consumedByWorkItemId: "wi-2" }, "capability_not_consumed_by_this_item"],
  ];
  for (const [overrides, reason] of refusals) {
    assert.deepEqual(look(overrides), { verdict: "refuse", reason }, reason);
  }
  const verdicts = new Set(
    [{}, ...refusals.map(([o]) => o)].map((overrides) => look(overrides).verdict),
  );
  assert.deepEqual([...verdicts].sort(), ["no_objection", "refuse"]);
});

test("the publisher pushes only the tree the app judged", () => {
  assert.equal(publisherTreeMatches(capability, "e".repeat(40)), true);
  assert.equal(publisherTreeMatches(capability, "f".repeat(40)), false);
  assert.equal(publisherTreeMatches(capability, "E".repeat(40)), false);
});

test("a difference seen after the push is an incident, never a block", () => {
  assert.equal(
    postPushObservation(capability, { treeId: "e".repeat(40), parents: ["b".repeat(40)] }),
    "consistent",
  );
  assert.equal(
    postPushObservation(capability, { treeId: "f".repeat(40), parents: ["b".repeat(40)] }),
    "incident",
  );
  assert.equal(
    postPushObservation(capability, {
      treeId: "e".repeat(40),
      parents: ["b".repeat(40), "c".repeat(40)],
    }),
    "incident",
  );
});

/* Lock order ---------------------------------------------------------- */

test("the cross lock order follows AMUX: attempt, work item, delivery, then engineering rows", () => {
  assert.deepEqual(CROSS_LOCK_ORDER.slice(0, 3), [
    "AmuxExecutionAttempt",
    "AmuxWorkItem",
    "AmuxWorkDelivery",
  ]);
  assert.equal(followsCrossLockOrder(["AmuxExecutionAttempt", "AmuxWorkItem", "EngineeringAgentRun"]), true);
  assert.equal(followsCrossLockOrder(["AmuxWorkItem", "EngineeringAgentWorkItem"]), true, "a prefix may be skipped");
  assert.equal(followsCrossLockOrder(["AmuxWorkItem", "AmuxExecutionAttempt"]), false, "never backwards");
  assert.equal(followsCrossLockOrder(["EngineeringAgentRun", "AmuxWorkItem"]), false);
  assert.equal(followsCrossLockOrder(["AmuxWorkerRuntime"]), false, "the runtime row is not ours to lock");
});

/* Classification ------------------------------------------------------ */

test("the matrix maps every combination, and anything else is unmapped", () => {
  const inProgress = { state: "in_progress" };
  assert.deepEqual(
    classifyState({ amux: inProgress, domain: inProgress, domainTerminalSinceLastRound: false }),
    { kind: "consistent" },
  );
  assert.deepEqual(
    classifyState({
      amux: { state: "terminal", settlement: "review" },
      domain: inProgress,
      domainTerminalSinceLastRound: false,
    }),
    { kind: "A" },
  );
  const domainDone = { state: "terminal", outcome: "t2_draft" };
  assert.deepEqual(
    classifyState({ amux: inProgress, domain: domainDone, domainTerminalSinceLastRound: false }),
    { kind: "consistent" },
  );
  assert.deepEqual(
    classifyState({ amux: inProgress, domain: domainDone, domainTerminalSinceLastRound: true }),
    { kind: "B" },
  );
  assert.deepEqual(
    classifyState({
      amux: { state: "terminal", settlement: "review" },
      domain: domainDone,
      domainTerminalSinceLastRound: true,
    }),
    { kind: "consistent" },
  );
  assert.deepEqual(
    classifyState({
      amux: { state: "terminal", settlement: "retry" },
      domain: domainDone,
      domainTerminalSinceLastRound: true,
    }),
    { kind: "C" },
  );
  assert.deepEqual(
    classifyState({
      amux: { state: "terminal", settlement: "recovered" },
      domain: { state: "terminal", outcome: "abandoned" },
      domainTerminalSinceLastRound: true,
    }),
    { kind: "consistent" },
  );
  assert.deepEqual(
    classifyState({ amux: { state: "absent" }, domain: inProgress, domainTerminalSinceLastRound: false }),
    { kind: "D" },
  );
  assert.deepEqual(
    classifyState({ amux: { state: "absent" }, domain: domainDone, domainTerminalSinceLastRound: true }),
    { kind: "unmapped" },
  );
});

/* Actions ------------------------------------------------------------- */

const action = (overrides) =>
  decideMismatchAction({
    kind: "A",
    action: "leave_open",
    reReadMatchesDetection: true,
    runActive: true,
    runTerminal: false,
    workItemState: "claimed",
    lookupVerifiedNoWrite: false,
    recurrences: 0,
    ...overrides,
  });

test("nothing acts on a state that changed since detection", () => {
  assert.deepEqual(action({ reReadMatchesDetection: false }), {
    allowed: false,
    reason: "state_changed_since_detection",
  });
});

test("each kind allows only its actions", () => {
  assert.equal(action({ kind: "B", action: "retry_lookup", runActive: false, runTerminal: true }).allowed, false);
  assert.equal(action({ kind: "C", action: "mode_off", runActive: false, runTerminal: true }).allowed, false);
  assert.equal(action({ kind: "D", action: "leave_open" }).allowed, false);
  assert.equal(action({ kind: "D", action: "mode_off" }).allowed, false);
});

test("closing the domain side requires a lookup that verified no write", () => {
  assert.deepEqual(action({ action: "close_domain_after_verified_no_write" }), {
    allowed: false,
    reason: "no_write_not_verified",
  });
  assert.deepEqual(
    action({ action: "close_domain_after_verified_no_write", lookupVerifiedNoWrite: true }),
    { allowed: true, resolves: true },
  );
});

test("leave_open and mode_off never resolve anything", () => {
  assert.deepEqual(action({ action: "leave_open" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "mode_off" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "retry_lookup" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "escalate_incident" }), { allowed: true, resolves: true });
});

test("preconditions per kind hold", () => {
  assert.equal(
    action({ runActive: false, workItemState: "published" }).allowed,
    false,
    "A needs an active run or a claimed item",
  );
  assert.equal(action({ runActive: false, workItemState: "needs_lookup" }).allowed, true);
  assert.equal(action({ kind: "B", runActive: false, runTerminal: false }).allowed, false);
  assert.equal(
    action({ kind: "D", action: "escalate_incident", runActive: false, workItemState: "queued" }).allowed,
    false,
  );
});

test("after two recurrences only escalation is left", () => {
  assert.deepEqual(action({ recurrences: 2 }), {
    allowed: false,
    reason: "recurred_only_escalation_left",
  });
  assert.deepEqual(action({ recurrences: 2, action: "escalate_incident" }), {
    allowed: true,
    resolves: true,
  });
});

test("B resolves only when AMUX concludes the same way; otherwise it becomes C", () => {
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "review", domainOutcome: "t1_queued" }), "resolved");
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "blocked", domainOutcome: "t1_queued" }), "C");
});
