import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxSettledCardEscalationRefusal,
  isAmuxSettledCardWithOpenEscalation,
} from "../lib/amux/settledCardEscalationCore.ts";

// A done card left with an earlier attempt's escalation (AMUX-FILEREQ-004).

const card = { status: "done", activeDelivery: false, liveAttempt: false, openEscalationIds: ["esc-1"] };

test("a done card with its shown escalation still open can be closed", () => {
  assert.equal(amuxSettledCardEscalationRefusal(card, "esc-1"), null);
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: ["esc-0", "esc-1"] }, "esc-1"), null);
});

test("only a done card, only what was shown, and nothing still running", () => {
  for (const status of ["review", "blocked", "todo", "doing"])
    assert.equal(amuxSettledCardEscalationRefusal({ ...card, status }, "esc-1"), "not_done");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: [] }, "esc-1"), "no_open_escalation");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: ["esc-2"] }, "esc-1"), "changed");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, activeDelivery: true }, "esc-1"), "running");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, liveAttempt: true }, "esc-1"), "running");
});

test("the queue and the card detail offer the close only on a done card with an open escalation", () => {
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "done", escalationId: "esc-1" }), true);
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "done", escalationId: null }), false);
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "blocked", escalationId: "esc-1" }), false);
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "review", escalationId: "esc-1" }), false);
});
