import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowserWindow, ipcMain, Notification } from "electron";
import type { Language } from "../../../../lib/language";
import { desktopParallelCopy } from "../../../../locales/desktopParallel";
import type { ApprovalRequest, Decision, RunStatus, Task } from "../contract";
import type { AgentGitAction, AgentGitResult } from "../git-actions-contract";
import {
  PARALLEL_DEFAULT_LIMIT, PARALLEL_MAX_LIMIT, parallelCommand, scheduleCommand,
  type LaneRow, type ParallelView, type ScheduleItem, type TaskWindowView, type ScheduleResult, type ScheduleRun, type ScheduleView,
} from "../parallel-contract";
import type { SandboxFacts } from "../schedule-policy";
import type { WorkerCommand } from "./messages";
import { ScheduleEngine, type LaunchOutcome } from "./schedule-engine";
import { TaskLanes, type LaneProcess, type LaneSpec } from "./task-lanes";

/**
 * The Electron side of parallel tasks and scheduled runs: one runtime process per lane, the clock, the notifications, the windows a
 * task can be moved into, and the two typed IPC commands. The rules live in task-lanes.ts and schedule-engine.ts; main.ts passes in what
 * only it knows (the open task, the account, the project) as plain functions.
 */

export type ParallelEnv = {
  userData: string;
  origin: string;
  /** A test or QA build: schedules are checked every few hundred milliseconds instead of every few seconds. */
  fastClock: boolean;
  fork(): Electron.UtilityProcess;
  permissionMessage(): Extract<WorkerCommand, { type: "permissions" }>;
  language(): Language;
  broadcast(): void;
  /** The task the open window runs, when it runs one: it counts toward the limit and holds its folder. */
  foreground(): { key: string; busy: boolean; folder: string; title: string; status: RunStatus; taskId: string | null; changes: number; detail?: string; startedAt?: number } | null;
  stopForeground(): void;
  /** A task that ran next to the open one ended: its saved history is new to the list. */
  taskSaved(): void;
  /** Shows the next waiting card in the approval window when nothing else is shown. */
  pumpApprovals(): void;
  newWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow;
  gitAction(lane: { key: string; folder: string; title: string; isolated: boolean; project: LaneSpec["start"]["project"] }, action: AgentGitAction, ask: (request: ApprovalRequest) => Promise<Decision["action"]>): Promise<AgentGitResult>;
  schedule: {
    openProject(): string | null;
    gitProject(): boolean;
    hasAccount(): boolean;
    modelAvailable(model: string): boolean;
    sandbox(): Promise<SandboxFacts>;
    launch(item: ScheduleItem, run: ScheduleRun, lanes: TaskLanes, approvalWaitMs: number): Promise<LaunchOutcome>;
  };
};

/** The key of the open task's row while it does not run: it is not a lane, so it has no run id. */
export const IDLE_OPEN_TASK_KEY = "00000000-0000-4000-8000-000000000000";

const limitFile = (env: ParallelEnv) => join(env.userData, "parallel-limit.txt");
const scheduleFile = (env: ParallelEnv) => join(env.userData, "schedules.json");

function readLimit(env: ParallelEnv) {
  try {
    const value = Number(readFileSync(limitFile(env), "utf8").trim());
    if (Number.isInteger(value) && value >= 1 && value <= PARALLEL_MAX_LIMIT) return value;
  } catch { /* A new profile uses the default. */ }
  return PARALLEL_DEFAULT_LIMIT;
}

/** Ends a lane's runtime and everything it started (its commands), by its own process id only. */
function endProcessTree(child: Electron.UtilityProcess) {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      else execFile("pkill", ["-KILL", "-P", String(pid)], () => undefined);
    } catch { /* The process may already be gone. */ }
  }
  child.kill();
}

function adapt(child: Electron.UtilityProcess): LaneProcess {
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => { child.on("message", listener); },
    onExit: (listener) => { child.once("exit", listener); },
    kill: () => endProcessTree(child),
  };
}

