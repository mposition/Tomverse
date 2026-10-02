import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_ADMIN_KANBAN_LANES, amuxLegacyTodoClaimVerified, projectAmuxAdminKanban,
  amuxAdminKanbanLane } from "../lib/amux/adminKanbanCore.ts";

const card = (status, owner = null, requiresHumanReview = false, claimVerified = false) => ({
  status, owner, requiresHumanReview, claimVerified,
});

test("AMUX board separates Tomverse backlog from unassigned and assigned todo", () => {
  assert.equal(amuxAdminKanbanLane(card("backlog")), "tomverse_backlog");
  assert.equal(amuxAdminKanbanLane(card("todo")), "amux_backlog");
  assert.equal(amuxAdminKanbanLane(card("todo", "worker-1")), "owner_attention");
  assert.equal(amuxAdminKanbanLane(card("todo", "worker-1", false, true)), "todo");
  assert.equal(amuxAdminKanbanLane(card("doing", "worker-1")), "in_progress");
  assert.equal(amuxAdminKanbanLane(card("review", "worker-1")), "in_review");
});

test("assigned todo requires the legacy atomic claim evidence, not owner text", () => {
  const claimedAt = new Date("2026-10-03T00:00:00.000Z");
  const row = { status: "todo", owner: "worker-1", claimedAt, revision: 2 };
  assert.equal(amuxLegacyTodoClaimVerified(row, { worker: "worker-1", taskRevision: 1 }), true);
  for (const [cardOverride, route] of [
    [{ claimedAt: null }, { worker: "worker-1", taskRevision: 1 }],
    [{ owner: "worker-2" }, { worker: "worker-1", taskRevision: 1 }],
    [{ revision: 3 }, { worker: "worker-1", taskRevision: 1 }],
    [{ status: "backlog" }, { worker: "worker-1", taskRevision: 1 }],
    [{}, null],
  ]) {
    assert.equal(amuxLegacyTodoClaimVerified({ ...row, ...cardOverride }, route), false);
  }
});

test("AMUX board keeps attention and unexpected active states visible once", () => {
  const rows = [card("blocked"), card("review", "worker-1", true),
    card("unexpected"), card("done"), card("cancelled")];
  const projected = projectAmuxAdminKanban(rows);
  assert.deepEqual(AMUX_ADMIN_KANBAN_LANES, ["tomverse_backlog", "amux_backlog",
    "todo", "in_progress", "in_review", "owner_attention"]);
  assert.equal(projected.lanes.owner_attention.length, 3);
  assert.equal(projected.terminalCount, 2);
  assert.equal(Object.values(projected.lanes).flat().length + projected.terminalCount, rows.length);
});
