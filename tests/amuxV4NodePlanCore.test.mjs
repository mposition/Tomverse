import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V4_NODE_PLAN_MAX_UNITS, AmuxV4NodePlanError, amuxV4NodePlanRound,
  orderAmuxV4NodePlan, sortAmuxV4NodePlan } from "../lib/amux/ideaNodePlanCore.ts";

const unit = (draftUnitId, localRef, level, parentRef) => ({ draftUnitId, localRef, level, parentRef });

test("parents come before children, and a parent in the plan is bound by its local ref", () => {
  const plan = orderAmuxV4NodePlan([
    unit("unit-feature", "f1", "feature", "e1"),
    unit("unit-epic", "e1", "epic", "i1"),
    unit("unit-init", "i1", "initiative", null),
  ], new Map());
  assert.deepEqual(plan.map((entry) => entry.draftUnitId), ["unit-init", "unit-epic", "unit-feature"]);
  assert.deepEqual(plan[0].parent, { kind: "none" });
  assert.deepEqual(plan[1].parent, { kind: "batch", localRef: "i1" });
  assert.deepEqual(plan[2].parent, { kind: "batch", localRef: "e1" });
});

test("a parent approved in an earlier round resolves to its node", () => {
  const plan = orderAmuxV4NodePlan([unit("unit-feature", "f1", "feature", "e1")], new Map([["e1", "node-epic"]]));
  assert.deepEqual(plan[0].parent, { kind: "existing", nodeId: "node-epic" });
});

test("a parent nobody can resolve, or a non-initiative without one, refuses the whole plan", () => {
  assert.throws(() => orderAmuxV4NodePlan([unit("unit-feature", "f1", "feature", "missing")], new Map()),
    (error) => error instanceof AmuxV4NodePlanError && error.code === "parent_unresolved" &&
      error.draftUnitIds.includes("unit-feature"));
  assert.throws(() => orderAmuxV4NodePlan([unit("unit-epic", "e1", "epic", null)], new Map()),
    (error) => error instanceof AmuxV4NodePlanError && error.code === "parent_unresolved");
  // A plan sibling at the wrong level is not a parent.
  assert.throws(() => orderAmuxV4NodePlan([
    unit("unit-a", "a", "feature", "b"), unit("unit-b", "b", "feature", null),
  ], new Map()), (error) => error instanceof AmuxV4NodePlanError);
});

test("a round is a parent-closed prefix of at most twelve nodes", () => {
  // Owner direction 2026-11-15: more nodes take more rounds instead of a refusal.
  const units = [unit("u-i", "i", "initiative", null)];
  for (let index = 0; index < 4; index += 1) units.push(unit(`u-e${index}`, `e${index}`, "epic", "i"));
  for (let index = 0; index < 20; index += 1) {
    units.push(unit(`u-f${String(index).padStart(2, "0")}`, `f${index}`, "feature", `e${index % 4}`));
  }
  const ordered = orderAmuxV4NodePlan(units, new Map());
  const { round, remaining } = amuxV4NodePlanRound(ordered);
  assert.equal(round.length, AMUX_V4_NODE_PLAN_MAX_UNITS);
  assert.equal(remaining, units.length - AMUX_V4_NODE_PLAN_MAX_UNITS);
  const inRound = new Set(round.map((entry) => entry.localRef));
  for (const entry of round) {
    if (entry.parent.kind === "batch") assert.ok(inRound.has(entry.parent.localRef), entry.localRef);
  }
  assert.deepEqual(sortAmuxV4NodePlan(units).map((entry) => entry.draftUnitId),
    ordered.map((entry) => entry.draftUnitId));
  // The next round finds the first round's nodes approved.
  const approved = new Map(round.map((entry) => [entry.localRef, `node-${entry.localRef}`]));
  const next = orderAmuxV4NodePlan(units.filter((entry) => !inRound.has(entry.localRef)), approved);
  assert.ok(next.every((entry) => entry.parent.kind === "existing"));
});
