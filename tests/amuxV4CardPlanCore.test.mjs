import assert from "node:assert/strict";
import test from "node:test";

import { AmuxV4CardPlanError, amuxV4PlanPublicPrConsent, orderAmuxV4CardPlan } from "../lib/amux/ideaCardPlanCore.ts";

const card = (draftUnitId, localRef, cardType, dependencyRefs = [], parentStoryRef = null) =>
  ({ draftUnitId, localRef, cardType, dependencyRefs, parentStoryRef });

test("Stories come first, then each Task after the plan's own Tasks it depends on", () => {
  const plan = orderAmuxV4CardPlan([
    card("unit-t3", "t3", "task", ["t2"], "s1"),
    card("unit-t1", "t1", "task", [], "s1"),
    card("unit-s1", "s1", "story"),
    card("unit-t2", "t2", "task", ["t1"], "s1"),
  ]);
  assert.deepEqual(plan.map((entry) => entry.draftUnitId), ["unit-s1", "unit-t1", "unit-t2", "unit-t3"]);
});

test("a dependency outside the plan is left to the resolver", () => {
  const plan = orderAmuxV4CardPlan([card("unit-t1", "t1", "task", ["approved-earlier"])]);
  assert.deepEqual(plan.map((entry) => entry.draftUnitId), ["unit-t1"]);
});

test("a cycle among the plan's Tasks refuses the whole plan", () => {
  assert.throws(() => orderAmuxV4CardPlan([
    card("unit-t1", "t1", "task", ["t2"]), card("unit-t2", "t2", "task", ["t1"]),
  ]), (error) => error instanceof AmuxV4CardPlanError && error.code === "dependency_cycle" &&
    error.draftUnitIds.length === 2);
});

test("public PR consent is on for implement Tasks unless turned off, and never for anything else", () => {
  const off = new Set(["unit-off"]);
  assert.equal(amuxV4PlanPublicPrConsent({ draftUnitId: "unit-a", cardType: "task", taskRole: "implement" }, off), true);
  assert.equal(amuxV4PlanPublicPrConsent({ draftUnitId: "unit-off", cardType: "task", taskRole: "implement" }, off), false);
  assert.equal(amuxV4PlanPublicPrConsent({ draftUnitId: "unit-b", cardType: "task", taskRole: "design" }, off), false);
  assert.equal(amuxV4PlanPublicPrConsent({ draftUnitId: "unit-c", cardType: "story", taskRole: null }, off), false);
});
