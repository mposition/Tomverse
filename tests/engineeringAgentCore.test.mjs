import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AMUX_SETTLEMENT_FOR_OUTCOME,
  OWNER_QUEUE_TOTAL,
  PUBLISH_STATES,
  PUBLISH_TERMINAL_STATES,
  PUBLISH_TRANSITIONS,
  REQUEST_TRANSITIONS,
  RUN_OUTCOMES,
  commitObjectMatches,
  decideArmedGate,
  decideHalt,
  decideOwnerQueues,
  decideWriteItemTransition,
  engineeringBranchName,
  expectedCommitObject,
  expireCommentMarker,
  isAllowedTransition,
  isCircuitLatched,
  parseEngineeringAgentMode,
  parseEngineeringBranchName,
  prBodyCarriesMarker,
  prBodyMarker,
  resolveEngineeringAgentSwitches,
  mayQueuePruneAfterFailedPublish,
  opensDecisionOnEntry,
  WRITE_ITEM_KINDS,
  writeItemStates,
  writeItemTerminalStates,
  writeItemTransitions,
  shouldSendSuccessHeartbeat,
  v22RunOutcomeForProduct,
} from "../lib/engineeringAgentCore.ts";

test("v22 run outcomes distinguish a private result, owner draft, and publish queue", () => {
  assert.equal(v22RunOutcomeForProduct({ taskOutcome: "succeeded",
    productKind: null }), "private_result");
  assert.equal(v22RunOutcomeForProduct({ taskOutcome: "succeeded",
    productKind: "t2_draft" }), "t2_draft");
  assert.equal(v22RunOutcomeForProduct({ taskOutcome: "succeeded",
    productKind: "publish" }), "t1_queued");
  assert.equal(v22RunOutcomeForProduct({ taskOutcome: "blocked",
    productKind: null }), "agent_failed");
  assert.throws(() => v22RunOutcomeForProduct({ taskOutcome: "failed",
    productKind: "publish" }), /without successful result/);
  assert.throws(() => v22RunOutcomeForProduct({ taskOutcome: "succeeded",
    productKind: "decision" }), /kind invalid/);
});

const at = (iso) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* Write items ---------------------------------------------------------- */

const writePreconditions = {
  publish: { kind: "publish", capabilityConsumed: true },
  expire_close: { kind: "expire_close", bindingMatches: true, stillExpired: true },
  prune: { kind: "prune", refMatchesRecorded: true, prClosedOrConfirmedAbsent: true },
};

const terminalsOf = (kind) => {
  const [success, refused, failed] = writeItemTerminalStates(kind).filter((s) => s !== "expired");
  return { success, refused, failed };
};

test("no write item leaves a terminal state, and every pair uses the kind's own states", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    const states = writeItemStates(kind);
    const terminals = writeItemTerminalStates(kind);
    for (const [from, to] of writeItemTransitions(kind)) {
      assert.ok(!terminals.includes(from), `${kind}: ${from} is terminal`);
      assert.ok(states.includes(from) && states.includes(to), `${kind}: ${from}->${to}`);
    }
  }
  assert.deepEqual(PUBLISH_STATES, writeItemStates("publish"));
  assert.deepEqual(PUBLISH_TERMINAL_STATES, writeItemTerminalStates("publish"));
  assert.deepEqual(PUBLISH_TRANSITIONS, writeItemTransitions("publish"));
});

test("a pair outside a kind's table is refused whatever the event says", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    const states = writeItemStates(kind);
    for (const from of states) {
      for (const to of states) {
        if (writeItemTransitions(kind).some(([a, b]) => a === from && b === to)) continue;
        const verdict = decideWriteItemTransition(kind, from, to, {
          event: "claim",
          mode: "write",
          precondition: writePreconditions[kind],
        });
        assert.deepEqual(verdict, { allowed: false, reason: "transition_not_in_table" });
      }
    }
  }
});

