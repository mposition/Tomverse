import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_TTL_MS,
  ENGINEERING_AGENT_VERIFIER_VERSION,
  capabilityCommitObject,
  consumeCapability,
  decideLastLook,
  issueCapability,
  mayCreateBranch,
  postPushObservation,
  publisherCommitMatches,
} from "../lib/engineeringAgentCapability.ts";
import { RUN_OUTCOMES } from "../lib/engineeringAgentCore.ts";
import {
  CROSS_LOCK_ORDER,
  classifyState,
  decideMismatchAction,
  expectedSettlement,
  followsCrossLockOrder,
  resolveBOnAmuxTerminal,
} from "../lib/engineeringAgentStateMismatch.ts";

const NOW = new Date("2026-10-01T00:00:00Z");
const commit = {
  identity: { name: "Tomverse Engineering Agent", email: "engineering-agent@users.noreply.github.com" },
  baseCommitterDate: "1759000000 +1000",
  runId: "42",
  cardRef: "cm1abc",
};
const issueInput = {
  baseSha: "b".repeat(40),
  patchDigest: "d".repeat(64),
  expectedTreeId: "e".repeat(40),
  verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
  policyVersion: 1,
  commit,
  now: NOW,
};
const capability = issueCapability(issueInput);
const FENCE = "a".repeat(32);

/* Capability ---------------------------------------------------------- */

test("issuing binds every field, including the commit and the branch", () => {
  assert.equal(capability.expiresAt.getTime() - capability.issuedAt.getTime(), CAPABILITY_TTL_MS);
  assert.equal(capability.branch, "agent/engineering/42");
  assert.deepEqual(capability.commit, commit);
  assert.notEqual(capability.commit, commit, "the capability holds its own copy");
  for (const overrides of [
    { baseSha: "B".repeat(40) },
    { patchDigest: "d".repeat(40) },
    { expectedTreeId: "e".repeat(39) },
    { verifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION + 1 },
    { policyVersion: 0 },
    { commit: { ...commit, runId: "x" } },
    { commit: { ...commit, baseCommitterDate: "now" } },
    { commit: { ...commit, cardRef: "a\nb" } },
    { commit: { ...commit, identity: { name: "x\nparent y", email: "e" } } },
  ]) {
    assert.throws(() => issueCapability({ ...issueInput, ...overrides }), JSON.stringify(overrides));
  }
});

const consume = (overrides = {}) =>
  consumeCapability({
    capability,
    consumedAt: null,
    now: new Date(NOW.getTime() + 1000),
    currentVerifierVersion: ENGINEERING_AGENT_VERIFIER_VERSION,
    currentPolicyVersion: 1,
    claimFencingToken: FENCE,
    workItemId: "wi-1",
    ...overrides,
  });

test("consumption binds the claim's fencing token and work item", () => {
  const verdict = consume();
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.consumed.claimFencingToken, FENCE);
  assert.equal(verdict.consumed.workItemId, "wi-1");
  assert.equal(verdict.consumed.expectedTreeId, capability.expectedTreeId);
});

test("a capability is consumed once, only before it expires, only under its versions", () => {
  assert.deepEqual(consume({ consumedAt: NOW }), { allowed: false, reason: "already_consumed" });
  assert.deepEqual(consume({ now: capability.expiresAt }), { allowed: false, reason: "expired" });
  assert.deepEqual(consume({ currentVerifierVersion: 2 }), { allowed: false, reason: "verifier_changed" });
  assert.deepEqual(consume({ currentPolicyVersion: 2 }), { allowed: false, reason: "policy_changed" });
  assert.deepEqual(consume({ claimFencingToken: "short" }), { allowed: false, reason: "fencing_invalid" });
  assert.deepEqual(consume({ workItemId: "" }), { allowed: false, reason: "work_item_invalid" });
  assert.equal(
    consume({ consumedAt: NOW, now: new Date(capability.expiresAt.getTime() + 1) }).reason,
    "already_consumed",
    "once consumed, expiry no longer matters",
  );
});

