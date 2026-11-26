import { z } from "zod";
import { cadence, type Timing } from "./schedule-core";
import { permissionMode, type PermissionModeId } from "./permission-contract";
import type { RunStatus, Task } from "./contract";

/**
 * Parallel Code tasks and scheduled runs, as the Code screen sees them. The renderer only sends these typed commands and never a folder
 * path, a process id or an approval answer for a task: the main process looks every task up by its own key, and the schedule is built
 * from the folder the person has open. Nothing the model writes can send one of these commands.
 */

export const PARALLEL_DEFAULT_LIMIT = 3;
export const PARALLEL_MAX_LIMIT = 6;
export const SCHEDULE_MAX_ITEMS = 20;
export const SCHEDULE_MAX_RUNS = 200;
export const SCHEDULE_DEFAULT_FAILURE_LIMIT = 3;

const laneKey = z.uuid();

export const parallelCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stop"), key: laneKey }).strict(),
  /** The tasks whose full view the window shows now (an opened task, a split view); at most two. */
  z.object({ action: z.literal("observe"), keys: z.array(laneKey).max(2) }).strict(),
  z.object({ action: z.literal("detach"), key: laneKey }).strict(),
  z.object({ action: z.literal("set-limit"), limit: z.number().int().min(1).max(PARALLEL_MAX_LIMIT) }).strict(),
  /** Shows the approval card of a task that waits unattended (a scheduled run does not open one by itself). */
  z.object({ action: z.literal("review-approval"), key: laneKey }).strict(),
  z.object({ action: z.literal("dismiss"), key: laneKey }).strict(),
]);
export type ParallelCommand = z.infer<typeof parallelCommand>;

export type LaneKind = "foreground" | "parallel" | "scheduled";
export type LaneOutcome = "completed" | "failed" | "stopped" | "unknown" | "approval-timeout" | "launch-failed" | "crashed" | "cancelled";
export type LaneRow = {
  key: string;
  kind: LaneKind;
  title: string;
  folder: string;
  isolated: boolean;
  state: "queued" | "running" | "approval" | "done";
  status: RunStatus | "queued";
  /** Why a queued task waits. */
  waiting?: "limit" | "folder";
  /** The newest line of what the task said or did. */
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  taskId: string | null;
  scheduleId?: string;
  changes: number;
  approvals: number;
  /** An approval waits that no card shows yet (a scheduled run). */
  unattendedApproval: boolean;
  outcome?: LaneOutcome;
  canStop: boolean;
};

export type ParallelView = {
  limit: number;
  maximum: number;
  rows: LaneRow[];
  /** The full task of each observed lane (see the observe command), by key. */
  tasks: Record<string, Task>;
};

/** What a task's own window may read: its task and its row, and nothing about any other task. */
export type TaskWindowView = { row: LaneRow | null; task: Task | null; language: import("../../../lib/language").Language };

export const scheduleInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(24_000),
  timing: z.object({ cadence, timeZone: z.string().min(1).max(64) }).strict(),
  workspace: z.enum(["folder", "worktree"]),
  taskMode: z.enum(["ask", "agent"]),
  permission: permissionMode,
  model: z.string().min(1).max(240),
  /** Never "unlimited": a scheduled run always has a request cap. */
  limits: z.enum(["standard", "extended"]),
}).strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;

export const scheduleCommand = z.discriminatedUnion("action", [
  /** Turning schedules on needs `acknowledged: true`, which the screen sends after the person reads that runs start without anyone present. */
  z.object({ action: z.literal("enable"), enabled: z.boolean(), acknowledged: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("save"), input: scheduleInput }).strict(),
  z.object({ action: z.literal("delete"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("toggle"), id: z.uuid(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("run-now"), id: z.uuid() }).strict(),
  /** Reads the OS sandbox and the Git state again for the form. */
  z.object({ action: z.literal("refresh") }).strict(),
]);
export type ScheduleCommand = z.infer<typeof scheduleCommand>;

export type ScheduleRefusal =
  | "disabled" | "needs-acknowledgement" | "no-project" | "no-account" | "past" | "time-zone" | "needs-agent" | "needs-worktree" | "needs-sandbox"
  | "needs-git" | "model-unavailable" | "too-many" | "not-found" | "busy" | "invalid" | "busy-schedule";
export type ScheduleResult = { ok: true } | { ok: false; reason: ScheduleRefusal };

export type ScheduleItem = {
  id: string;
  name: string;
  prompt: string;
  timing: Timing;
  workspace: "folder" | "worktree";
  taskMode: "ask" | "agent";
  permission: PermissionModeId;
  model: string;
  limits: "standard" | "extended";
  project: string;
  enabled: boolean;
  /** Consecutive failed runs; the schedule turns itself off at the limit. */
  failures: number;
  disabledBy?: "failures" | "finished";
  nextRun: number | null;
  running: boolean;
};

export type ScheduleRunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "stopped" | "missed" | "skipped";
export type ScheduleRun = {
  id: string;
  scheduleId: string;
  name: string;
  project: string;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  status: ScheduleRunStatus;
  reason?: "approval-timeout" | "sandbox" | "no-account" | "model-unavailable" | "overlap" | "launch-failed" | "crashed" | "worktree" | "project-changed" | "disabled";
  files: { count: number; paths: string[] };
  taskId: string | null;
  laneKey?: string;
};

export type ScheduleView = {
  enabled: boolean;
  failureLimit: number;
  approvalWaitMinutes: number;
  items: ScheduleItem[];
  runs: ScheduleRun[];
  /** The OS sandbox refuses writes outside the project here, which "allow all" needs. */
  sandboxEnforced: boolean;
  /** The open project is a Git repository, which a new-worktree schedule needs. */
  gitProject: boolean;
};