export function createParallelHost(env: ParallelEnv) {
  let limit = readLimit(env);
  let timer: ReturnType<typeof setInterval> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const taskUrl = env.origin + "/task";
  const windows = new Map<number, { window: BrowserWindow; key: string }>();

  const lanes: TaskLanes = new TaskLanes({
    spawn: () => adapt(env.fork()),
    now: () => Date.now(),
    limit: () => limit,
    external: () => { const open = env.foreground(); return open?.busy ? [{ folder: open.folder }] : []; },
    permissionMessage: env.permissionMessage,
    changed: () => changed(),
    settled: (result) => { env.taskSaved(); engine.settled(result); },
    gitAction: env.gitAction,
  });

  const engine: ScheduleEngine = new ScheduleEngine({
    now: () => Date.now(),
    load: () => { try { return readFileSync(scheduleFile(env), "utf8"); } catch { return null; } },
    save: (text) => { mkdirSync(dirname(scheduleFile(env)), { recursive: true, mode: 0o700 }); writeFileSync(scheduleFile(env), text, { mode: 0o600 }); },
    sandbox: env.schedule.sandbox,
    gitProject: env.schedule.gitProject,
    openProject: env.schedule.openProject,
    modelAvailable: env.schedule.modelAvailable,
    hasAccount: env.schedule.hasAccount,
    launch: (item, run) => env.schedule.launch(item, run, lanes, engine.approvalWaitMinutes * 60_000),
    activeFor: (id) => lanes.activeFor(id),
    rows: () => lanes.rows(),
    notify: (item, run) => notify(item, run),
    changed: () => changed(),
  });

  function notify(item: ScheduleItem, run: ScheduleRun) {
    if (!Notification.isSupported()) return;
    const copy = desktopParallelCopy[env.language()];
    const text = run.status === "completed" ? copy.notifyCompleted : run.status === "stopped" ? copy.notifyStopped : copy.notifyFailed;
    try { new Notification({ title: "Tomverse Desktop", body: text.replace("{name}", item.name) }).show(); }
    catch { /* Desktop notifications may be unavailable in this OS session. */ }
  }

  function changed() {
    env.pumpApprovals();
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      env.broadcast();
      pushWindows();
    }, 80);
  }

  function parallelView(): ParallelView {
    const open = env.foreground();
    const rows: LaneRow[] = [];
    if (open) {
      const outcome = open.status === "completed" ? "completed" : open.status === "failed" ? "failed" : open.status === "stopped" ? "stopped" : "unknown";
      rows.push({
        key: open.key, kind: "foreground", title: open.title, folder: open.folder, isolated: false,
        state: !open.busy ? "done" : open.status === "approval" ? "approval" : "running", status: open.status, ...(open.detail ? { detail: open.detail } : {}),
        ...(open.startedAt ? { startedAt: open.startedAt } : {}), taskId: open.taskId, changes: open.changes,
        approvals: open.busy && open.status === "approval" ? 1 : 0, unattendedApproval: false, canStop: open.busy && open.status !== "stopping",
        ...(open.busy ? {} : { outcome }),
      });
    }
    return { limit, maximum: PARALLEL_MAX_LIMIT, rows: [...rows, ...lanes.rows()], tasks: lanes.observedTasks() };
  }

  function scheduleView(): ScheduleView { return engine.view(); }

  function windowView(key: string): TaskWindowView {
    const row = lanes.rows().find((entry) => entry.key === key) ?? null;
    return { row, task: lanes.task(key) as Task | null, language: env.language() };
  }

  function pushWindows() {
    for (const [id, entry] of windows) {
      if (entry.window.isDestroyed() || entry.window.webContents.isDestroyed()) { windows.delete(id); continue; }
      entry.window.webContents.send("task-window:changed", windowView(entry.key));
    }
  }

  function detach(key: string) {
    if (!lanes.info(key)) return false;
    for (const entry of windows.values()) {
      if (entry.key === key && !entry.window.isDestroyed()) { entry.window.focus(); return true; }
    }
    const window = env.newWindow({ width: 760, height: 720, minWidth: 420, minHeight: 360, title: "Tomverse Desktop" });
    const id = window.webContents.id;
    windows.set(id, { window, key });
    window.once("closed", () => { windows.delete(id); });
    void window.loadURL(taskUrl).catch(() => { if (!window.isDestroyed()) window.close(); });
    return true;
  }

  /** A detached window may read and stop its own task and nothing else: the key comes from the window, never from what the page sends. */
  function boundKey(event: Electron.IpcMainInvokeEvent) {
    const entry = windows.get(event.sender.id);
    const frame = event.senderFrame;
    if (!entry || entry.window.isDestroyed() || event.sender !== entry.window.webContents || !frame || frame.parent || frame.url !== taskUrl || frame.origin !== env.origin) {
      throw new Error("Untrusted desktop request.");
    }
    return entry.key;
  }

  function registerWindowIpc() {
    ipcMain.handle("task-window:read", (event) => windowView(boundKey(event)));
    ipcMain.handle("task-window:stop", (event) => lanes.stop(boundKey(event)));
  }

  function command(value: unknown): boolean {
    const input = parallelCommand.parse(value);
    if (input.action === "stop") {
      const open = env.foreground();
      if (open?.busy && open.key === input.key) { env.stopForeground(); return true; }
      return lanes.stop(input.key);
    }
    if (input.action === "observe") { lanes.observe(input.keys); changed(); return true; }
    if (input.action === "detach") return detach(input.key);
    if (input.action === "set-limit") {
      limit = input.limit;
      try { mkdirSync(dirname(limitFile(env)), { recursive: true, mode: 0o700 }); writeFileSync(limitFile(env), String(limit)); } catch { /* The limit stays for this run only. */ }
      lanes.tick();
      changed();
      return true;
    }
    if (input.action === "review-approval") { const ok = lanes.reveal(input.key); changed(); return ok; }
    return lanes.dismiss(input.key);
  }

  async function schedules(value: unknown): Promise<ScheduleResult> {
    const input = scheduleCommand.parse(value);
    await engine.refresh();
    return engine.command(input);
  }

  function start() {
    engine.startup();
    void engine.refresh().then(() => env.broadcast());
    timer = setInterval(() => lanes.tick(), 1000);
    scheduleTimer = setInterval(() => { void engine.tick(); }, env.fastClock ? 250 : 15_000);
    registerWindowIpc();
  }

  /** Quit: ends the timers and every lane process. */
  function shutdown() {
    clearInterval(timer);
    clearInterval(scheduleTimer);
    clearTimeout(broadcastTimer);
    engine.shutdown();
    lanes.shutdown();
  }

  /** The permission mode the person chose changed. */
  const permissionChanged = () => lanes.permissionChanged();

  return {
    lanes, engine, start, shutdown, parallelView, scheduleView, command, schedules, permissionChanged, detach,
    submit: (spec: LaneSpec) => lanes.submit(spec),
  };
}

export type ParallelHost = ReturnType<typeof createParallelHost>;
