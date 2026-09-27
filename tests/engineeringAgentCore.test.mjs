import assert from "node:assert/strict";
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
  decidePublishTransition,
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
  shouldEscalateOutcomeUnknown,
  shouldSendSuccessHeartbeat,
} from "../lib/engineeringAgentCore.ts";

const at = (iso) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* Publish transitions -------------------------------------------------- */

test("the publish table has no transition out of a terminal state", () => {
  for (const [from] of PUBLISH_TRANSITIONS) {
    assert.ok(!PUBLISH_TERMINAL_STATES.includes(from), `${from} is terminal`);
  }
  for (const [from, to] of PUBLISH_TRANSITIONS) {
    assert.ok(PUBLISH_STATES.includes(from) && PUBLISH_STATES.includes(to));
  }
});

test("a pair outside the table is refused whatever the event says", () => {
  for (const from of PUBLISH_STATES) {
    for (const to of PUBLISH_STATES) {
      if (PUBLISH_TRANSITIONS.some(([a, b]) => a === from && b === to)) continue;
      const verdict = decidePublishTransition(from, to, {
        event: "claim",
        mode: "write",
        capabilityConsumed: true,
      });
      assert.deepEqual(verdict, { allowed: false, reason: "transition_not_in_table" });
    }
  }
});

test("a write claim consumes a capability and starts only from queued", () => {
  assert.deepEqual(
    decidePublishTransition("queued", "claimed", {
      event: "claim",
      mode: "write",
      capabilityConsumed: true,
    }),
    { allowed: true },
  );
  assert.equal(
    decidePublishTransition("queued", "claimed", {
      event: "claim",
      mode: "write",
      capabilityConsumed: false,
    }).allowed,
    false,
  );
  for (const from of ["needs_lookup", "outcome_unknown"]) {
    assert.equal(
      decidePublishTransition(from, "claimed", {
        event: "claim",
        mode: "write",
        capabilityConsumed: true,
      }).allowed,
      false,
      `${from} must not be write-claimed`,
    );
  }
});

test("a lookup claim never consumes a capability and only follows an unknown outcome", () => {
  for (const from of ["needs_lookup", "outcome_unknown"]) {
    assert.deepEqual(
      decidePublishTransition(from, "claimed", {
        event: "claim",
        mode: "lookup",
        capabilityConsumed: false,
      }),
      { allowed: true },
    );
    assert.equal(
      decidePublishTransition(from, "claimed", {
        event: "claim",
        mode: "lookup",
        capabilityConsumed: true,
      }).allowed,
      false,
    );
  }
  assert.equal(
    decidePublishTransition("queued", "claimed", {
      event: "claim",
      mode: "lookup",
      capabilityConsumed: false,
    }).allowed,
    false,
  );
});

test("a lease expiry never returns an item to queued", () => {
  assert.equal(
    decidePublishTransition("claimed", "queued", { event: "lease_expired" }).allowed,
    false,
  );
  assert.deepEqual(
    decidePublishTransition("claimed", "needs_lookup", { event: "lease_expired" }),
    { allowed: true },
  );
});

test("claimed -> queued rests only on a refusal before writing or a proven absence", () => {
  const result = (claimMode, outcome, fencingMatches = true) =>
    decidePublishTransition("claimed", "queued", {
      event: "result",
      claimMode,
      outcome,
      fencingMatches,
    }).allowed;

  assert.equal(result("write", "refused_before_write"), true);
  assert.equal(result("lookup", "lookup_no_prior_write"), true);
  assert.equal(result("write", "lookup_no_prior_write"), false);
  assert.equal(result("lookup", "refused_before_write"), false);
  assert.equal(result("write", "refused_before_write", false), false);
});

test("every result needs the claim's fencing token", () => {
  assert.deepEqual(
    decidePublishTransition("claimed", "published", {
      event: "result",
      claimMode: "write",
      outcome: "pr_confirmed",
      fencingMatches: false,
    }),
    { allowed: false, reason: "stale_fencing_token" },
  );
});

