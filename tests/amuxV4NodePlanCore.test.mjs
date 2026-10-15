import assert from "node:assert/strict";
import test from "node:test";

import { AmuxV4NodePlanError, orderAmuxV4NodePlan } from "../lib/amux/ideaNodePlanCore.ts";

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