const consumed = consume().consumed;
const look = (overrides = {}) =>
  decideLastLook({
    mode: "t1",
    frozen: false,
    killSwitch: false,
    amuxIncidentFrozen: false,
    halted: false,
    currentFencingToken: FENCE,
    presentedFencingToken: FENCE,
    consumed,
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
    [{ consumed: null }, "capability_not_consumed_by_this_claim"],
    [{ workItemId: "wi-2" }, "capability_not_consumed_by_this_claim"],
    [
      { consumed: { ...consumed, claimFencingToken: "c".repeat(32) } },
      "capability_not_consumed_by_this_claim",
    ],
  ];
  for (const [overrides, reason] of refusals) {
    assert.deepEqual(look(overrides), { verdict: "refuse", reason }, reason);
  }
});

test("the publisher pushes only the judged tree in exactly the bound commit", () => {
  const object = capabilityCommitObject(capability);
  assert.equal(publisherCommitMatches(capability, { treeId: "e".repeat(40), catFileOutput: object }), true);
  assert.equal(publisherCommitMatches(capability, { treeId: "f".repeat(40), catFileOutput: object }), false);
  assert.equal(
    publisherCommitMatches(capability, {
      treeId: "e".repeat(40),
      catFileOutput: object.replace("Card: cm1abc", "Card: other"),
    }),
    false,
  );
  assert.equal(
    publisherCommitMatches(capability, {
      treeId: "e".repeat(40),
      catFileOutput: object.replace("1759000000 +1000", "1759000001 +1000"),
    }),
    false,
  );
});

test("the branch is created only where none exists", () => {
  assert.equal(mayCreateBranch(null), true);
  assert.equal(mayCreateBranch("1".repeat(40)), false);
});

test("a difference seen after the push is an incident, never a block", () => {
  const object = capabilityCommitObject(capability);
  assert.equal(postPushObservation(capability, { branch: "agent/engineering/42", catFileOutput: object }), "consistent");
  for (const observed of [
    { branch: "agent/engineering/43", catFileOutput: object },
    { branch: "agent/engineering/42", catFileOutput: object.replace("e".repeat(40), "f".repeat(40)) },
    { branch: "agent/engineering/42", catFileOutput: object.replace("run 42", "run 43") },
    {
      branch: "agent/engineering/42",
      catFileOutput: object.replace(`parent ${"b".repeat(40)}\n`, `parent ${"b".repeat(40)}\nparent ${"c".repeat(40)}\n`),
    },
  ]) {
    assert.equal(postPushObservation(capability, observed), "incident");
  }
});

/* Lock order ---------------------------------------------------------- */

test("the cross lock order follows AMUX: attempt, work item, delivery, then engineering rows", () => {
  assert.deepEqual(CROSS_LOCK_ORDER.slice(0, 3), ["AmuxExecutionAttempt", "AmuxWorkItem", "AmuxWorkDelivery"]);
  assert.equal(followsCrossLockOrder(["AmuxExecutionAttempt", "AmuxWorkItem", "EngineeringAgentRun"]), true);
  assert.equal(followsCrossLockOrder(["AmuxWorkItem", "EngineeringAgentWorkItem"]), true, "a prefix may be skipped");
  assert.equal(followsCrossLockOrder(["AmuxWorkItem", "AmuxExecutionAttempt"]), false, "never backwards");
  assert.equal(followsCrossLockOrder(["EngineeringAgentRun", "AmuxWorkItem"]), false);
  assert.equal(followsCrossLockOrder(["AmuxWorkerRuntime"]), false, "the runtime row is not ours to lock");
});

/* Classification ------------------------------------------------------ */

test("every known outcome has an expected settlement, and an unknown one has none", () => {
  for (const outcome of RUN_OUTCOMES) assert.notEqual(expectedSettlement(outcome), null, outcome);
  assert.equal(expectedSettlement("abandoned"), "recovered");
  assert.equal(expectedSettlement("new_outcome_nobody_mapped"), null);
  assert.equal(expectedSettlement("constructor"), null);
});

