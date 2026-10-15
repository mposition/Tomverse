import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V4_CARD_PLAN_MAX_UNITS, AmuxV4CardPlanError, amuxV4CardPlanRound, amuxV4PlanPublicPrConsent,
  orderAmuxV4CardPlan } from "../lib/amux/ideaCardPlanCore.ts";

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

test("a plan larger than one round is approved in dependency-closed prefixes", () => {
  const units = [card("unit-s000", "s", "story")];
  for (let index = 1; index <= 30; index += 1) {
    units.push(card(`unit-t${String(index).padStart(3, "0")}`, `t${index}`, "task",
      index === 1 ? [] : [`t${index - 1}`], "s"));
  }
  const ordered = orderAmuxV4CardPlan(units);
  const { round, remaining } = amuxV4CardPlanRound(ordered);
  assert.equal(round.length, AMUX_V4_CARD_PLAN_MAX_UNITS);
  assert.equal(remaining, units.length - AMUX_V4_CARD_PLAN_MAX_UNITS);
  const inRound = new Set(round.map((entry) => entry.localRef));
  for (const entry of round) {
    for (const ref of entry.dependencyRefs) assert.ok(inRound.has(ref), `${entry.localRef} carries ${ref}`);
  }
  assert.deepEqual(amuxV4CardPlanRound(ordered.slice(0, 3)), { round: ordered.slice(0, 3), remaining: 0 });
});