test("every pair in every table is reachable by some legitimate event", () => {
  const outcomes = [
    "confirmed",
    "refused_before_write",
    "revalidation_refused",
    "write_rejected",
    "pr_create_rejected",
    "lookup_no_prior_write",
    "lookup_found_result",
    "lookup_impossible",
  ];
  for (const kind of WRITE_ITEM_KINDS) {
    const contexts = [
      { event: "claim", mode: "write", precondition: writePreconditions[kind] },
      { event: "claim", mode: "lookup", capabilityConsumed: false },
      { event: "expire_ttl" },
      { event: "lease_expired" },
      ...["write", "lookup"].flatMap((claimMode) =>
        [false, true].flatMap((capabilityConsumed) =>
          outcomes.map((outcome) => ({
            event: "result",
            claimMode,
            outcome,
            fencingMatches: true,
            capabilityConsumed,
          })),
        ),
      ),
    ];
    for (const [from, to] of writeItemTransitions(kind)) {
      assert.ok(
        contexts.some((context) => decideWriteItemTransition(kind, from, to, context).allowed),
        `${kind}: ${from}->${to} is in the table but nothing can take it`,
      );
    }
  }
});

test("a write claim rests on its kind's precondition and starts only from queued", () => {
  const refusedPreconditions = {
    publish: [{ kind: "publish", capabilityConsumed: false }],
    expire_close: [
      { kind: "expire_close", bindingMatches: false, stillExpired: true },
      { kind: "expire_close", bindingMatches: true, stillExpired: false },
    ],
    prune: [
      { kind: "prune", refMatchesRecorded: false, prClosedOrConfirmedAbsent: true },
      { kind: "prune", refMatchesRecorded: true, prClosedOrConfirmedAbsent: false },
    ],
  };
  for (const kind of WRITE_ITEM_KINDS) {
    assert.deepEqual(
      decideWriteItemTransition(kind, "queued", "claimed", {
        event: "claim",
        mode: "write",
        precondition: writePreconditions[kind],
      }),
      { allowed: true },
      kind,
    );
    for (const precondition of refusedPreconditions[kind]) {
      assert.equal(
        decideWriteItemTransition(kind, "queued", "claimed", {
          event: "claim",
          mode: "write",
          precondition,
        }).allowed,
        false,
        `${kind}: ${JSON.stringify(precondition)}`,
      );
    }
    const other = WRITE_ITEM_KINDS.find((candidate) => candidate !== kind);
    assert.equal(
      decideWriteItemTransition(kind, "queued", "claimed", {
        event: "claim",
        mode: "write",
        precondition: writePreconditions[other],
      }).allowed,
      false,
      `${kind} must not accept a ${other} precondition`,
    );
    for (const from of ["needs_lookup", "outcome_unknown"]) {
      assert.equal(
        decideWriteItemTransition(kind, from, "claimed", {
          event: "claim",
          mode: "write",
          precondition: writePreconditions[kind],
        }).allowed,
        false,
        `${kind}: ${from} must not be write-claimed`,
      );
    }
  }
});

test("a lookup claim never consumes a capability and only follows an unknown outcome", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    for (const from of ["needs_lookup", "outcome_unknown"]) {
      assert.deepEqual(
        decideWriteItemTransition(kind, from, "claimed", {
          event: "claim",
          mode: "lookup",
          capabilityConsumed: false,
        }),
        { allowed: true },
      );
      assert.equal(
        decideWriteItemTransition(kind, from, "claimed", {
          event: "claim",
          mode: "lookup",
          capabilityConsumed: true,
        }).allowed,
        false,
      );
    }
    assert.equal(
      decideWriteItemTransition(kind, "queued", "claimed", {
        event: "claim",
        mode: "lookup",
        capabilityConsumed: false,
      }).allowed,
      false,
    );
  }
});

test("a lease expiry never returns a write item to queued", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    assert.equal(
      decideWriteItemTransition(kind, "claimed", "queued", { event: "lease_expired" }).allowed,
      false,
    );
    assert.deepEqual(
      decideWriteItemTransition(kind, "claimed", "needs_lookup", { event: "lease_expired" }),
      { allowed: true },
    );
  }
});

test("claimed -> queued rests only on a refusal before writing or a proven absence", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    const result = (claimMode, outcome, fencingMatches = true) =>
      decideWriteItemTransition(kind, "claimed", "queued", {
        event: "result",
        claimMode,
        outcome,
        fencingMatches,
        capabilityConsumed: false,
      }).allowed;
    assert.equal(result("write", "refused_before_write"), true);
    assert.equal(result("lookup", "lookup_no_prior_write"), true);
    assert.equal(result("write", "lookup_no_prior_write"), false);
    assert.equal(result("lookup", "refused_before_write"), false);
    assert.equal(result("write", "refused_before_write", false), false);
  }
});

