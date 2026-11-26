import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SCHEDULE_DEFAULT_FAILURE_LIMIT, SCHEDULE_MAX_ITEMS, SCHEDULE_MAX_RUNS, scheduleInput,
  type LaneRow, type ScheduleCommand, type ScheduleInput, type ScheduleItem, type ScheduleRefusal, type ScheduleResult, type ScheduleRun, type ScheduleView,
} from "../parallel-contract";
import { permissionMode } from "../permission-contract";
import { cadence, evaluateSchedule, nextRun, timingProblem } from "../schedule-core";
import { failuresAfter, mayStartRun, scheduleShapeProblem, shouldDisable, type SandboxFacts } from "../schedule-policy";
import type { LaneResult } from "./task-lanes";

/**
 * Scheduled Code runs: the saved schedules and their run records, the timer that starts a run, and the rules for what a run with nobody
 * present may do (schedule-policy.ts). It runs only while the app does: a run that came due while the app was closed is recorded as
 * missed and never made up later. The model has no way in here; schedules change only through `command`, which the Code screen sends.
 */

export const DEFAULT_APPROVAL_WAIT_MINUTES = 30;

const storedItem = z.object({
  id: z.uuid(), name: z.string(), prompt: z.string(),
  timing: z.object({ cadence, timeZone: z.string() }).strict(),
  workspace: z.enum(["folder", "worktree"]), taskMode: z.enum(["ask", "agent"]), permission: permissionMode,
  model: z.string(), limits: z.enum(["standard", "extended"]), project: z.string(),
  enabled: z.boolean(), failures: z.number().int().min(0), disabledBy: z.enum(["failures", "finished"]).optional(),
}).strict();
const storedRun = z.object({
  id: z.uuid(), scheduleId: z.uuid(), name: z.string(), project: z.string(), scheduledFor: z.number(),
  startedAt: z.number().optional(), finishedAt: z.number().optional(),
  status: z.enum(["queued", "running", "awaiting_approval", "completed", "failed", "stopped", "missed", "skipped"]),
  reason: z.enum(["approval-timeout", "sandbox", "no-account", "model-unavailable", "overlap", "launch-failed", "crashed", "worktree", "project-changed", "disabled"]).optional(),
  files: z.object({ count: z.number(), paths: z.array(z.string()) }),
  taskId: z.string().nullable(), laneKey: z.string().optional(),
}).strict();
const storedState = z.object({
  version: z.literal(1), enabled: z.boolean(), lastEvaluated: z.number(), items: z.array(storedItem), runs: z.array(storedRun),
}).strict();
type StoredState = z.infer<typeof storedState>;
type StoredItem = z.infer<typeof storedItem>;

export type LaunchOutcome = { ok: true; key: string } | { ok: false; reason: Extract<ScheduleRun["reason"], "no-account" | "model-unavailable" | "worktree" | "project-changed" | "launch-failed"> };

export type ScheduleEngineDeps = {
  now(): number;
  load(): string | null;
  save(text: string): void;
  /** The OS sandbox as this computer enforces it now (read again at every save and every run). */
  sandbox(): Promise<SandboxFacts>;
  /** Whether the open project is a Git repository, which a new-worktree schedule needs. */
  gitProject(): boolean;
  /** The folder of the open project, or null when none is open. A schedule belongs to the project it was saved in. */
  openProject(): string | null;
  modelAvailable(model: string): boolean;
  hasAccount(): boolean;
  /** Starts the run as a lane (in the folder or a new worktree) and returns its key. The lane's settled result comes back through `settled`. */
  launch(item: ScheduleItem, run: ScheduleRun): Promise<LaunchOutcome>;
  activeFor(scheduleId: string): number;
  rows(): LaneRow[];
  notify(item: ScheduleItem, run: ScheduleRun): void;
  changed(): void;
  failureLimit?: number;
  approvalWaitMinutes?: number;
  persistEveryMs?: number;
};

const emptyState = (): StoredState => ({ version: 1, enabled: false, lastEvaluated: 0, items: [], runs: [] });

export class ScheduleEngine {
  private state: StoredState = emptyState();
  private readonly lanes = new Map<string, string>();
  private readonly starting = new Set<string>();
  private lastPersisted = 0;
  private dirty = false;
  private sandboxFacts: SandboxFacts = { mode: "off", available: false, writes: "none" };

  constructor(private readonly deps: ScheduleEngineDeps) {}

