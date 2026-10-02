import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_ADMIN_KANBAN_LANES, projectAmuxAdminKanban,
  amuxAdminKanbanLane } from "../lib/amux/adminKanbanCore.ts";

const card = (status, owner = null, requiresHumanReview = false) => ({
  status, owner, requiresHumanReview,
});

test("AMUX board separates Tomverse backlog from unassigned and assigned todo", () => {
  assert.equal(amuxAdminKanbanLane(card("backlog")), "tomverse_backlog");
  assert.equal(amuxAdminKanbanLane(card("todo")), "amux_backlog");
  assert.equal(amuxAdminKanbanLane(card("todo", "worker-1")), "todo");
  assert.equal(amuxAdminKanbanLane(card("doing", "worker-1")), "in_progress");
  assert.equal(amuxAdminKanbanLane(card("review", "worker-1")), "in_review");
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