test("proven unwritten work returns to the queue whatever was consumed, and nothing publishes without a consumption", () => {
  const publish = (to, claimMode, outcome, capabilityConsumed) =>
    decideWriteItemTransition("publish", "claimed", to, {
      event: "result",
      claimMode,
      outcome,
      fencingMatches: true,
      capabilityConsumed,
    }).allowed;
  // Refused before writing, or proven not written: the work returns to the
  // queue (docs/policy/engineering-agent.md §10). The consumed capability stays consumed; the next write claim
  // is judged again under a new one. It never ends as a refusal.
  assert.equal(publish("queued", "write", "refused_before_write", true), true);
  assert.equal(publish("publish_refused", "write", "refused_before_write", true), false);
  assert.equal(publish("queued", "lookup", "lookup_no_prior_write", true), true);
  assert.equal(publish("publish_refused", "lookup", "lookup_no_prior_write", true), false);
  assert.equal(publish("queued", "write", "refused_before_write", false), true);
  assert.equal(publish("queued", "lookup", "lookup_no_prior_write", false), true);
  // A publish, by the write or by the lookup that finds it, rests on consumption.
  assert.equal(publish("published", "write", "confirmed", false), false);
  assert.equal(publish("published", "lookup", "lookup_found_result", false), false);
  assert.equal(publish("published", "lookup", "lookup_found_result", true), true);
  // The maintenance kinds have no capability to report.
  for (const kind of ["expire_close", "prune"]) {
    assert.deepEqual(
      decideWriteItemTransition(kind, "claimed", "queued", {
        event: "result",
        claimMode: "write",
        outcome: "refused_before_write",
        fencingMatches: true,
        capabilityConsumed: true,
      }),
      { allowed: false, reason: "only_a_publish_item_has_a_capability" },
    );
  }
});

test("every result needs the claim's fencing token", () => {
  for (const kind of WRITE_ITEM_KINDS) {
    assert.deepEqual(
      decideWriteItemTransition(kind, "claimed", terminalsOf(kind).success, {
        event: "result",
        claimMode: "write",
        outcome: "confirmed",
        fencingMatches: false,
        capabilityConsumed: kind === "publish",
      }),
      { allowed: false, reason: "stale_fencing_token" },
    );
  }
});

test("each write's five paths lead to exactly one state", () => {
  const expected = {
    publish: [
      ["write", "confirmed", "published"],
      ["write", "revalidation_refused", "publish_refused"],
      ["write", "write_rejected", "publish_refused"],
      ["write", "pr_create_rejected", "publish_failed"],
      ["write", "lookup_impossible", "outcome_unknown"],
      ["lookup", "lookup_found_result", "published"],
      ["lookup", "lookup_no_prior_write", "queued"],
      ["lookup", "lookup_impossible", "outcome_unknown"],
    ],
    expire_close: [
      ["write", "confirmed", "closed"],
      ["write", "revalidation_refused", "expire_refused"],
      ["write", "write_rejected", "expire_failed"],
      ["write", "lookup_impossible", "outcome_unknown"],
      ["lookup", "lookup_found_result", "closed"],
      ["lookup", "lookup_no_prior_write", "queued"],
      ["lookup", "lookup_impossible", "outcome_unknown"],
    ],
    prune: [
      ["write", "confirmed", "pruned"],
      ["write", "revalidation_refused", "prune_refused"],
      ["write", "write_rejected", "prune_failed"],
      ["write", "lookup_impossible", "outcome_unknown"],
      ["lookup", "lookup_found_result", "pruned"],
      ["lookup", "lookup_no_prior_write", "queued"],
      ["lookup", "lookup_impossible", "outcome_unknown"],
    ],
  };
  for (const kind of WRITE_ITEM_KINDS) {
    for (const [claimMode, outcome, target] of expected[kind]) {
      for (const to of writeItemStates(kind)) {
        const verdict = decideWriteItemTransition(kind, "claimed", to, {
          event: "result",
          claimMode,
          outcome,
          fencingMatches: true,
          // A publish claim has consumed its capability unless it is
          // reporting that nothing was written.
          capabilityConsumed: kind === "publish" && target !== "queued",
        });
        assert.equal(verdict.allowed, to === target, `${kind} ${claimMode}/${outcome} -> ${to}`);
      }
    }
  }
  for (const kind of ["expire_close", "prune"]) {
    for (const to of writeItemStates(kind)) {
      assert.equal(
        decideWriteItemTransition(kind, "claimed", to, {
          event: "result",
          claimMode: "write",
          outcome: "pr_create_rejected",
          fencingMatches: true,
          capabilityConsumed: false,
        }).allowed,
        false,
        `${kind} has no PR creation`,
      );
    }
  }
  assert.equal(
    decideWriteItemTransition("publish", "claimed", "published", {
      event: "result",
      claimMode: "lookup",
      outcome: "confirmed",
      fencingMatches: true,
      capabilityConsumed: true,
    }).allowed,
    false,
    "a lookup claim cannot report a write it did not make",
  );
});