  private get failureLimit() { return this.deps.failureLimit ?? SCHEDULE_DEFAULT_FAILURE_LIMIT; }
  get approvalWaitMinutes() { return this.deps.approvalWaitMinutes ?? DEFAULT_APPROVAL_WAIT_MINUTES; }
  get enabled() { return this.state.enabled; }

  /** Reads the saved state and handles what happened while the app was closed. Call once at start. */
  startup() {
    try {
      const text = this.deps.load();
      if (text) this.state = storedState.parse(JSON.parse(text));
    } catch { this.state = emptyState(); }
    const now = this.deps.now();
    for (const run of this.state.runs) {
      if (run.status === "queued" || run.status === "running" || run.status === "awaiting_approval") {
        run.status = "failed";
        run.reason = "crashed";
        run.finishedAt = now;
      }
    }
    if (this.state.enabled && this.state.lastEvaluated > 0) {
      for (const item of this.state.items) if (item.enabled && !item.disabledBy) this.evaluate(item, this.state.lastEvaluated, now, true);
    }
    this.state.lastEvaluated = now;
    this.persist(true);
  }

  private evaluate(item: StoredItem, from: number, now: number, startup: boolean) {
    const result = evaluateSchedule(item.timing, from, now, { startup });
    for (const missed of result.missed) {
      if (this.state.runs.some((run) => run.scheduleId === item.id && run.scheduledFor === missed)) continue;
      this.addRun(item, missed, { status: "missed", finishedAt: now });
    }
    if (item.timing.cadence.kind === "once" && item.timing.cadence.at <= now && !result.run) {
      item.enabled = false;
      item.disabledBy = "finished";
    }
    return result.run;
  }

  private addRun(item: StoredItem, scheduledFor: number, extra: Partial<ScheduleRun> = {}): ScheduleRun {
    const run: ScheduleRun = { id: randomUUID(), scheduleId: item.id, name: item.name, project: item.project, scheduledFor, status: "queued",
      files: { count: 0, paths: [] }, taskId: null, ...extra };
    this.state.runs.push(run);
    if (this.state.runs.length > SCHEDULE_MAX_RUNS) this.state.runs.splice(0, this.state.runs.length - SCHEDULE_MAX_RUNS);
    this.dirty = true;
    return run;
  }

  /** Called every few seconds while the app runs. */
  async tick() {
    const now = this.deps.now();
    const from = this.state.lastEvaluated;
    this.state.lastEvaluated = now;
    if (this.state.enabled) {
      const due: Array<[StoredItem, number]> = [];
      for (const item of this.state.items) {
        if (!item.enabled || item.disabledBy) continue;
        const scheduled = this.evaluate(item, from, now, false);
        if (scheduled !== null) due.push([item, scheduled]);
      }
      for (const [item, scheduledFor] of due) await this.trigger(item, scheduledFor);
    }
    if (this.dirty || now - this.lastPersisted >= (this.deps.persistEveryMs ?? 60_000)) this.persist();
    if (this.dirty) this.deps.changed();
  }

  /** Writes the state now (quit). */
  shutdown() {
    this.state.lastEvaluated = this.deps.now();
    this.persist(true);
  }

  private persist(force = false) {
    if (!force && !this.dirty && this.deps.now() - this.lastPersisted < (this.deps.persistEveryMs ?? 60_000)) return;
    try { this.deps.save(JSON.stringify(this.state)); this.lastPersisted = this.deps.now(); this.dirty = false; }
    catch { /* A write that fails is tried again at the next change. */ }
  }

  private itemView(item: StoredItem): ScheduleItem {
    const live = item.enabled && !item.disabledBy && this.state.enabled;
    return { ...item, nextRun: live ? nextRun(item.timing, this.deps.now()) : null, running: this.deps.activeFor(item.id) > 0 };
  }

  private async trigger(item: StoredItem, scheduledFor: number): Promise<ScheduleRefusal | null> {
    // A run that is still being started counts as active, so two triggers at once cannot start two runs.
    if (this.starting.has(item.id) || !mayStartRun(this.deps.activeFor(item.id))) {
      this.addRun(item, scheduledFor, { status: "skipped", reason: "overlap", finishedAt: this.deps.now() });
      return "busy-schedule";
    }
    this.starting.add(item.id);
    try { return await this.start(item, scheduledFor); }
    finally { this.starting.delete(item.id); }
  }

