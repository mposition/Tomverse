import type { Task } from "../contract";

const commandStates = new Set(["started", "completed", "failed", "exited", "timeout", "cancelled", "denied", "error", "unconfirmed"]);
const requestStates = new Set(["intent", "headers", "complete", "interrupted", "failed"]);
const changeKinds = new Set(["create", "update", "delete"]);
const changeStates = new Set(["writing", "applied", "failed", "undone", "not_attempted"]);
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A support report contains execution status and counts rather than conversation or project data. */
export function codeDiagnostics(task: Task, version: string) {
  return JSON.stringify({
    version, taskId: task.id, status: task.status, transport: "tomverse-code-api",
    commands: task.checks.map(({ state, exitCode }) => ({
      state: commandStates.has(state) ? state : "unknown", exitCode: Number.isSafeInteger(exitCode) ? exitCode : undefined,
    })),
    requests: task.transmission.map(({ seq, purpose, state, httpStatus, receipt }) => ({
      seq: count(seq), purpose: purpose === "agent" || purpose === "compact" ? purpose : "unknown",
      state: requestStates.has(state) ? state : "unknown",
      httpStatus: httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599 ? count(httpStatus) : undefined,
      receipt: receipt.status === "held" || receipt.status === "settled" || receipt.status === "released"
        ? { status: receipt.status, credits: count(receipt.credits) }
        : { status: "unknown" },
    })),
    appliedChanges: task.changes.map(({ kind, current }) => ({
      kind: changeKinds.has(kind) ? kind : "unknown", current: changeStates.has(current) ? current : "unknown",
    })),
  }, null, 2);
}