test("only an unclaimed publish item expires by TTL", () => {
  assert.deepEqual(
    decideWriteItemTransition("publish", "queued", "expired", { event: "expire_ttl" }),
    { allowed: true },
  );
  assert.ok(!writeItemStates("prune").includes("expired"));
  assert.ok(!writeItemStates("expire_close").includes("expired"));
});

test("an unknown outcome goes to a person the moment it is entered", () => {
  assert.equal(opensDecisionOnEntry("outcome_unknown"), true);
  assert.equal(opensDecisionOnEntry("needs_lookup"), false);
});

test("a branch left by a rejected PR creation is pruned only after a full list found no PR", () => {
  assert.equal(mayQueuePruneAfterFailedPublish({ listReadToEnd: true, pullRequestsForHead: 0 }), true);
  assert.equal(mayQueuePruneAfterFailedPublish({ listReadToEnd: false, pullRequestsForHead: 0 }), false);
  assert.equal(mayQueuePruneAfterFailedPublish({ listReadToEnd: true, pullRequestsForHead: 1 }), false);
});

test("request idempotency never leaves in_progress on its own", () => {
  assert.equal(isAllowedTransition(REQUEST_TRANSITIONS, "in_progress", "committed"), true);
  assert.equal(isAllowedTransition(REQUEST_TRANSITIONS, "committed", "in_progress"), false);
  assert.equal(isAllowedTransition(REQUEST_TRANSITIONS, "aborted", "accepted"), false);
});

test("every run outcome has a settlement decision", () => {
  for (const outcome of RUN_OUTCOMES) {
    assert.ok(Object.hasOwn(AMUX_SETTLEMENT_FOR_OUTCOME, outcome), outcome);
  }
  assert.equal(AMUX_SETTLEMENT_FOR_OUTCOME.agent_failed, "retry");
  assert.equal(AMUX_SETTLEMENT_FOR_OUTCOME.abandoned, null);
});

/* Mode and switches ---------------------------------------------------- */

test("unset, unknown and unreadable mode is off", () => {
  assert.equal(parseEngineeringAgentMode(undefined), "off");
  assert.equal(parseEngineeringAgentMode("T1"), "off");
  assert.equal(parseEngineeringAgentMode("t1 "), "off");
  assert.equal(parseEngineeringAgentMode("shadow"), "shadow");

  const reading = {
    mode: "t1",
    freeze: "false",
    registration: "on",
    killSwitch: "",
    readFailed: true,
  };
  const effective = resolveEngineeringAgentSwitches(reading);
  assert.equal(effective.mode, "off");
  assert.equal(effective.claimAllowed, false);
  assert.equal(effective.registrationAllowed, false);
  assert.equal(effective.maintenanceAllowed, false);
});

test("the kill switch turns everything off unless it is plainly empty or false", () => {
  const base = { mode: "t1", freeze: "false", registration: "on", readFailed: false };
  for (const killSwitch of ["1", "true", "yes", "anything"]) {
    assert.equal(resolveEngineeringAgentSwitches({ ...base, killSwitch }).mode, "off");
  }
  for (const killSwitch of [undefined, null, "", "0", "false", "FALSE"]) {
    assert.equal(resolveEngineeringAgentSwitches({ ...base, killSwitch }).mode, "t1");
  }
});

