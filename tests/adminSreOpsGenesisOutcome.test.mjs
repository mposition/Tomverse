// What the genesis screen says about one request: only a 200 with an id is
// created, only a 409 with one of the store's pre-write refusal codes is a
// refusal, and anything that may have followed a commit -- a 409 late
// included -- is unknown (docs/policy/sre-ops.md §3 rule 7).

import assert from "node:assert/strict";
import test from "node:test";

import { GENESIS_PRE_WRITE_REFUSALS, genesisOutcome } from "../lib/adminSreOpsGenesisOutcome.ts";

test("each answer maps to what the screen may claim", () => {
  assert.deepEqual(genesisOutcome({ status: 200, payload: { result: { genesisId: "g" } } }), { kind: "created", genesisId: "g" });
  for (const code of GENESIS_PRE_WRITE_REFUSALS) {
    assert.deepEqual(genesisOutcome({ status: 409, payload: { code } }), { kind: "refused", code });
  }
  assert.deepEqual(genesisOutcome({ status: 428, payload: {} }), { kind: "requiresReauthentication" });
  assert.deepEqual(genesisOutcome({ status: 403, payload: { code: "ADMIN_REAUTHENTICATION_REQUIRED" } }), { kind: "requiresReauthentication" });
});

test("a lost, late or unreadable answer is unknown, never not-approved", () => {
  for (const answer of [
    "no_answer",
    { status: 500, payload: {} },
    { status: 200, payload: {} },
    { status: 409, payload: {} },
    // The route answers late for a deadline missed after the commit, too.
    { status: 409, payload: { code: "late" } },
    { status: 409, payload: { code: "something_new" } },
    { status: 502, payload: { code: "stale" } },
  ]) {
    assert.deepEqual(genesisOutcome(answer), { kind: "unknown" }, JSON.stringify(answer));
  }
});
