import type { ApprovalRequest, CodeWorktree, Decision, RunStatus, Task } from "../contract";
import type { AgentGitAction, AgentGitResult } from "../git-actions-contract";
import type { LaneKind, LaneOutcome, LaneRow } from "../parallel-contract";
import { approvalWaitExpired } from "../schedule-policy";
import { desktopCodeNotice } from "./desktop-notice";
import type { WorkerCommand, WorkerEvent } from "./messages";

/**
 * Tasks that run next to the open one. Each lane is one task in one runtime process of its own (the runtime keeps one run per process),
 * so a lane that fails, hangs or crashes cannot touch another lane or the open task. This file holds the rules and no Electron:
 * how many run at once (the rest wait), that two tasks never write the same folder, that every approval belongs to the lane that asked
 * for it, and that a scheduled run never answers a request on a person's behalf. Processes come in through `spawn`, the clock through `now`.
 */

export interface LaneProcess {
  postMessage(message: WorkerCommand): void;
  onMessage(listener: (event: WorkerEvent) => void): void;
  onExit(listener: () => void): void;
  kill(): void;
}

type StartCommand = Extract<WorkerCommand, { type: "start" }>;
type PermissionMessage = Extract<WorkerCommand, { type: "permissions" }>;

export type LaneSpec = {
  kind: Exclude<LaneKind, "foreground">;
  title: string;
  /** The folder the task writes (its worktree, or the project folder); two tasks never run in the same one. */
  folder: string;
  isolated: boolean;
  /** The managed worktree the task runs in, shown on its task (the runtime does not know it). */
  worktree?: CodeWorktree;
  /** `start.runId` is the lane's key: events and answers that carry another run id never reach this lane. */
  start: StartCommand;
  /** A mode that belongs to this lane (a scheduled run). Without one the lane follows the mode the person chose in the app. */
  permission?: PermissionMessage;
  scheduleId?: string;
  /** Unattended: an approval waits this long, then the run fails. */
  approvalWaitMs?: number;
};

export type LaneResult = {
  key: string; spec: LaneSpec; outcome: LaneOutcome; task: Task | null; startedAt?: number; finishedAt: number; reason?: "approval-timeout";
};

type Approval = {
  id: string; key: string; request: ApprovalRequest; since: number; order: number;
  settle: (action: Decision["action"]) => void;
};

type Lane = {
  key: string; spec: LaneSpec; state: "queued" | "running" | "done"; process?: LaneProcess; task: Task | null;
  approvals: Approval[]; startedAt?: number; finishedAt?: number; outcome?: LaneOutcome;
  stopRequestedAt?: number; expired?: boolean; waitingSince?: number; order: number;
};

export type LaneDeps = {
  spawn(): LaneProcess;
  now(): number;
  limit(): number;
  /** Runs the open task (not a lane) holds: they count toward the limit and hold their folder. */
  external(): Array<{ folder: string }>;
  /** The permission message for lanes that follow the person's mode, or undefined when the runtime has none yet. */
  permissionMessage(): PermissionMessage | undefined;
  changed(): void;
  settled?(result: LaneResult): void;
  /** An agent's commit or push from a lane: `ask` puts the approval card in the shared queue under this lane's name. */
  gitAction?(lane: { key: string; folder: string; title: string; isolated: boolean; project: StartCommand["project"] }, action: AgentGitAction,
    ask: (request: ApprovalRequest) => Promise<Decision["action"]>): Promise<AgentGitResult>;
};

/** How long a stopped task gets to end by itself before its process is killed. */
export const STOP_GRACE_MS = 10_000;
const KEEP_FINISHED = 30;
const MAX_QUEUED = 20;

const folderKey = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
};

function outcomeOf(status: RunStatus): LaneOutcome {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  return "unknown";
}

function lastSaid(task: Task | null) {
  for (const entry of [...(task?.entries ?? [])].reverse()) if (entry.role !== "user" && entry.role !== "plan" && entry.text.trim()) return entry.text;
  return "";
}

export class TaskLanes {
  private readonly lanes = new Map<string, Lane>();
  private sequence = 0;
  private pumping = false;
  private closed = false;
  private observed = new Set<string>();
  private readonly revealed = new Set<string>();

  constructor(private readonly deps: LaneDeps) {}

  /** Adds a task. It starts at once when there is room and its folder is free, and waits in the queue otherwise. */
  submit(spec: LaneSpec): string {
    const key = spec.start.runId;
    if (this.closed || this.lanes.has(key)) throw new Error("This task cannot start.");
    this.lanes.set(key, { key, spec, state: "queued", task: null, approvals: [], order: this.sequence++ });
    this.pump();
    this.deps.changed();
    return key;
  }

