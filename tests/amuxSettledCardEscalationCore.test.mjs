import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxSettledCardEscalationRefusal,
  isAmuxSettledCardWithOpenEscalation,
} from "../lib/amux/settledCardEscalationCore.ts";

// A card that moved on while an earlier attempt's escalation stayed open (AMUX-FILEREQ-004).

const card = { status: "done", activeDelivery: false, liveAttempt: false, openEscalationIds: ["esc-1"] };

test("a done or todo card with its shown escalation still open can be closed", () => {
  assert.equal(amuxSettledCardEscalationRefusal(card, "esc-1"), null);
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, status: "todo" }, "esc-1"), null);
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: ["esc-0", "esc-1"] }, "esc-1"), null);
});

test("review and blocked keep the escalation their decision is made on; nothing running is touched", () => {
  for (const status of ["review", "blocked"])
    assert.equal(amuxSettledCardEscalationRefusal({ ...card, status }, "esc-1"), "decision_available");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, status: "doing" }, "esc-1"), "running");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, status: "todo", activeDelivery: true }, "esc-1"), "running");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, liveAttempt: true }, "esc-1"), "running");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: [] }, "esc-1"), "no_open_escalation");
  assert.equal(amuxSettledCardEscalationRefusal({ ...card, openEscalationIds: ["esc-2"] }, "esc-1"), "changed");
});

test("the queue and the card detail offer the close only on a done or todo card with an open escalation", () => {
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "done", escalationId: "esc-1" }), true);
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "todo", escalationId: "esc-1" }), true);
  assert.equal(isAmuxSettledCardWithOpenEscalation({ status: "done", escalationId: null }), false);
  for (const status of ["review", "blocked", "doing"])
    assert.equal(isAmuxSettledCardWithOpenEscalation({ status, escalationId: "esc-1" }), false);
});