test("shadow claims but never publishes; a freeze stops claims and publishing, not maintenance", () => {
  const shadow = resolveEngineeringAgentSwitches({
    mode: "shadow",
    freeze: "false",
    registration: "off",
    killSwitch: "",
    readFailed: false,
  });
  assert.equal(shadow.claimAllowed, true);
  assert.equal(shadow.publishAllowed, false);
  assert.equal(shadow.registrationAllowed, false);

  const frozen = resolveEngineeringAgentSwitches({
    mode: "t1",
    freeze: "true",
    registration: "on",
    killSwitch: "",
    readFailed: false,
  });
  assert.equal(frozen.claimAllowed, false);
  assert.equal(frozen.publishAllowed, false);
  assert.equal(frozen.registrationAllowed, false);
  assert.equal(frozen.maintenanceAllowed, true);
});

/* Owner queues --------------------------------------------------------- */

test("the owner queue total is five", () => {
  assert.equal(OWNER_QUEUE_TOTAL, 5);
});

test("either full queue stops the claim, and the first T1 fortnight allows one PR", () => {
  const now = at("2026-10-20T00:00:00Z");
  assert.equal(
    decideOwnerQueues({ openPrBindings: 1, pendingDecisions: 0, t1StartedAt: null, now })
      .claimAllowed,
    true,
  );
  assert.equal(
    decideOwnerQueues({
      openPrBindings: 1,
      pendingDecisions: 0,
      t1StartedAt: new Date(now.getTime() - 3 * DAY),
      now,
    }).claimAllowed,
    false,
  );
  assert.equal(
    decideOwnerQueues({
      openPrBindings: 1,
      pendingDecisions: 0,
      t1StartedAt: new Date(now.getTime() - 14 * DAY),
      now,
    }).claimAllowed,
    true,
  );
  assert.equal(
    decideOwnerQueues({ openPrBindings: 0, pendingDecisions: 3, t1StartedAt: null, now })
      .claimAllowed,
    false,
  );
});

/* Halt and circuit ----------------------------------------------------- */

test("halt follows the policy priority and a missing App identity is never none", () => {
  const clear = {
    appIdentityConfigured: true,
    circuitLatched: false,
    unboundAppPrs: 0,
    unboundAppRefs: 0,
    openStateMismatches: 0,
  };
  assert.equal(decideHalt(clear), "none");
  assert.equal(decideHalt({ ...clear, appIdentityConfigured: false }), "config_missing");
  assert.equal(
    decideHalt({ ...clear, circuitLatched: true, unboundAppPrs: 2, unboundAppRefs: 1 }),
    "circuit_open",
  );
  assert.equal(decideHalt({ ...clear, unboundAppPrs: 1, unboundAppRefs: 1 }), "unbound_app_pr");
  assert.equal(decideHalt({ ...clear, unboundAppRefs: 1 }), "unbound_app_ref");
  assert.equal(decideHalt({ ...clear, openStateMismatches: 1 }), "state_mismatch");
});

const NOW = at("2026-11-01T00:00:00Z");
const run = (day, halt) => {
  const end = new Date(NOW.getTime() - day * DAY);
  return { startedAt: new Date(end.getTime() - HOUR), endedAt: end, halt };
};

test("one long halt is one incident; three separate incidents latch", () => {
  const longHalt = [
    run(10, "none"),
    run(9, "unbound_app_pr"),
    run(8, "unbound_app_pr"),
    run(7, "unbound_app_pr"),
    run(6, "unbound_app_pr"),
  ];
  assert.equal(isCircuitLatched({ runs: longHalt, acknowledgedAt: null }), false);

  const three = [
    run(10, "unbound_app_ref"),
    run(9, "none"),
    run(8, "state_mismatch"),
    run(7, "none"),
    run(6, "unbound_app_pr"),
    run(5, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: three, acknowledgedAt: null }), true);
});

