import type { PermissionModeId } from "./permission-contract";
import type { ScheduleRefusal } from "./parallel-contract";

/**
 * The deterministic safety rules of scheduled runs. A scheduled run starts with nobody in front of the screen, so everything that
 * decides whether it may exist or keep running is plain code here, enforced by the main process and never by the model:
 *
 * - A request that needs a person is never answered for them; the run waits and fails when the wait passes its limit.
 * - "Allow all" is only for a run in a new worktree on a computer whose OS sandbox really refuses writes outside the project.
 * - Every schedule has a request cap (never "unlimited"), turns itself off after consecutive failures, and never runs twice at once.
 */

export type SandboxFacts = {
  mode: "off" | "workspace-write" | "read-only";
  /** `sandboxEnforcement(...).available` for that mode on this computer. */
  available: boolean;
  /** `sandboxEnforcement(...).writes`: whether the OS refuses writes outside the allowed folders. */
  writes: "os" | "none";
};

export const sandboxEnforcesWrites = (facts: SandboxFacts) => facts.mode !== "off" && facts.available && facts.writes === "os";

export type ScheduleShape = { taskMode: "ask" | "agent"; permission: PermissionModeId; workspace: "folder" | "worktree" };

/** Why this combination may not be saved or started, or null. */
export function scheduleShapeProblem(shape: ScheduleShape, facts: { sandbox: SandboxFacts; gitProject: boolean }): ScheduleRefusal | null {
  if (shape.workspace === "worktree") {
    if (!facts.gitProject) return "needs-git";
    if (shape.taskMode !== "agent") return "needs-agent";
  }
  if (shape.permission === "allow_all") {
    if (shape.taskMode !== "agent") return "needs-agent";
    if (shape.workspace !== "worktree") return "needs-worktree";
    if (!sandboxEnforcesWrites(facts.sandbox)) return "needs-sandbox";
  }
  return null;
}

/** What a finished run does to the count of consecutive failures. A stop by the person, a miss and a skip change nothing. */
export function failuresAfter(current: number, status: "completed" | "failed" | "stopped" | "missed" | "skipped") {
  if (status === "completed") return 0;
  if (status === "failed") return current + 1;
  return current;
}

export const shouldDisable = (failures: number, limit: number) => failures >= limit;

/** A schedule never runs twice at once: it may start only when none of its own runs is queued, running or waiting for an approval. */
export const mayStartRun = (activeRunsOfSchedule: number) => activeRunsOfSchedule === 0;

/** An unattended request that waited longer than the limit ends its run as a failure. */
export const approvalWaitExpired = (waitingSince: number, now: number, limitMs: number) => now - waitingSince >= limitMs;