  private async start(item: StoredItem, scheduledFor: number): Promise<ScheduleRefusal | null> {
    const facts = { sandbox: await this.refreshSandbox(), gitProject: this.deps.gitProject() };
    const problem = scheduleShapeProblem(item, facts);
    // A project other than the open one cannot be checked for Git here; the launch checks the folder itself.
    const ignorable = problem === "needs-git" && this.deps.openProject() !== item.project;
    if (problem && !ignorable) {
      this.finishRun(item, this.addRun(item, scheduledFor, { status: "failed" }), "failed", problem === "needs-sandbox" ? "sandbox" : "worktree");
      return problem;
    }
    const run = this.addRun(item, scheduledFor);
    this.deps.changed();
    if (!this.deps.hasAccount()) { this.finishRun(item, run, "skipped", "no-account"); return "no-account"; }
    if (!this.deps.modelAvailable(item.model)) { this.finishRun(item, run, "skipped", "model-unavailable"); return "model-unavailable"; }
    let outcome: LaunchOutcome;
    try { outcome = await this.deps.launch(this.itemView(item), run); }
    catch { outcome = { ok: false, reason: "launch-failed" }; }
    if (!outcome.ok) {
      const skipped = outcome.reason === "no-account" || outcome.reason === "model-unavailable" || outcome.reason === "project-changed";
      this.finishRun(item, run, skipped ? "skipped" : "failed", outcome.reason);
      return null;
    }
    run.laneKey = outcome.key;
    this.lanes.set(outcome.key, run.id);
    this.dirty = true;
    return null;
  }

  private finishRun(item: StoredItem, run: ScheduleRun, status: ScheduleRun["status"], reason?: ScheduleRun["reason"], result?: LaneResult) {
    run.status = status;
    if (reason) run.reason = reason;
    run.finishedAt = this.deps.now();
    if (result) {
      run.startedAt = result.startedAt;
      run.taskId = result.task?.id ?? null;
      const changes = result.task?.changes ?? [];
      run.files = { count: changes.length, paths: changes.slice(0, 8).map((change) => change.path.slice(0, 200)) };
    }
    if (status === "completed" || status === "failed" || status === "stopped" || status === "skipped") {
      item.failures = failuresAfter(item.failures, status);
      if (shouldDisable(item.failures, this.failureLimit) && !item.disabledBy) { item.enabled = false; item.disabledBy = "failures"; }
    }
    this.dirty = true;
    this.persist(true);
    this.deps.changed();
    if (status !== "skipped") this.deps.notify(this.itemView(item), run);
  }

  /** A lane of a schedule ended: the run record gets its outcome. */
  settled(result: LaneResult) {
    const runId = this.lanes.get(result.key);
    this.lanes.delete(result.key);
    const run = this.state.runs.find((entry) => entry.id === runId);
    const item = run && this.state.items.find((entry) => entry.id === run.scheduleId);
    if (!run || !item) return;
    if (result.outcome === "completed") this.finishRun(item, run, "completed", undefined, result);
    else if (result.outcome === "stopped" || result.outcome === "cancelled") this.finishRun(item, run, "stopped", undefined, result);
    else if (result.outcome === "approval-timeout") this.finishRun(item, run, "failed", "approval-timeout", result);
    else this.finishRun(item, run, "failed", result.outcome === "launch-failed" ? "launch-failed" : result.outcome === "crashed" ? "crashed" : undefined, result);
  }

  private async refreshSandbox() {
    try { this.sandboxFacts = await this.deps.sandbox(); } catch { this.sandboxFacts = { mode: "off", available: false, writes: "none" }; }
    return this.sandboxFacts;
  }

  async command(command: ScheduleCommand): Promise<ScheduleResult> {
    const refuse = (reason: ScheduleRefusal): ScheduleResult => ({ ok: false, reason });
    if (command.action === "enable") {
      if (command.enabled && command.acknowledged !== true) return refuse("needs-acknowledgement");
      if (command.enabled === this.state.enabled) return { ok: true };
      this.state.enabled = command.enabled;
      // Turning schedules on starts the clock now: what came due while they were off is neither run nor missed.
      this.state.lastEvaluated = this.deps.now();
      return this.done();
    }
    if (command.action === "refresh") { await this.refreshSandbox(); this.deps.changed(); return { ok: true }; }
    if (command.action === "save") return this.save(command.input);
    const item = this.state.items.find((entry) => entry.id === command.id);
    if (!item) return refuse("not-found");
    if (command.action === "delete") {
      if (this.deps.activeFor(item.id) > 0) return refuse("busy-schedule");
      this.state.items = this.state.items.filter((entry) => entry !== item);
      return this.done();
    }
    if (command.action === "toggle") {
      if (command.enabled) {
        const problem = await this.problem(item);
        if (problem) return refuse(problem);
        item.enabled = true;
        item.failures = 0;
        item.disabledBy = undefined;
      } else item.enabled = false;
      return this.done();
    }
    if (!this.state.enabled) return refuse("disabled");
    const problem = await this.problem(item, true);
    if (problem) return refuse(problem);
    if (this.starting.has(item.id) || !mayStartRun(this.deps.activeFor(item.id))) return refuse("busy-schedule");
    void this.trigger(item, this.deps.now()).then(() => this.deps.changed());
    return { ok: true };
  }

