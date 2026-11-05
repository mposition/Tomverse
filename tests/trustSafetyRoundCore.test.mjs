import assert from "node:assert/strict";
import test from "node:test";

import { ROUTE_BUDGET_MS, TRUST_SAFETY_BOUNDS } from "../lib/trustSafetyBoundsCore.ts";
import { activationVerdict, budgetAllowsBatch } from "../lib/trustSafetyRoundCore.ts";

/**
 * The round's two judgements (docs/policy/trust-safety-compliance-agent.md
 * §5.5 and §6), checked without a database.
 */

const KINDS = ["activation_read", "dsr_read", "run_write"];

test("a batch starts only with its whole guarded budget left", () => {
  // §5.5: not starting is the point -- no row, no ping. The boundary is
  // inclusive, so a batch with exactly its budget left still runs.
  for (const kind of KINDS) {
    const guarded = TRUST_SAFETY_BOUNDS[kind].cGuardedMs;
    const exactly = ROUTE_BUDGET_MS - guarded;
    assert.equal(
      budgetAllowsBatch({ kind, elapsedMs: exactly, budgetMs: ROUTE_BUDGET_MS }),
      true,
      `${kind} at exactly its budget`,
    );
    assert.equal(
      budgetAllowsBatch({ kind, elapsedMs: exactly + 1, budgetMs: ROUTE_BUDGET_MS }),
      false,
      `${kind} one millisecond short`,
    );
  }
});

test("the three batches fit the route budget together", () => {
  // Each kind is checked against what is left, so the round can only reach the
  // run write if the two reads left room for it.
  let elapsed = 0;
  for (const kind of KINDS) {
    assert.equal(
      budgetAllowsBatch({ kind, elapsedMs: elapsed, budgetMs: ROUTE_BUDGET_MS }),
      true,
      `${kind} fits after ${elapsed}ms`,
    );
    elapsed += TRUST_SAFETY_BOUNDS[kind].cGuardedMs;
  }
  assert.ok(elapsed < ROUTE_BUDGET_MS, "and the ping's share is still left over");
});

test("an unreadable or backwards elapsed time refuses the batch", () => {
  for (const elapsedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      budgetAllowsBatch({ kind: "run_write", elapsedMs, budgetMs: ROUTE_BUDGET_MS }),
      false,
      `elapsed ${String(elapsedMs)}`,
    );
  }
});

const state = (over) => ({
  mode: null,
  fault: null,
  countPermitted: false,
  pingPermitted: false,
  ...over,
});

test("the switch off is `disabled`, and a fault is never reported as off", () => {
  assert.equal(
    activationVerdict(state({ mode: "off", countPermitted: false })),
    "disabled",
  );
  // §6: reporting a broken chain as "off" would make a tampered switch look
  // like a deliberate one, so every counting fault is `failed`.
  for (const fault of [
    "config_row_missing",
    "signature_unverified",
    "binding_mismatch",
    "unhashed_entry_present",
    "chain_broken",
  ]) {
    assert.equal(
      activationVerdict(state({ mode: null, fault, countPermitted: false })),
      "failed",
      fault,
    );
  }
});

test("on observes, and a missing ping URL does not stop the round", () => {
  assert.equal(
    activationVerdict(state({ mode: "on", countPermitted: true, pingPermitted: true })),
    "observe",
  );
  // The sixth fault withholds the ping only: the round still observes and
  // records, and the monitor reports the silence after `W` (§6, §8).
  assert.equal(
    activationVerdict(
      state({ mode: "on", fault: "ping_url_missing", countPermitted: true, pingPermitted: false }),
    ),
    "observe",
  );
});

test("a believed mode of off never observes, whatever else is set", () => {
  // Guards the one ordering mistake that would matter: counting on a switch
  // that is off reads personal data with no activation behind it.
  assert.equal(
    activationVerdict(state({ mode: "off", countPermitted: true, pingPermitted: true })),
    "disabled",
  );
});