test("a latch does not wear off with time -- only an acknowledgement clears it", () => {
  const latchedLongAgo = [
    run(400, "unbound_app_ref"),
    run(399, "none"),
    run(398, "state_mismatch"),
    run(397, "none"),
    run(396, "unbound_app_pr"),
    ...Array.from({ length: 30 }, (_, i) => run(300 - i * 10, "none")),
  ];
  assert.equal(isCircuitLatched({ runs: latchedLongAgo, acknowledgedAt: null }), true);
  assert.equal(
    isCircuitLatched({
      runs: latchedLongAgo,
      acknowledgedAt: new Date(NOW.getTime() - 395 * DAY),
    }),
    false,
    "an acknowledgement after the incidents clears them",
  );
});

test("three incidents spread wider than thirty days do not latch", () => {
  const spread = [
    run(90, "unbound_app_ref"),
    run(89, "none"),
    run(50, "state_mismatch"),
    run(49, "none"),
    run(10, "unbound_app_pr"),
    run(9, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: spread, acknowledgedAt: null }), false);
  const closeTogether = [
    run(40, "unbound_app_ref"),
    run(39.5, "none"),
    run(30, "state_mismatch"),
    run(29, "none"),
    run(11, "unbound_app_pr"),
    run(10, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: closeTogether, acknowledgedAt: null }), true);
});

test("incidents that started before the acknowledgement do not count", () => {
  const recent = [
    run(9, "unbound_app_ref"),
    run(8.5, "none"),
    run(8, "state_mismatch"),
    run(7, "none"),
    run(6, "unbound_app_pr"),
    run(5, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: recent, acknowledgedAt: null }), true);
  assert.equal(
    isCircuitLatched({ runs: recent, acknowledgedAt: new Date(NOW.getTime() - 8.2 * DAY) }),
    false,
  );
});

test("a latest run already circuit_open stays latched", () => {
  assert.equal(
    isCircuitLatched({ runs: [run(1, "none"), run(0.5, "circuit_open")], acknowledgedAt: null }),
    true,
  );
});

test("no success heartbeat while halted", () => {
  assert.equal(shouldSendSuccessHeartbeat({ finishedNormally: true, halt: "none" }), true);
  assert.equal(
    shouldSendSuccessHeartbeat({ finishedNormally: true, halt: "unbound_app_ref" }),
    false,
  );
  assert.equal(shouldSendSuccessHeartbeat({ finishedNormally: false, halt: "none" }), false);
});

/* Armed gate ----------------------------------------------------------- */

test("the armed gate names every missing condition", () => {
  const now = at("2026-11-01T00:00:00Z");
  assert.deepEqual(
    decideArmedGate({
      runnerLastFinishAt: new Date(now.getTime() - 25 * HOUR),
      publisherLastFinishAt: new Date(now.getTime() - 27 * HOUR),
      monitorsConfirmedAt: null,
      now,
    }),
    { armed: false, missing: ["publisher_finish", "monitor_confirmation"] },
  );
  assert.deepEqual(
    decideArmedGate({
      runnerLastFinishAt: new Date(now.getTime() - HOUR),
      publisherLastFinishAt: new Date(now.getTime() - HOUR),
      monitorsConfirmedAt: new Date(now.getTime() - 6 * DAY),
      now,
    }),
    { armed: true },
  );
  assert.equal(
    decideArmedGate({
      runnerLastFinishAt: new Date(now.getTime() + HOUR),
      publisherLastFinishAt: new Date(now.getTime() - HOUR),
      monitorsConfirmedAt: new Date(now.getTime() - DAY),
      now,
    }).armed,
    false,
    "a finish time in the future is not recent",
  );
});

/* Publisher writes ----------------------------------------------------- */

test("branch names are exactly agent/engineering/<runId> and never carry to-develop", () => {
  assert.equal(engineeringBranchName("42"), "agent/engineering/42");
  assert.throws(() => engineeringBranchName("to-develop"));
  assert.throws(() => engineeringBranchName("1/2"));
  assert.throws(() => engineeringBranchName("1234567890123"));
  assert.equal(parseEngineeringBranchName("refs/heads/agent/engineering/42"), "42");
  assert.equal(parseEngineeringBranchName("agent/engineering/42/x"), null);
  assert.equal(parseEngineeringBranchName("agent/engineering/to-develop/1"), null);
  assert.equal(parseEngineeringBranchName("agent/review/42"), null);
});