  private async problem(item: StoredItem | ScheduleInput, running = false): Promise<ScheduleRefusal | null> {
    const stored = "project" in item ? item : null;
    const timing = "timing" in item ? item.timing : null;
    if (timing && !running) {
      const bad = timingProblem(timing, this.deps.now());
      if (bad) return bad;
    }
    const facts = { sandbox: await this.refreshSandbox(), gitProject: this.deps.gitProject() };
    const problem = scheduleShapeProblem(item, facts);
    if (problem === "needs-git" && stored && this.deps.openProject() !== stored.project) return null;
    return problem;
  }

  private async save(raw: ScheduleInput): Promise<ScheduleResult> {
    const parsed = scheduleInput.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const input = parsed.data;
    const existing = input.id ? this.state.items.find((entry) => entry.id === input.id) : undefined;
    if (input.id && !existing) return { ok: false, reason: "not-found" };
    if (!existing && this.state.items.length >= SCHEDULE_MAX_ITEMS) return { ok: false, reason: "too-many" };
    const project = existing?.project ?? this.deps.openProject();
    if (!project) return { ok: false, reason: "no-project" };
    if (!this.deps.hasAccount()) return { ok: false, reason: "no-account" };
    if (!this.deps.modelAvailable(input.model)) return { ok: false, reason: "model-unavailable" };
    const bad = timingProblem(input.timing, this.deps.now());
    if (bad) return { ok: false, reason: bad };
    const facts = { sandbox: await this.refreshSandbox(), gitProject: this.deps.gitProject() };
    const problem = scheduleShapeProblem(input, facts);
    if (problem && !(problem === "needs-git" && existing && this.deps.openProject() !== project)) return { ok: false, reason: problem };
    const fields = { name: input.name, prompt: input.prompt, timing: input.timing, workspace: input.workspace, taskMode: input.taskMode,
      permission: input.permission, model: input.model, limits: input.limits };
    if (existing) {
      if (this.deps.activeFor(existing.id) > 0) return { ok: false, reason: "busy-schedule" };
      Object.assign(existing, fields, { failures: 0 });
      if (existing.disabledBy === "finished") { existing.enabled = true; existing.disabledBy = undefined; }
    } else {
      this.state.items.push({ id: randomUUID(), ...fields, project, enabled: true, failures: 0 });
    }
    return this.done();
  }

  private done(): ScheduleResult {
    this.dirty = true;
    this.persist(true);
    this.deps.changed();
    return { ok: true };
  }

  view(): ScheduleView {
    const rows = new Map(this.deps.rows().map((row) => [row.key, row]));
    const runs = this.state.runs.map((run): ScheduleRun => {
      const row = run.laneKey ? rows.get(run.laneKey) : undefined;
      if (!row || (run.status !== "queued" && run.status !== "running" && run.status !== "awaiting_approval")) return run;
      return { ...run, startedAt: row.startedAt ?? run.startedAt, taskId: row.taskId ?? run.taskId,
        status: row.state === "queued" ? "queued" : row.state === "approval" ? "awaiting_approval" : "running" };
    });
    return {
      enabled: this.state.enabled, failureLimit: this.failureLimit, approvalWaitMinutes: this.approvalWaitMinutes,
      items: this.state.items.map((item) => this.itemView(item)),
      runs: runs.slice().reverse(),
      sandboxEnforced: this.sandboxFacts.mode !== "off" && this.sandboxFacts.available && this.sandboxFacts.writes === "os",
      gitProject: this.deps.gitProject(),
    };
  }

  /** The sandbox facts for the form, read fresh. */
  async refresh() {
    await this.refreshSandbox();
  }
}