test("the matrix maps every combination, and anything else is unmapped", () => {
  const inProgress = { state: "in_progress" };
  const cls = (amux, domain, domainTerminalSinceLastRound = true) =>
    classifyState({ amux, domain, domainTerminalSinceLastRound }).kind;
  const domainDone = { state: "terminal", outcome: "t2_draft" };
  assert.equal(cls(inProgress, inProgress), "consistent");
  assert.equal(cls({ state: "terminal", settlement: "review" }, inProgress), "A");
  assert.equal(cls(inProgress, domainDone, false), "consistent");
  assert.equal(cls(inProgress, domainDone, true), "B");
  assert.equal(cls({ state: "terminal", settlement: "review" }, domainDone), "consistent");
  assert.equal(cls({ state: "terminal", settlement: "retry" }, domainDone), "C");
  assert.equal(cls({ state: "terminal", settlement: "recovered" }, { state: "terminal", outcome: "abandoned" }), "consistent");
  assert.equal(cls({ state: "absent" }, inProgress), "D");
  assert.equal(cls({ state: "absent" }, domainDone), "unmapped");
  assert.equal(
    cls({ state: "terminal", settlement: "recovered" }, { state: "terminal", outcome: "new_outcome" }),
    "unmapped",
    "an outcome nobody mapped is never taken for settled",
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
    workItemTerminal: false,
    lookupVerifiedNoWrite: false,
    recurrences: 0,
    ...overrides,
  });

const terminalBoth = { runActive: false, runTerminal: true, workItemState: "published", workItemTerminal: true };

test("nothing acts on a state that changed since detection", () => {
  assert.deepEqual(action({ reReadMatchesDetection: false }), {
    allowed: false,
    reason: "state_changed_since_detection",
  });
});

test("each kind allows only its actions", () => {
  assert.equal(action({ kind: "B", action: "retry_lookup", ...terminalBoth }).allowed, false);
  assert.equal(action({ kind: "C", action: "mode_off", ...terminalBoth }).allowed, false);
  assert.equal(action({ kind: "D", action: "leave_open" }).allowed, false);
  assert.equal(action({ kind: "D", action: "mode_off" }).allowed, false);
});

test("B and C need both the run and the work item terminal", () => {
  for (const kind of ["B", "C"]) {
    assert.deepEqual(action({ kind, ...terminalBoth }), { allowed: true, resolves: false });
    for (const workItemState of ["queued", "claimed", "needs_lookup", "outcome_unknown"]) {
      assert.equal(
        action({ kind, ...terminalBoth, workItemState, workItemTerminal: false }).allowed,
        false,
        `${kind} with work item ${workItemState}`,
      );
    }
    assert.equal(action({ kind, ...terminalBoth, runTerminal: false }).allowed, false);
  }
});

test("closing the domain side requires a lookup that verified no write", () => {
  assert.deepEqual(action({ action: "close_domain_after_verified_no_write" }), {
    allowed: false,
    reason: "no_write_not_verified",
  });
  assert.deepEqual(action({ action: "close_domain_after_verified_no_write", lookupVerifiedNoWrite: true }), {
    allowed: true,
    resolves: true,
  });
});

test("leave_open, mode_off and a lookup never resolve anything", () => {
  assert.deepEqual(action({ action: "leave_open" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "mode_off" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "retry_lookup" }), { allowed: true, resolves: false });
  assert.deepEqual(action({ action: "escalate_incident" }), { allowed: true, resolves: true });
});

test("A and D preconditions hold", () => {
  assert.equal(action({ runActive: false, workItemState: "published" }).allowed, false);
  assert.equal(action({ runActive: false, workItemState: "needs_lookup" }).allowed, true);
  assert.equal(action({ kind: "D", action: "escalate_incident", runActive: false, workItemState: "queued" }).allowed, false);
});

test("after two recurrences only escalation is left", () => {
  assert.deepEqual(action({ recurrences: 2 }), { allowed: false, reason: "recurred_only_escalation_left" });
  assert.deepEqual(action({ recurrences: 2, action: "escalate_incident" }), { allowed: true, resolves: true });
});

test("B resolves only when AMUX concludes the same way; otherwise C; never guessed", () => {
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "review", domainOutcome: "t1_queued" }), "resolved");
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "review", domainOutcome: "private_result" }), "resolved");
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "blocked", domainOutcome: "t1_queued" }), "C");
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "recovered", domainOutcome: "abandoned" }), "resolved");
  assert.equal(resolveBOnAmuxTerminal({ amuxSettlement: "recovered", domainOutcome: "mystery" }), "unmapped");
});
