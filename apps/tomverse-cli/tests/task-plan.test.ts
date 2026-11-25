import assert from "node:assert/strict";
import test from "node:test";
import { resetActivePlanEvidence, settlePlanEvidence, startPlanEvidence, taskPlanInput, taskPlanSchema, toolPlanOutcome,
    updatePlanAssignments, updateTaskPlan } from "../src/task-plan";

const inspect = { id: "inspect", title: "Inspect the implementation" };
const check = { id: "verify", title: "Verify the change" };

test("A model is assigned on activation and rebound when the work item changes", () => {
    const items = [inspect, check];
    const first = updateTaskPlan(undefined, { revision: 0, items, activeId: inspect.id }, "call_first").plan!;
    const firstBinding = { model: "first-model", requestSeq: 1 };
    const recorded = updatePlanAssignments(undefined, undefined, first, firstBinding)!;
    assert.deepEqual(recorded.rows.map(({ id, assignment }) => [id, assignment]), [[inspect.id, firstBinding]]);
    assert.deepEqual(first.items[0]?.evidence, []);
    const sameItem = updateTaskPlan(first, { revision: 1, items, activeId: inspect.id }, "call_same").plan!;
    const secondBinding = { model: "second-model", requestSeq: 2 };
    assert.deepEqual(updatePlanAssignments(first, recorded, sameItem, secondBinding)?.rows, recorded.rows);
    const renamed = { ...inspect, title: "Inspect the revised behavior" };
    const changed = updateTaskPlan(first, { revision: 1, items: [renamed, check], activeId: inspect.id }, "call_changed").plan!;
    assert.deepEqual(updatePlanAssignments(first, recorded, changed, secondBinding)?.rows, [{ ...renamed, assignment: secondBinding }]);
    assert.deepEqual(updatePlanAssignments(sameItem, recorded, changed, undefined), undefined);
});

test("Order and completion follow the revision and evidence from the active task", () => {
    const input = { revision: 0, items: [inspect, check], activeId: "inspect" };
    assert.equal(taskPlanInput.safeParse({ ...input, model: "invented" }).success, false);
    assert.equal(updateTaskPlan(undefined, { ...input, items: [inspect, inspect] }, "call_first").plan, undefined);
    const plan = updateTaskPlan(undefined, input, "call_first").plan!;
    const completedUpdate = { revision: 1, items: [check, inspect], activeId: "verify", completeId: "inspect" };
    assert.equal(updateTaskPlan(plan, { ...completedUpdate, revision: 0 }, "call_stale").plan, undefined);
    assert.equal(updateTaskPlan(plan, completedUpdate, "call_without_evidence").plan, undefined);
    assert.equal(startPlanEvidence(plan, "call_read", "read_file", "running", { model: "actual-model", requestSeq: 1 }), true);
    assert.equal(settlePlanEvidence(plan, "call_not_issued", "succeeded"), false);
    assert.equal(settlePlanEvidence(plan, "call_read", "succeeded"), true);
    assert.equal(settlePlanEvidence(plan, "call_read", "failed"), false);
    const updated = updateTaskPlan(plan, completedUpdate, "call_complete").plan!;
    assert.deepEqual(updated.items.map(({ id, complete }) => [id, complete]), [["verify", false], ["inspect", true]]);
    assert.deepEqual(updated.items[1]!.evidence[0]!.assignment, { model: "actual-model", requestSeq: 1 });
    assert.equal(startPlanEvidence(updated, "call_read", "read_file", "running"), false);
    const shortened = updateTaskPlan(updated, { revision: 2, items: [inspect], activeId: null }, "call_cancel").plan!;
    assert.equal(shortened.items[1]!.cancelled, true);
    assert.equal(taskPlanSchema.safeParse({ ...shortened, items: [shortened.items[0], shortened.items[0]] }).success, false);
});

