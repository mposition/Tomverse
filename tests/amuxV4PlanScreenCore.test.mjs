import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amuxV4PlanMetrics, amuxV4PlanRound, amuxV4PlanScreenUnits, amuxV4PlanShowsPublicPrConsent,
  buildAmuxV4PlanRequest } from
  "../lib/amux/ideaPlanScreenCore.ts";

const signal = (metrics) => ({ metrics, uncertainty: "low", rationale: "r", evidenceRefIds: ["s1"] });
const taskMetrics = { contribution: 4, urgency: 3, dependencyUnlock: 2, workerCoverage: 5, effort: 2, deliveryRisk: 1 };
const node = (id, localRef, level, parentRef, metrics = { value: 3 }) => ({ id, localRef, bodyDigest: "d".repeat(64),
  bodyDigestKeyId: "k", decisionState: "proposed",
  proposal: { kind: "node", localId: localRef, level, parentRef, title: localRef, description: "", sourceRefIds: [],
    portfolioSignal: metrics ? signal(metrics) : undefined } });
const card = (id, localRef, cardType, extra = {}) => ({ id, localRef, bodyDigest: "e".repeat(64), bodyDigestKeyId: "k",
  decisionState: "proposed",
  proposal: { kind: "card", localId: localRef, cardType, storyKind: cardType === "story" ? "general" : null,
    title: localRef, problem: "", scopeIn: [], scopeOut: [], completionCriteria: [], featureRef: "f1",
    parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [], taskRole: cardType === "task" ? "implement" : null,
    executionGrade: null, executionBrief: null, sourceRefIds: [],
    portfolioSignal: signal(cardType === "task" ? taskMetrics : { impact: 3 }), ...extra } });
const units = [
  node("unit-init-01", "i1", "initiative", null), node("unit-epic-01", "e1", "epic", "i1"),
  node("unit-feat-01", "f1", "feature", "e1"), card("unit-story-1", "s1", "story"),
  card("unit-task-01", "t1", "task", { parentStoryRef: "s1" }), card("unit-task-02", "t2", "task", { taskRole: "test" }),
  { ...card("unit-done-01", "x1", "task"), decisionState: "approved" },
];
const plan = "11111111-2222-4333-8444-555555555555";

test("the screen lists only proposed node and card units", () => {
  const listed = amuxV4PlanScreenUnits(units);
  assert.deepEqual(listed.map((u) => u.unitId), ["unit-init-01", "unit-epic-01", "unit-feat-01", "unit-story-1", "unit-task-01", "unit-task-02"]);
  assert.deepEqual(listed.find((u) => u.unitId === "unit-task-01").metrics, taskMetrics);
});

test("metrics must be exactly the subject kind's keys, integers 0..5", () => {
  assert.deepEqual(amuxV4PlanMetrics("epic", { value: 5 }), { value: 5 });
  assert.equal(amuxV4PlanMetrics("epic", { value: 6 }), null);
  assert.equal(amuxV4PlanMetrics("epic", { value: 2, extra: 1 }), null);
  assert.equal(amuxV4PlanMetrics("story", { value: 2 }), null);
  assert.equal(amuxV4PlanMetrics("task", { ...taskMetrics, effort: 2.5 }), null);
});

test("every unit with metrics is assessed once, bound to its proposal, and full paths are scored", () => {
  const body = buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan,
    units: amuxV4PlanScreenUnits(units), edits: new Map([["unit-epic-01", { value: 5 }]]), consentOff: new Set() });
  assert.equal(body.assessments.length, 6);
  const epic = body.assessments.find((a) => a.unitId === "unit-epic-01");
  assert.deepEqual(epic.metrics, { value: 5 });
  assert.equal(epic.modelProposalDigest, "d".repeat(64));
  assert.deepEqual(epic.evidenceRefs, ["unit:unit-epic-01"]);
  assert.deepEqual(body.scoreTaskUnitIds, ["unit-task-01", "unit-task-02"]);
  assert.deepEqual(body.publicPrConsentOff, []);
});

test("a Task whose path leaves the plan or lacks metrics is not scored here", () => {
  const noFeatureSignal = units.map((u) => u.id === "unit-feat-01" ? node("unit-feat-01", "f1", "feature", "e1", null) : u);
  const body = buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan,
    units: amuxV4PlanScreenUnits(noFeatureSignal), edits: new Map(), consentOff: new Set() });
  assert.deepEqual(body.scoreTaskUnitIds, []);
  assert.equal(body.assessments.some((a) => a.unitId === "unit-feat-01"), false);
  const outside = units.filter((u) => u.id !== "unit-init-01");
  assert.deepEqual(buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan,
    units: amuxV4PlanScreenUnits(outside), edits: new Map(), consentOff: new Set() }).scoreTaskUnitIds, []);
});

test("the plan screen shows a consent box only for implement and test Tasks", () => {
  for (const [kind, taskRole, shown] of [["task", "implement", true], ["task", "test", true],
    ["task", "verify", false], ["task", "design", false], ["task", "operate", false],
    ["story", null, false]]) {
    assert.equal(amuxV4PlanShowsPublicPrConsent({ kind, taskRole }), shown, `${kind}/${taskRole}`);
  }
  const panel = readFileSync("components/admin/AmuxIdeaPlanApprovalPanel.tsx", "utf8");
  assert.match(panel, /\{amuxV4PlanShowsPublicPrConsent\(unit\) && !later \?/);
});

test("public PR consent is turned off only for patch-writing Tasks the owner unchecked", () => {
  // A test Task writes a patch through the implement execution (2026-10-30).
  const body = buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan,
    units: amuxV4PlanScreenUnits(units), edits: new Map(),
    consentOff: new Set(["unit-task-01", "unit-task-02", "unit-story-1"]) });
  assert.deepEqual(body.publicPrConsentOff, ["unit-task-01", "unit-task-02"]);
});

test("the request names exactly the units this approval registers", () => {
  const body = buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan,
    units: amuxV4PlanScreenUnits(units), edits: new Map(), consentOff: new Set() });
  assert.deepEqual([...body.expectedUnitIds].sort(),
    ["unit-epic-01", "unit-feat-01", "unit-init-01", "unit-story-1", "unit-task-01", "unit-task-02"]);
});

test("a large plan sends only the server's first round, with that round's scores", () => {
  const many = [node("unit-init-01", "i1", "initiative", null), node("unit-epic-01", "e1", "epic", "i1"),
    node("unit-feat-01", "f1", "feature", "e1"), card("unit-s000000", "s0", "story")];
  for (let index = 1; index <= 30; index += 1) {
    many.push(card(`unit-t${String(index).padStart(6, "0")}`, `t${index}`, "task",
      { parentStoryRef: "s0", dependencyRefs: index === 1 ? [] : [`t${index - 1}`] }));
  }
  const listed = amuxV4PlanScreenUnits(many);
  const { inRound, deferred } = amuxV4PlanRound(listed);
  assert.equal(inRound.size, 3 + 24);
  assert.equal(deferred.length, 31 - 24);
  const body = buildAmuxV4PlanRequest({ ideaId: "idea-0001", planRequestId: plan, units: listed,
    edits: new Map(), consentOff: new Set() });
  assert.equal(body.expectedUnitIds.length, 27);
  assert.ok(body.assessments.every((a) => inRound.has(a.unitId)));
  assert.ok(body.scoreTaskUnitIds.every((id) => inRound.has(id)));
  assert.ok(deferred.every((id) => !body.expectedUnitIds.includes(id)));
});
