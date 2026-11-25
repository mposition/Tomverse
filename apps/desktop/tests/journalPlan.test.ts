import assert from "node:assert/strict";
import test from "node:test";
import { fixtureWorkAnalysis } from "../../tomverse-cli/tests/fakeGateway";
import { journalPlan } from "../src/host/journal-view";

test("restored plan-only tasks keep proposals pending and retain the public analysis", () => {
  const saved: Parameters<typeof journalPlan>[0] = {
    id: "saved-task", readOnly: true, generations: [],
    tasks: [{ prompt: "Plan the change", startedAt: "2026-11-24T00:00:00Z", requests: 2, activeMs: 100,
      allowance: 4, timeAllowanceMs: 30_000, plan: {
        revision: 2, firstCallId: "initial-plan", activeId: "verify", analysis: fixtureWorkAnalysis,
        items: [{ id: "inspect", title: "Inspect the current behavior", complete: true, cancelled: false,
          evidence: [{ callId: "read", tool: "read_file", state: "succeeded" }] },
        { id: "verify", title: "Verify the proposed change", complete: false, cancelled: false, evidence: [] }],
      } }],
  };

  const legacy = journalPlan(saved);
  assert.ok(legacy);
  assert.equal(legacy.activeId, null);
  assert.equal(legacy.proposalOnly, true);
  assert.deepEqual(legacy.analysis, fixtureWorkAnalysis);
  assert.deepEqual(legacy.items.map(({ id, complete, evidence }) => [id, complete, evidence]),
    [["inspect", false, []], ["verify", false, []]]);
  assert.deepEqual(journalPlan({ ...saved, codeMode: "plan" }), legacy);

  const agent = journalPlan({ ...saved, codeMode: "agent", readOnly: false });
  assert.equal(agent?.activeId, "verify");
  assert.equal(agent?.items[0]?.complete, true);
  assert.equal(agent?.items[0]?.evidence[0]?.tool, "read_file");
});

test("saved API assignments require the current plan revision and a successful generation", () => {
  const at = "2026-11-24T00:00:00Z";
  const row = { id: "inspect", title: "Inspect the current behavior" };
  const binding = { ...row, assignment: { model: "selected-model", requestSeq: 1 } };
  const saved: Parameters<typeof journalPlan>[0] = {
    id: "saved-task", readOnly: false, codeMode: "agent", codeContinuation: { segmentId: "api-segment", maximumKeyCreditCap: 1 },
    generations: [{ seq: 1, purpose: "agent", state: "complete", idempotencyKey: "first-request", httpStatus: 200,
      routedModel: "reported-model", appliedEffort: "default", createdAt: at, updatedAt: at }],
    tasks: [{ prompt: "Inspect", startedAt: at, requests: 1, activeMs: 100, allowance: 4, timeAllowanceMs: 30_000,
      plan: { revision: 1, firstCallId: "initial-plan", activeId: "inspect", analysis: fixtureWorkAnalysis,
        items: [{ ...row, complete: false, cancelled: false, evidence: [] }] },
      planAssignments: { revision: 1, rows: [binding] } }],
  };
  const projected = journalPlan(saved)?.items[0];
  assert.deepEqual(projected?.apiAssignment, { assignment: binding.assignment, reportedModel: { model: "reported-model", source: "api_header" }, appliedEffort: "default" });
  assert.equal(projected?.segmentId, "api-segment");
  assert.equal(projected?.complete, false);
  assert.deepEqual(projected?.evidence, []);
  const task = saved.tasks[0]!;
  assert.equal(journalPlan({ ...saved, generations: [] })?.items[0]?.apiAssignment, undefined);
  assert.equal(journalPlan({ ...saved, tasks: [{ ...task, planAssignments: { revision: 0, rows: [binding] } }] })?.items[0]?.apiAssignment, undefined);
  assert.equal(journalPlan({ ...saved, tasks: [{ ...task, planAssignments: { revision: 1, rows: [binding, binding] } }] })?.items[0]?.apiAssignment, undefined);
});
