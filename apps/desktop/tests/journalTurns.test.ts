import assert from "node:assert/strict";
import test from "node:test";
import type { SessionState } from "../../tomverse-cli/src/runtime";
import { canRewindJournal, markTurns } from "../src/host/journal-view";
import type { Entry } from "../src/contract";

const mark = (text: string) => ({ kind: "prompt" as const, task: 0, messageIndex: 0, changeStart: 0, toolStart: 0, at: "2026-11-26T00:00:00.000Z", text });
const state = (extra: Partial<SessionState> = {}) => ({
  status: "completed", checkpoints: [mark("fix sum")], tasks: [], changes: [], tools: [], generations: [], pendingApprovals: [], ...extra,
}) as unknown as SessionState;

test("user entries are matched to the turns the session recorded, in order, and other entries stay unmarked", () => {
  const entries: Entry[] = [
    { role: "user", text: "fix sum" }, { role: "assistant", text: "done" },
    { role: "user", text: "[Goal check 1/10] The goal is not verified yet" },
    { role: "user", text: "add notes please" }, { role: "assistant", text: "added" },
  ];
  markTurns(entries, { checkpoints: [mark("fix sum"), mark("add notes")] });
  assert.deepEqual(entries.map((entry) => entry.role === "user" ? entry.turn : "-"), [0, "-", undefined, 1, "-"]);
});

test("the same words sent twice are two turns, matched in order", () => {
  const entries: Entry[] = [{ role: "user", text: "again" }, { role: "user", text: "again" }];
  markTurns(entries, { checkpoints: [mark("again"), mark("again")] });
  assert.deepEqual(entries.map((entry) => entry.role === "user" ? entry.turn : -1), [0, 1]);
});

test("a task without recorded turns marks nothing", () => {
  const entries: Entry[] = [{ role: "user", text: "fix sum" }];
  markTurns(entries, {});
  assert.equal(entries[0]!.role === "user" && entries[0]!.turn, undefined);
});

test("a saved task can be taken back only when it has turns and nothing is running or unknown", () => {
  assert.equal(canRewindJournal(state()), true);
  assert.equal(canRewindJournal(state({ checkpoints: undefined })), undefined);
  assert.equal(canRewindJournal(state({ checkpoints: [] })), undefined);
  assert.equal(canRewindJournal(state({ status: "running" })), undefined);
  assert.equal(canRewindJournal(state({ pendingApprovals: [{ approvalId: "a", toolCallId: "t", toolName: "run_command", input: {} }] })), undefined);
  assert.equal(canRewindJournal(state({ generations: [{ closed: false } as never] })), undefined);
  assert.equal(canRewindJournal(state({ tools: [{ state: "started" } as never] })), undefined);
  assert.equal(canRewindJournal(state({ codeContinuation: { segmentId: "s", maximumKeyCreditCap: 1 } })), undefined);
});