test("markers are exact and the PR body must open with its own", () => {
  assert.equal(prBodyMarker("7"), "<!-- engineering-agent run=7 -->");
  assert.equal(expireCommentMarker("7", 12), "<!-- engineering-agent expire run=7 pr=12 -->");
  assert.throws(() => expireCommentMarker("7", 0));
  assert.equal(prBodyCarriesMarker("<!-- engineering-agent run=7 -->\nbody", "7"), true);
  assert.equal(prBodyCarriesMarker("<!-- engineering-agent run=70 -->\nbody", "7"), false);
  assert.equal(prBodyCarriesMarker(" <!-- engineering-agent run=7 -->", "7"), false);
});

const expected = {
  tree: "a".repeat(40),
  baseSha: "b".repeat(40),
  identity: { name: "Tomverse Engineering Agent", email: "engineering-agent@users.noreply.github.com" },
  baseCommitterDate: "1759000000 +1000",
  runId: "42",
  cardRef: "cm1abc_def-2",
};

test("the commit object is fixed field by field", () => {
  const object = expectedCommitObject(expected);
  assert.equal(
    object,
    [
      `tree ${"a".repeat(40)}`,
      `parent ${"b".repeat(40)}`,
      "author Tomverse Engineering Agent <engineering-agent@users.noreply.github.com> 1759000000 +1000",
      "committer Tomverse Engineering Agent <engineering-agent@users.noreply.github.com> 1759000000 +1000",
      "",
      "engineering-agent: run 42",
      "",
      "Card: cm1abc_def-2",
      "",
    ].join("\n"),
  );
  assert.equal(commitObjectMatches(object, expected), true);
});

test("a signature, a second parent or any extra header is a mismatch", () => {
  const object = expectedCommitObject(expected);
  const signed = object.replace("\n\nengineering", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n\nengineering");
  assert.equal(commitObjectMatches(signed, expected), false);
  const twoParents = object.replace(
    `parent ${"b".repeat(40)}\n`,
    `parent ${"b".repeat(40)}\nparent ${"c".repeat(40)}\n`,
  );
  assert.equal(commitObjectMatches(twoParents, expected), false);
  assert.equal(commitObjectMatches(object.replace("Card:", "Card :"), expected), false);
});

test("encoding, mergetag, CRLF and a trailing newline are all mismatches", () => {
  const object = expectedCommitObject(expected);
  const variants = {
    encoding: object.replace("\n\nengineering", "\nencoding ISO-8859-1\n\nengineering"),
    mergetag: object.replace("\n\nengineering", "\nmergetag object " + "d".repeat(40) + "\n\nengineering"),
    crlf: object.replace(/\n/g, "\r\n"),
    extraNewline: `${object}\n`,
    missingNewline: object.slice(0, -1),
    leadingSpace: ` ${object}`,
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.equal(commitObjectMatches(variant, expected), false, name);
  }
});

test("git itself prints the expected object back unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-agent-commit-"));
  try {
    const git = (args, input) =>
      execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
        cwd: dir,
        input,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
      });
    git(["init", "-q"]);
    const object = expectedCommitObject(expected);
    const id = git(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], object).trim();
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.equal(git(["cat-file", "-p", id]), object);
    assert.equal(commitObjectMatches(git(["cat-file", "-p", id]), expected), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identity parts carrying CR, NUL or angle brackets are refused", () => {
  for (const name of ["x\r", "x\u0000", "a<b", "a>b"]) {
    assert.throws(() => expectedCommitObject({ ...expected, identity: { name, email: "e" } }), JSON.stringify(name));
    assert.throws(() => expectedCommitObject({ ...expected, identity: { name: "n", email: name } }), JSON.stringify(name));
  }
});

test("commit inputs that could smuggle a header are refused", () => {
  assert.throws(() =>
    expectedCommitObject({ ...expected, identity: { name: "x\nparent y", email: "e" } }),
  );
  assert.throws(() => expectedCommitObject({ ...expected, identity: { name: "x", email: "a>b" } }));
  assert.throws(() => expectedCommitObject({ ...expected, cardRef: "card\nx" }));
  assert.throws(() => expectedCommitObject({ ...expected, baseCommitterDate: "now" }));
  assert.throws(() => expectedCommitObject({ ...expected, tree: "A".repeat(40) }));
});