  private running() {
    return [...this.lanes.values()].filter((lane) => lane.state === "running");
  }

  private occupied() {
    return [...this.running().map((lane) => lane.spec.folder), ...this.deps.external().map((entry) => entry.folder)].map(folderKey);
  }

  private full() {
    return this.running().length + this.deps.external().length >= this.deps.limit();
  }

  private pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.full()) break;
        const busy = new Set(this.occupied());
        const next = [...this.lanes.values()].filter((lane) => lane.state === "queued").sort((a, b) => a.order - b.order)
          .find((lane) => !busy.has(folderKey(lane.spec.folder)));
        if (!next) break;
        this.launch(next);
      }
    } finally { this.pumping = false; }
  }

  private launch(lane: Lane) {
    lane.state = "running";
    lane.startedAt = this.deps.now();
    try {
      const child = this.deps.spawn();
      lane.process = child;
      child.onMessage((event) => this.onEvent(lane, event));
      child.onExit(() => this.onExit(lane));
      const permission = lane.spec.permission ?? this.deps.permissionMessage();
      if (permission) child.postMessage(permission);
      child.postMessage(lane.spec.start);
    } catch {
      this.finish(lane, null, "launch-failed");
    }
  }

  private onEvent(lane: Lane, event: WorkerEvent) {
    if (lane.state !== "running" || !("runId" in event) || event.runId !== lane.key) return;
    if (event.type === "task") {
      lane.task = this.shaped(lane, event.task);
    } else if (event.type === "approval") {
      if (lane.stopRequestedAt !== undefined) return;
      const request = event.request;
      this.addApproval(lane, request, (action) => {
        try { lane.process?.postMessage({ type: "answer", runId: lane.key, decision: { id: request.id, action } }); }
        catch { /* The runtime ended; the exit handler finishes the lane. */ }
      });
    } else if (event.type === "finished") {
      this.finish(lane, this.shaped(lane, event.task));
    } else if (event.type === "git-action") {
      void this.runGit(lane, event);
    }
    this.deps.changed();
  }

  private shaped(lane: Lane, task: Task): Task {
    const worktree = lane.spec.worktree;
    return worktree && worktree.path === task.root ? { ...task, worktree } : task;
  }

  private async runGit(lane: Lane, event: Extract<WorkerEvent, { type: "git-action" }>) {
    let result: AgentGitResult = { status: "error" };
    if (this.deps.gitAction) {
      try { result = await this.deps.gitAction({ key: lane.key, folder: lane.spec.folder, title: lane.spec.title, isolated: lane.spec.isolated, project: lane.spec.start.project }, event.action, (request) => this.ask(lane, request)); }
      catch { result = { status: "error" }; }
    }
    if (lane.state !== "running") return;
    try { lane.process?.postMessage({ type: "git-action-result", runId: lane.key, requestId: event.requestId, result }); }
    catch { /* The runtime ended before the reply. */ }
  }

  private onExit(lane: Lane) {
    if (lane.state !== "running") return;
    const task: Task = lane.task ? { ...lane.task, entries: [...lane.task.entries] } : {
      id: null, root: lane.spec.folder, title: lane.spec.title, status: "unknown", entries: [], changes: [], checks: [], transmission: [],
    };
    task.status = "unknown";
    task.streamingAnswer = undefined;
    task.entries.push(desktopCodeNotice("processExited"));
    this.finish(lane, task, "crashed");
  }

  private addApproval(lane: Lane, request: ApprovalRequest, settle: (action: Decision["action"]) => void) {
    const labelled: ApprovalRequest = { ...request, task: { title: lane.spec.title, folder: lane.spec.folder, kind: lane.spec.kind } };
    const now = this.deps.now();
    lane.approvals.push({ id: request.id, key: lane.key, request: labelled, since: now, order: this.sequence++, settle });
    lane.waitingSince ??= now;
    return labelled;
  }

  private ask(lane: Lane, request: ApprovalRequest) {
    return new Promise<Decision["action"]>((resolve) => {
      if (lane.state !== "running" || lane.stopRequestedAt !== undefined) { resolve("deny"); return; }
      this.addApproval(lane, request, resolve);
      this.deps.changed();
    });
  }

  private denyAll(lane: Lane) {
    const pending = lane.approvals;
    lane.approvals = [];
    lane.waitingSince = undefined;
    for (const approval of pending) approval.settle("deny");
  }

  private finish(lane: Lane, task: Task | null, outcome?: LaneOutcome) {
    if (lane.state === "done") return;
    const wasQueued = lane.state === "queued";
    const timedOut = lane.expired === true;
    this.denyAll(lane);
    this.revealed.delete(lane.key);
    lane.state = "done";
    lane.finishedAt = this.deps.now();
    if (task) lane.task = task;
    lane.outcome = timedOut ? "approval-timeout" : outcome ?? (task ? outcomeOf(task.status) : "cancelled");
    const child = lane.process;
    lane.process = undefined;
    if (child && !wasQueued) { try { child.kill(); } catch { /* Already gone. */ } }
    const finished = [...this.lanes.values()].filter((entry) => entry.state === "done").sort((a, b) => a.order - b.order);
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.lanes.delete(old.key);
    this.pump();
    this.deps.changed();
    this.deps.settled?.({ key: lane.key, spec: lane.spec, outcome: lane.outcome, task: lane.task, startedAt: lane.startedAt, finishedAt: lane.finishedAt,
      ...(timedOut ? { reason: "approval-timeout" as const } : {}) });
  }

  /** Stops a running task (it ends through its own runtime) or drops a queued one. */
  stop(key: string) {
    const lane = this.lanes.get(key);
    if (!lane || lane.state === "done") return false;
    if (lane.state === "queued") { this.finish(lane, null, "cancelled"); return true; }
    if (lane.stopRequestedAt !== undefined) return true;
    lane.stopRequestedAt = this.deps.now();
    this.denyAll(lane);
    if (lane.task) lane.task = { ...lane.task, status: "stopping", streamingAnswer: undefined };
    try { lane.process?.postMessage({ type: "stop", runId: lane.key }); }
    catch { this.finish(lane, lane.task, "stopped"); }
    this.deps.changed();
    return true;
  }

  stopAll() {
    for (const lane of [...this.lanes.values()]) this.stop(lane.key);
  }

  /** Quit: ends every lane process now. A task that was running is left as the saved history says (stopped or unknown). */
  shutdown() {
    this.closed = true;
    for (const lane of this.lanes.values()) {
      const child = lane.process;
      lane.process = undefined;
      if (lane.state !== "done") lane.state = "done";
      for (const approval of lane.approvals) approval.settle("deny");
      lane.approvals = [];
      try { child?.kill(); } catch { /* Already gone. */ }
    }
  }

  /** The person's permission mode changed: every lane that follows it hears the new one. */
  permissionChanged() {
    const message = this.deps.permissionMessage();
    if (!message) return;
    for (const lane of this.running()) {
      if (lane.spec.permission) continue;
      try { lane.process?.postMessage(message); } catch { /* The runtime ended. */ }
    }
  }

  /**
   * An answer from the approval window. It reaches only the lane that asked: the request id is the key, and the lane posts it under its own run id.
   * "Allow for this run" is refused for a request that cannot be remembered.
   */
  decide(decision: Decision) {
    for (const lane of this.lanes.values()) {
      const approval = lane.approvals.find((entry) => entry.id === decision.id);
      if (!approval) continue;
      if (lane.state !== "running" || (decision.action === "run" && !approval.request.canRemember)) return false;
      lane.approvals = lane.approvals.filter((entry) => entry !== approval);
      if (!lane.approvals.length) lane.waitingSince = undefined;
      approval.settle(decision.action);
      this.deps.changed();
      return true;
    }
    return false;
  }

  /** The next card for the window: the oldest request whose card may open (a scheduled run's waits until the person asks for it). */
  nextApproval(): ApprovalRequest | null {
    return this.openApprovals()[0]?.request ?? null;
  }

  private openApprovals() {
    return [...this.lanes.values()].filter((lane) => lane.spec.kind !== "scheduled" || this.revealed.has(lane.key))
      .flatMap((lane) => lane.approvals).sort((a, b) => a.order - b.order);
  }

  /** The person asked to see the waiting request of a task. */
  reveal(key: string) {
    const lane = this.lanes.get(key);
    if (!lane || lane.state !== "running" || !lane.approvals.length) return false;
    this.revealed.add(key);
    this.deps.changed();
    return true;
  }

  /** The window closed without an answer: the request it showed is denied. */
  denyId(id: string) {
    return this.decide({ id, action: "deny" });
  }

  hasApproval(id: string) {
    return [...this.lanes.values()].some((lane) => lane.approvals.some((approval) => approval.id === id));
  }

  /** The lane a waiting request belongs to (remote control reports the card with its task). */
  approvalKey(id: string): string | null {
    return [...this.lanes.values()].find((lane) => lane.approvals.some((approval) => approval.id === id))?.key ?? null;
  }

  /** Called about once a second: fails scheduled runs whose request waited too long, and kills a stopped task that did not end. */
  tick() {
    this.pump();
    const now = this.deps.now();
    for (const lane of [...this.lanes.values()]) {
      if (lane.state !== "running") continue;
      if (lane.stopRequestedAt !== undefined) {
        if (now - lane.stopRequestedAt >= STOP_GRACE_MS) this.finish(lane, lane.task ? { ...lane.task, status: "stopped" } : null, "stopped");
        continue;
      }
      const limit = lane.spec.approvalWaitMs;
      if (limit !== undefined && lane.waitingSince !== undefined && approvalWaitExpired(lane.waitingSince, now, limit)) {
        lane.expired = true;
        this.stop(lane.key);
      }
    }
  }

  observe(keys: string[]) {
    this.observed = new Set(keys.filter((key) => this.lanes.has(key)));
  }

  dismiss(key: string) {
    const lane = this.lanes.get(key);
    if (!lane || lane.state !== "done") return false;
    this.lanes.delete(key);
    this.observed.delete(key);
    this.revealed.delete(key);
    this.deps.changed();
    return true;
  }

  /** Whether a task (a lane, or the open one) may start in a folder now. */
  folderBusy(folder: string) {
    return this.occupied().includes(folderKey(folder));
  }

  /** The open task may start only when a slot is free: lanes and the open task share the limit. */
  hasRoomForOpenTask() {
    return this.running().length + 1 <= this.deps.limit();
  }

  /** A new task may join the queue: it is bounded so a runaway caller cannot pile up work. */
  mayQueue() {
    return [...this.lanes.values()].filter((lane) => lane.state === "queued").length < MAX_QUEUED;
  }

  runningCount() {
    return this.running().length;
  }

  /** Lanes still queued or running: the app waits for them before it quits. */
  busy() {
    return [...this.lanes.values()].some((lane) => lane.state !== "done");
  }

  activeFor(scheduleId: string) {
    return [...this.lanes.values()].filter((lane) => lane.spec.scheduleId === scheduleId && lane.state !== "done").length;
  }

  info(key: string) {
    const lane = this.lanes.get(key);
    return lane && { state: lane.state, outcome: lane.outcome, task: lane.task, hasApproval: lane.approvals.length > 0 };
  }

  task(key: string) {
    return this.lanes.get(key)?.task ?? null;
  }

  rows(): LaneRow[] {
    return [...this.lanes.values()].sort((a, b) => a.order - b.order).map((lane): LaneRow => {
      const approvals = lane.approvals.length;
      const state = lane.state === "done" ? "done" : lane.state === "queued" ? "queued" : approvals ? "approval" : "running";
      const first = lane.approvals[0]?.request;
      const text = first ? `${first.tool}${first.command ? `: ${first.command.display}` : ""}`
        : lastSaid(lane.task);
      const busy = new Set(this.occupied());
      return {
        key: lane.key, kind: lane.spec.kind, title: lane.spec.title, folder: lane.spec.folder, isolated: lane.spec.isolated, state,
        status: lane.state === "queued" ? "queued" : lane.task?.status ?? "starting",
        ...(lane.state === "queued" ? { waiting: this.full() ? "limit" as const : busy.has(folderKey(lane.spec.folder)) ? "folder" as const : "limit" as const } : {}),
        ...(text ? { detail: text.replace(/\s+/g, " ").trim().slice(0, 160) } : {}),
        ...(lane.startedAt !== undefined ? { startedAt: lane.startedAt } : {}),
        ...(lane.finishedAt !== undefined ? { finishedAt: lane.finishedAt } : {}),
        taskId: lane.task?.id ?? null,
        ...(lane.spec.scheduleId ? { scheduleId: lane.spec.scheduleId } : {}),
        changes: lane.task?.changes.length ?? 0, approvals,
        unattendedApproval: lane.spec.kind === "scheduled" && approvals > 0 && !this.revealed.has(lane.key),
        ...(lane.outcome ? { outcome: lane.outcome } : {}),
        canStop: lane.state !== "done" && lane.stopRequestedAt === undefined,
      };
    });
  }

  observedTasks(): Record<string, Task> {
    const tasks: Record<string, Task> = {};
    for (const key of this.observed) {
      const task = this.lanes.get(key)?.task;
      if (task) tasks[key] = task;
    }
    return tasks;
  }
}