test("A clarification pauses work without cancelling retained rows or letting the model reactivate them", () => {
    const analysis = { objective: "Check the report", verifiedFacts: [], assumptions: [],
        scope: "Inspect search behavior", verification: "Compare the search results", completion: "Agree on archive scope" };
    const plan = updateTaskPlan(undefined, { revision: 0, items: [inspect], activeId: inspect.id, analysis }, "call_plan").plan!;
    const question = { revision: 1, items: [], activeId: null, analysis, clarification: "Include archived records?" };
    assert.equal(updateTaskPlan(plan, { ...question, items: [inspect], activeId: inspect.id }, "call_invalid").plan, undefined);
    const waiting = updateTaskPlan(plan, question, "call_ask").plan!;
    assert.equal(waiting.activeId, null);
    assert.equal(waiting.items[0]?.cancelled, false);
    assert.equal(taskPlanSchema.safeParse(waiting).success, true);
    const reactivate = { revision: 2, items: [inspect], activeId: inspect.id, analysis };
    assert.equal(updateTaskPlan(waiting, reactivate, "call_without_answer").plan, undefined);
    resetActivePlanEvidence(waiting);
    assert.equal(waiting.clarification, undefined);
    assert.equal(updateTaskPlan(waiting, reactivate, "call_after_answer").plan?.activeId, inspect.id);
});

test("Command errors and an unconfirmed process tree cannot complete a task", () => {
    const plan = updateTaskPlan(undefined, { revision: 0, items: [check], activeId: "verify" }, "call_plan").plan!;
    const completion = { revision: 1, items: [check], activeId: null, completeId: "verify" };
    assert.equal(startPlanEvidence(plan, "call_command", "run_command", "approval"), true);
    assert.equal(updateTaskPlan(plan, completion, "call_waiting").plan, undefined);
    assert.equal(settlePlanEvidence(plan, "call_command", toolPlanOutcome("run_command", { status: "ok", exitCode: 7 })), true);
    assert.equal(updateTaskPlan(plan, completion, "call_failed").plan, undefined);
    assert.equal(startPlanEvidence(plan, "call_read", "read_file", "running"), true);
    assert.equal(settlePlanEvidence(plan, "call_read", "succeeded"), true);
    assert.equal(updateTaskPlan(plan, completion, "call_incomplete").plan, undefined);
    assert.equal(toolPlanOutcome("run_command", { status: "ok", exitCode: 0, residualProcesses: [123] }), "unconfirmed");
    assert.equal(toolPlanOutcome("run_command", { status: "ok", exitCode: 0, processTreeChecked: false }), "unconfirmed");
});

test("A follow-up and a renamed item require fresh evidence while preserving recorded results", () => {
    const plan = updateTaskPlan(undefined, { revision: 0, items: [check], activeId: check.id }, "call_plan").plan!;
    assert.ok(startPlanEvidence(plan, "call_read", "read_file", "running"));
    assert.ok(settlePlanEvidence(plan, "call_read", "succeeded"));
    resetActivePlanEvidence(plan);
    const active = updateTaskPlan(plan, { revision: 1, items: [check], activeId: check.id }, "call_activate").plan!;
    const done = { revision: 2, items: [check], activeId: null, completeId: check.id };
    assert.equal(updateTaskPlan(active, done, "call_stale").plan, undefined);
    assert.ok(startPlanEvidence(active, "call_read_again", "read_file", "running"));
    assert.ok(settlePlanEvidence(active, "call_read_again", "succeeded"));
    const renamed = { ...check, title: "Verify the keyboard flow" };
    const changed = updateTaskPlan(active, { revision: 2, items: [renamed], activeId: check.id }, "call_rename").plan!;
    const revised = { ...done, revision: 3, items: [renamed] };
    assert.equal(updateTaskPlan(changed, revised, "call_stale_again").plan, undefined);
    assert.ok(startPlanEvidence(changed, "call_new_read", "read_file", "running"));
    assert.ok(settlePlanEvidence(changed, "call_new_read", "succeeded"));
    const finished = updateTaskPlan(changed, revised, "call_finish").plan!;
    assert.equal(finished.items[0]!.evidence.length, 3);
    assert.equal(finished.items[0]!.complete, true);
    assert.equal(taskPlanSchema.safeParse(finished).success, true);
});