test("results map to exactly one target per claim mode", () => {
  const cases = [
    ["write", "pr_confirmed", "published"],
    ["write", "revalidation_refused", "publish_refused"],
    ["write", "push_rejected", "publish_refused"],
    ["write", "pr_create_rejected", "publish_failed"],
    ["write", "lookup_impossible", "outcome_unknown"],
    ["lookup", "lookup_found_pr", "published"],
    ["lookup", "lookup_impossible", "outcome_unknown"],
  ];
  for (const [claimMode, outcome, target] of cases) {
    for (const to of PUBLISH_STATES) {
      const verdict = decidePublishTransition("claimed", to, {
        event: "result",
        claimMode,
        outcome,
        fencingMatches: true,
      });
      assert.equal(verdict.allowed, to === target, `${claimMode}/${outcome} -> ${to}`);
    }
  }
  assert.equal(
    decidePublishTransition("claimed", "published", {
      event: "result",
      claimMode: "lookup",
      outcome: "pr_confirmed",
      fencingMatches: true,
    }).allowed,
    false,
    "a lookup claim cannot report a write it did not make",
  );
});

test("TTL expiry applies only to queued items", () => {
  assert.deepEqual(decidePublishTransition("queued", "expired", { event: "expire_ttl" }), {
    allowed: true,
  });
});

test("an unknown outcome goes to a person after three failed lookups", () => {
  assert.equal(shouldEscalateOutcomeUnknown(2), false);
  assert.equal(shouldEscalateOutcomeUnknown(3), true);
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

const run = (day, halt, now = at("2026-11-01T00:00:00Z")) => {
  const end = new Date(now.getTime() - day * DAY);
  return { startedAt: new Date(end.getTime() - HOUR), endedAt: end, halt };
};

test("one long halt is one incident; three separate incidents latch", () => {
  const now = at("2026-11-01T00:00:00Z");
  const longHalt = [
    run(10, "none"),
    run(9, "unbound_app_pr"),
    run(8, "unbound_app_pr"),
    run(7, "unbound_app_pr"),
    run(6, "unbound_app_pr"),
  ];
  assert.equal(isCircuitLatched({ runs: longHalt, acknowledgedAt: null, now }), false);

  const three = [
    run(10, "unbound_app_ref"),
    run(9, "none"),
    run(8, "state_mismatch"),
    run(7, "none"),
    run(6, "unbound_app_pr"),
    run(5, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: three, acknowledgedAt: null, now }), true);
});

test("incidents older than thirty days or before the acknowledgement do not count", () => {
  const now = at("2026-11-01T00:00:00Z");
  const runs = [
    run(40, "unbound_app_ref"),
    run(39, "none"),
    run(8, "state_mismatch"),
    run(7, "none"),
    run(6, "unbound_app_pr"),
    run(5, "none"),
  ];
  assert.equal(isCircuitLatched({ runs, acknowledgedAt: null, now }), false);

  const recent = [
    run(9, "unbound_app_ref"),
    run(8.5, "none"),
    run(8, "state_mismatch"),
    run(7, "none"),
    run(6, "unbound_app_pr"),
    run(5, "none"),
  ];
  assert.equal(isCircuitLatched({ runs: recent, acknowledgedAt: null, now }), true);
  assert.equal(
    isCircuitLatched({
      runs: recent,
      acknowledgedAt: new Date(now.getTime() - 8.2 * DAY),
      now,
    }),
    false,
  );
});

test("a latest run already circuit_open stays latched", () => {
  const now = at("2026-11-01T00:00:00Z");
  assert.equal(
    isCircuitLatched({ runs: [run(1, "none"), run(0.5, "circuit_open")], acknowledgedAt: null, now }),
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

test("commit inputs that could smuggle a header are refused", () => {
  assert.throws(() =>
    expectedCommitObject({ ...expected, identity: { name: "x\nparent y", email: "e" } }),
  );
  assert.throws(() => expectedCommitObject({ ...expected, identity: { name: "x", email: "a>b" } }));
  assert.throws(() => expectedCommitObject({ ...expected, cardRef: "card\nx" }));
  assert.throws(() => expectedCommitObject({ ...expected, baseCommitterDate: "now" }));
  assert.throws(() => expectedCommitObject({ ...expected, tree: "A".repeat(40) }));
});
