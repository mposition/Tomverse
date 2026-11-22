import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { amuxSessionAnswerUnitCount } from "@/lib/amux/ideaSessionAnswerCore";
import {
  AMUX_SESSION_PLAN_AUTO_REGISTER_ENV,
  amuxSessionPlanAutoRegisterEnabled,
  readAmuxSessionPlanRegistration,
} from "@/lib/amux/ideaSessionPlanCore";
import {
  inspectAmuxIdeaSessionPlan,
  inspectAmuxIdeaSessionSubmission,
} from "@/lib/amux/ideaSessionSubmissionCore";
import { amuxSessionPlanFixture } from "./fixtures/amuxSessionPlan.mjs";

const source = { toolName: "Claude Code", modelProvider: "Anthropic",
  sessionDisplay: "Plan intake session" };
const submission = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  requestId: randomUUID(),
  input: { version: 1, idea: "Add a dark mode toggle.", repositories: ["mposition/Tomverse"],
    pullRequests: [] },
  source,
  ...extra,
});
const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
const withCard = (patch: Record<string, unknown>) => {
  const plan = amuxSessionPlanFixture();
  plan.units[3] = { ...plan.units[3], ...patch };
  return plan;
};

test("a submission without a plan is the same inspection as before", () => {
  const inspected = inspectAmuxIdeaSessionSubmission(submission());
  assert.equal(inspected.ok, true);
  assert.equal(inspected.ok && Object.hasOwn(inspected, "plan"), false);
  // An extra key other than plan is still refused.
  assert.deepEqual(inspectAmuxIdeaSessionSubmission(submission({ notes: "x" })),
    { ok: false, code: "schema_rejected" });
});

test("an attached plan passes the box answer parser with its header derived", () => {
  const inspected = inspectAmuxIdeaSessionSubmission(submission({ plan: amuxSessionPlanFixture() }));
  assert.equal(inspected.ok, true);
  if (!inspected.ok || !inspected.plan) throw new Error("plan missing");
  assert.equal(inspected.plan.unitCount, 4);
  // The raw text is what the plan writer parses, and every unit gets a key.
  assert.equal(amuxSessionAnswerUnitCount(inspected.plan.raw), 4);
  assert.deepEqual(JSON.parse(inspected.plan.raw), amuxSessionPlanFixture());
  // The verdict does not depend on the preview id used to fill the header.
  assert.deepEqual(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture(), randomUUID()).ok, true);
});

test("a plan in the wrong format is refused with the parser's own closed rule", () => {
  const plan = amuxSessionPlanFixture();
  delete (plan.units[3] as Record<string, unknown>).expectedPaths;
  const refused = inspectAmuxIdeaSessionPlan(plan, randomUUID());
  assert.equal(refused.ok, false);
  assert.deepEqual(refused, { ok: false, code: "plan_rejected", reason: "schema",
    detail: { detail: "chunk_schema_rejected", at: { rule: "task_expected_paths_missing",
      field: "expectedPaths", unit: 3, kind: "card" } } });
  for (const value of [null, [], "plan", 3]) {
    assert.deepEqual(inspectAmuxIdeaSessionPlan(value, randomUUID()),
      { ok: false, code: "plan_rejected", reason: "schema" });
  }
  assert.deepEqual(inspectAmuxIdeaSessionSubmission(submission({ plan })),
    { ok: false, code: "plan_rejected" });
  // A dangling reference is the parser's refusal too.
  assert.equal(inspectAmuxIdeaSessionPlan(withCard({ featureRef: "c0:node-9" }),
    randomUUID()).ok, false);
});

test("the intake content checks run on every text the plan holds", () => {
  for (const patch of [
    { problem: "Rotate key sk-live1234567890abcdef first." },
    { executionBrief: "Read C:\\Users\\operator\\notes.txt before starting." },
    { scopeIn: ["Ping http://192.168.0.7:8080/health"] },
    { scopeOut: ["Email someone@example.com"] },
    { expectedPaths: ["components/settings/AppearanceSettings.tsx", "/home/tommy/.env"] },
    { title: "Check localhost first" },
  ]) {
    assert.deepEqual(inspectAmuxIdeaSessionPlan(withCard(patch), randomUUID()),
      { ok: false, code: "content_refused" }, JSON.stringify(patch));
  }
  assert.deepEqual(inspectAmuxIdeaSessionSubmission(submission({
    plan: withCard({ problem: "token=abcdefghijk" }) })), { ok: false, code: "content_refused" });
});

test("a plan must be a closed proposal: no question, rejection or remainder", () => {
  assert.deepEqual(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture({
    coverageStatus: "more", remainingScope: "A second Task for the mobile settings." }),
  randomUUID()), { ok: false, code: "plan_rejected", reason: "continues" });
  assert.deepEqual(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture({
    outcome: "reject", units: [] }), randomUUID()),
  { ok: false, code: "plan_rejected", reason: "not_a_proposal" });
  // A question is refused whether or not units stand beside it: the session
  // bookkeeping would otherwise drop it and the plan would pass without it.
  for (const overrides of [
    { outcome: "needs_information", ownerQuestion: "Which settings page?" },
    { ownerQuestion: "Which settings page?" },
    { ownerQuestion: 3 },
    // A declared owner-input page without its question is not a proposal either.
    { outcome: "needs_information" },
    { coverageStatus: "needs_owner_input", ownerQuestion: null },
  ]) {
    assert.deepEqual(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture(overrides), randomUUID()),
      { ok: false, code: "plan_rejected", reason: "question" }, JSON.stringify(overrides));
  }
  for (const ownerQuestion of [null, "", "  "]) {
    assert.equal(inspectAmuxIdeaSessionPlan(amuxSessionPlanFixture({ ownerQuestion }),
      randomUUID()).ok, true, JSON.stringify(ownerQuestion));
  }
});

test("automatic registration of session plans is on only for the exact word", () => {
  assert.equal(AMUX_SESSION_PLAN_AUTO_REGISTER_ENV, "TOMVERSE_AMUX_SESSION_PLAN_AUTO_REGISTER");
  assert.equal(amuxSessionPlanAutoRegisterEnabled(env({})), false);
  for (const value of ["true", "1", "Enabled", " enabled", "on"]) {
    assert.equal(amuxSessionPlanAutoRegisterEnabled(env({ [AMUX_SESSION_PLAN_AUTO_REGISTER_ENV]: value })),
      false, value);
  }
  assert.equal(amuxSessionPlanAutoRegisterEnabled(env({ [AMUX_SESSION_PLAN_AUTO_REGISTER_ENV]: "enabled" })),
    true);
  // The box analysis switch does not open it.
  assert.equal(amuxSessionPlanAutoRegisterEnabled(env({
    TOMVERSE_AMUX_V19_SYSTEM_REGISTRATION: "enabled" })), false);
});

test("a client reads back only the closed plan registration shape", () => {
  assert.deepEqual(readAmuxSessionPlanRegistration({ state: "awaiting_approval", unitCount: 4 }),
    { state: "awaiting_approval", unitCount: 4 });
  assert.deepEqual(readAmuxSessionPlanRegistration({ state: "registration_incomplete",
    code: "halted", unitCount: 2 }), { state: "registration_incomplete", code: "halted", unitCount: 2 });
  for (const value of [null, {}, { state: "registered", unitCount: 0 },
    { state: "approved", unitCount: 1 },
    { state: "registration_incomplete", code: "Bad Code", unitCount: 1 }]) {
    assert.equal(readAmuxSessionPlanRegistration(value), null, JSON.stringify(value));
  }
});
