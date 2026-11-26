import assert from "node:assert/strict";
import test from "node:test";
import type { SessionState, SubtaskRecord } from "../../tomverse-cli/src/runtime";
import { journalEngine, journalOrchestration } from "../src/host/journal-view";
import { subagentStopInput } from "../src/orchestrate-contract";
import { startInput } from "../src/contract";

const subtask = (id: string, state: SubtaskRecord["state"], extra: Partial<SubtaskRecord> = {}): SubtaskRecord => ({
  id, toolCallId: "call_1", title: `Subtask ${id}`, kind: "worker", state, attempts: 1, requests: 3, runIds: [], startedAt: "2026-11-26T00:00:00.000Z", epoch: "e1", ...extra,
});
const session = (status: SessionState["status"], subtasks?: SubtaskRecord[], orchestrate: SessionState["orchestrate"] = { maxSubagents: 3, maxRequests: 90 }) =>
  ({ status, subtasks, orchestrate, tasks: [], limits: {} }) as unknown as SessionState;

test("a session that did not turn orchestration on shows none", () => {
  assert.equal(journalOrchestration({ status: "completed", subtasks: [subtask("st-000001", "success")], tasks: [], limits: {} } as unknown as SessionState), undefined);
  assert.equal(journalEngine({ ...session("completed"), orchestrate: undefined }).orchestration, undefined);
});

test("subtask rows carry state, scope, changed files and verdict; the numbers add up and no credential is shown", () => {
  const key = "tvk_abcdefgh_" + "A".repeat(43);
  const view = journalOrchestration(session("running", [
    subtask("st-000001", "success", { paths: ["src"], filesChanged: ["src/a.ts"], verification: { state: "passed", reason: `fine, key ${key}`, check: "passed" } }),
    subtask("st-000002", "running", { activity: "read_file src/b.ts", requests: 2 }),
  ]), key)!;
  assert.deepEqual([view.maxSubagents, view.maxRequests, view.used], [3, 90, 5]);
  assert.deepEqual(view.subtasks.map((row) => [row.id, row.state]), [["st-000001", "success"], ["st-000002", "running"]]);
  assert.deepEqual(view.subtasks[0]!.paths, ["src"]);
  assert.equal(view.subtasks[1]!.activity, "read_file src/b.ts");
  assert.ok(!JSON.stringify(view).includes(key));
  assert.match(view.subtasks[0]!.verification!.reason, /credential removed/);
});

test("a subtask still under way in a session that is not running is shown as failed, not as running", () => {
  const view = journalOrchestration(session("cancelled", [subtask("st-000003", "running", { activity: "stale" }), subtask("st-000004", "queued")]))!;
  assert.deepEqual(view.subtasks.map((row) => row.state), ["failed", "failed"]);
  assert.equal(view.subtasks[0]!.activity, undefined);
  assert.match(view.subtasks[0]!.reason!, /task ended/);
});

test("the start input and the stop action are typed: only the switch, and a subtask id or all", () => {
  const base = { prompt: "go", mode: "agent", model: "m", effort: "default" };
  assert.equal(startInput.safeParse({ ...base, orchestrate: true }).success, true);
  assert.equal(startInput.safeParse({ ...base, orchestrate: "yes" }).success, false);
  assert.equal(startInput.safeParse({ ...base, orchestrate: true, maxSubagents: 50 }).success, false, "the limits are not set from the window");
  const id = "s-20260101-000000-abcdef";
  assert.equal(subagentStopInput.safeParse({ id }).success, true);
  assert.equal(subagentStopInput.safeParse({ id, subtask: "st-0a1b2c" }).success, true);
  for (const bad of [{ id, subtask: "sa-0a1b2c" }, { id, subtask: "../x" }, { id: "x" }, { id, subtask: "st-0a1b2c", extra: 1 }]) assert.equal(subagentStopInput.safeParse(bad).success, false, JSON.stringify(bad));
});
