import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../src/contract";
import { codeDiagnostics } from "../src/host/code-diagnostics";

test("Code diagnostics excludes draft text, filesystem paths, model response and free-form status fields", () => {
  const task: Task = {
    id: "s-20261122-132208-012abc", root: "private-folder", title: "private-title", status: "completed",
    model: "private-model-id", entries: [{ role: "user", text: "private-prompt" }, { role: "assistant", text: "private-answer" }],
    checks: [{ id: "private-tool-id", tool: "run_command", state: "exited", exitCode: 7 }, { id: "a", tool: "b", state: "private-state" }],
    changes: [{ id: "private-change-id", path: "private-file", kind: "update", current: "applied" }],
    transmission: [{ segmentId: "private-segment", requestId: "private-request", seq: 1, purpose: "agent",
      state: "complete", httpStatus: 200, receipt: { status: "settled", credits: 3 },
      contents: { projectInstructions: true, messageCount: 2, toolResultCount: 1, moreFileReads: 0, fileReads: [{ path: "private-read-path", truncated: false }] } }],
  };
  const report = codeDiagnostics(task, "0.1.0");
  assert.doesNotMatch(report, /private-/);
  assert.deepEqual(JSON.parse(report), {
    version: "0.1.0", taskId: task.id, status: "completed", transport: "tomverse-code-api",
    commands: [{ state: "exited", exitCode: 7 }, { state: "unknown" }],
    requests: [{ seq: 1, purpose: "agent", state: "complete", httpStatus: 200, receipt: { status: "settled", credits: 3 } }],
    appliedChanges: [{ kind: "update", current: "applied" }],
  });
});
