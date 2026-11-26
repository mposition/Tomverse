import { desktopParallelCopy } from "../../../../locales/desktopParallel";
import type { LaneRow, ScheduleRefusal, ScheduleRun } from "../parallel-contract";

export type ParallelCopy = (typeof desktopParallelCopy)["en"];

export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));

/** The one line that says where a task stands: waiting, running, waiting for approval, or how it ended. */
export function rowStatus(copy: ParallelCopy, row: Pick<LaneRow, "state" | "status" | "waiting" | "outcome">) {
  if (row.state === "queued") return row.waiting === "folder" ? copy.stateQueuedFolder : copy.stateQueuedLimit;
  if (row.state === "done") {
    switch (row.outcome) {
      case "completed": return copy.outcomeCompleted;
      case "failed": return copy.outcomeFailed;
      case "stopped": return copy.outcomeStopped;
      case "approval-timeout": return copy.outcomeApprovalTimeout;
      case "launch-failed": return copy.outcomeLaunchFailed;
      case "crashed": return copy.outcomeCrashed;
      case "cancelled": return copy.outcomeCancelled;
      default: return copy.outcomeUnknown;
    }
  }
  switch (row.status) {
    case "starting": return copy.stateStarting;
    case "stopping": return copy.stateStopping;
    case "approval": return copy.stateApproval;
    case "clarification":
    case "blocked": return copy.stateWaitingInput;
    default: return row.state === "approval" ? copy.stateApproval : copy.stateRunning;
  }
}

export const kindLabel = (copy: ParallelCopy, kind: LaneRow["kind"]) =>
  kind === "foreground" ? copy.kindForeground : kind === "scheduled" ? copy.kindScheduled : copy.kindParallel;

export function runStatus(copy: ParallelCopy, run: Pick<ScheduleRun, "status" | "reason">) {
  const base = {
    queued: copy.runQueued, running: copy.runRunning, awaiting_approval: copy.runAwaiting, completed: copy.runCompleted, failed: copy.runFailed,
    stopped: copy.runStopped, missed: copy.runMissed, skipped: copy.runSkipped,
  }[run.status];
  const reason = run.reason && {
    "approval-timeout": copy.reasonApprovalTimeout, sandbox: copy.reasonSandbox, "no-account": copy.reasonNoAccount, "model-unavailable": copy.reasonModel,
    overlap: copy.reasonOverlap, "launch-failed": copy.reasonLaunch, crashed: copy.reasonCrashed, worktree: copy.reasonWorktree,
    "project-changed": copy.reasonProject, disabled: copy.reasonDisabled,
  }[run.reason];
  return reason ? `${base}: ${reason}` : base;
}

export function refusalText(copy: ParallelCopy, reason: ScheduleRefusal) {
  return ({
    disabled: copy.refuseDisabled, "needs-acknowledgement": copy.refuseAck, "no-project": copy.refuseNoProject, "no-account": copy.refuseNoAccount,
    past: copy.refusePast, "time-zone": copy.refuseZone, "needs-agent": copy.refuseAgent, "needs-worktree": copy.refuseWorktree,
    "needs-sandbox": copy.refuseSandbox, "needs-git": copy.refuseGit, "model-unavailable": copy.refuseModel, "too-many": copy.refuseTooMany,
    "not-found": copy.refuseNotFound, busy: copy.refuseBusy, "busy-schedule": copy.refuseBusy, invalid: copy.refuseInvalid,
  } satisfies Record<ScheduleRefusal, string>)[reason];
}

export const timeText = (instant: number | undefined, language: string, timeZone?: string) =>
  instant === undefined ? "—" : new Date(instant).toLocaleString(language, { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
