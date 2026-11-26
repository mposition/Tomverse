import assert from "node:assert/strict";
import test from "node:test";
import type { SessionState } from "../../tomverse-cli/src/runtime";
import { journalEngine, journalSubagents } from "../src/host/journal-view";

const run = (id: string, state: NonNullable<SessionState["subagents"]>[number]["state"], extra: Partial<NonNullable<SessionState["subagents"]>[number]> = {}) => ({
  id, toolCallId: `call_${id}`, kind: "explore" as const, task: `look at ${id}`, state, requests: 2, startedAt: "2026-11-26T00:00:00.000Z", epoch: "e1", ...extra,
});
const session = (status: SessionState["status"], subagents?: SessionState["subagents"]) => ({ status, subagents, tasks: [], limits: {} }) as unknown as SessionState;

test("a session without subagents shows none", () => {
  assert.equal(journalSubagents(session("completed")), undefined);
  assert.equal(journalSubagents(session("completed", [])), undefined);
});

test("subagent rows carry the task, kind, requests and a cleaned report, never a credential", () => {
  const key = "tvk_abcdefgh_" + "A".repeat(43);
  const rows = journalSubagents(session("running", [
    run("sa-000001", "completed", { summary: `found it, key ${key}` }),
    run("sa-000002", "running", { kind: "worker" }),
  ]), key)!;
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.state, row.requests]), [["sa-000001", "explore", "completed", 2], ["sa-000002", "worker", "running", 2]]);
  assert.ok(!JSON.stringify(rows).includes(key));
  assert.match(rows[0]!.summary!, /credential removed/);
});

test("a run still marked running in a session that is not running is one whose result is not known", () => {
  const rows = journalSubagents(session("cancelled", [run("sa-000003", "running")]))!;
  assert.equal(rows[0]!.state, "unknown");
  assert.equal(journalEngine(session("unknown_outcome", [run("sa-000004", "running")])).subagents![0]!.state, "unknown");
});

test("only the newest dozen runs are listed", () => {
  const many = Array.from({ length: 20 }, (_, index) => run(`sa-${String(index).padStart(6, "0")}`, "completed"));
  const rows = journalSubagents(session("completed", many))!;
  assert.equal(rows.length, 12);
  assert.equal(rows.at(-1)!.id, "sa-000019");
});
