import { randomUUID } from "node:crypto";
import type { ScheduleItem, ScheduleRun } from "../parallel-contract";
import { createManagedWorktree, readGitProject } from "./git-worktree";
import type { HistoryScope } from "./history-scope";
import { hasCredential } from "./journal-view";
import type { Connection } from "./messages";
import { assertProjectRoot, bindProjectRoot, type ProjectRoot } from "./project-root";
import type { LaunchOutcome } from "./schedule-engine";
import type { TaskLanes } from "./task-lanes";

/**
 * Starts a scheduled run as a lane: binds the schedule's project folder again (it may have moved since the schedule was saved), makes a
 * new worktree when the schedule asks for one, and hands the lane its own permission mode and request cap. The run's mode is the
 * schedule's, fixed at save time and checked again by the engine; nothing here reads it from the model.
 */

export type ScheduleLaunchEnv = {
  protectedRoot: string;
  connection(): Connection | null;
  /** The history scope of a project for the signed-in account. */
  scopeFor(project: ProjectRoot): HistoryScope | null;
  worktreeHome(scope: HistoryScope): string;
  permissionHome(): string;
  modelAvailable(model: string): boolean;
};

export async function launchScheduledRun(env: ScheduleLaunchEnv, item: ScheduleItem, run: ScheduleRun, lanes: TaskLanes, approvalWaitMs: number): Promise<LaunchOutcome> {
  const connection = env.connection();
  if (!connection) return { ok: false, reason: "no-account" };
  if (!env.modelAvailable(item.model)) return { ok: false, reason: "model-unavailable" };
  if (hasCredential(item.prompt, connection.key)) return { ok: false, reason: "launch-failed" };
  let source: ProjectRoot;
  try {
    source = bindProjectRoot(item.project);
    assertProjectRoot(source);
  } catch { return { ok: false, reason: "project-changed" }; }
  const scope = env.scopeFor(source);
  if (!scope) return { ok: false, reason: "no-account" };
  let project = source;
  let taskScope = scope;
  let worktree;
  if (item.workspace === "worktree") {
    try {
      const git = await readGitProject(source);
      if (!git || git === "unavailable") return { ok: false, reason: "worktree" };
      const created = await createManagedWorktree(source, git, env.worktreeHome(scope), randomUUID(), git.bases[0]!);
      project = created.project;
      worktree = created.info;
      taskScope = { ...scope, root: project.path };
    } catch { return { ok: false, reason: "worktree" }; }
  }
  try {
    const key = lanes.submit({
      kind: "scheduled", title: `${item.name}`.slice(0, 80), folder: project.path, isolated: item.workspace === "worktree", scheduleId: item.id,
      approvalWaitMs, ...(worktree ? { worktree } : {}),
      permission: { type: "permissions", mode: item.permission, home: env.permissionHome() },
      start: {
        type: "start", runId: run.id, project, scope: taskScope, protectedRoot: env.protectedRoot, connection, references: [], preference: "tomverse_api",
        input: { prompt: item.prompt, mode: item.taskMode, model: item.model, effort: "default", limits: item.limits, saveHistory: true },
      },
    });
    return { ok: true, key };
  } catch { return { ok: false, reason: "launch-failed" }; }
}
