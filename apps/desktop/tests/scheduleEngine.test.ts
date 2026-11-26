import assert from "node:assert/strict";
import test from "node:test";
import { ScheduleEngine, type LaunchOutcome } from "../src/host/schedule-engine";
import type { LaneResult } from "../src/host/task-lanes";
import type { LaneRow, ScheduleInput, ScheduleItem, ScheduleRun } from "../src/parallel-contract";
import { scheduleInput } from "../src/parallel-contract";
import { failuresAfter, scheduleShapeProblem, sandboxEnforcesWrites } from "../src/schedule-policy";
import type { SandboxFacts } from "../src/schedule-policy";
import type { Task } from "../src/contract";

const utc = (iso: string) => Date.parse(iso);
const enforced: SandboxFacts = { mode: "workspace-write", available: true, writes: "os" };
const notEnforced: SandboxFacts = { mode: "off", available: true, writes: "none" };

function world(start = "2026-12-01T08:00:00Z", store: { text: string | null } = { text: null }) {
  let now = utc(start);
  let sandbox = enforced;
  let git = true;
  let account = true;
  const launched: Array<{ item: ScheduleItem; run: ScheduleRun }> = [];
  const notified: ScheduleRun[] = [];
  const active = new Map<string, number>();
  let rows: LaneRow[] = [];
  let launchResult: LaunchOutcome | null = null;
  let counter = 0;
  const engine = new ScheduleEngine({
    now: () => now,
    load: () => store.text,
    save: (text) => { store.text = text; },
    sandbox: async () => sandbox,
    gitProject: () => git,
    openProject: () => "/project",
    modelAvailable: (model) => model === "model-a",
    hasAccount: () => account,
    async launch(item, run) {
      launched.push({ item, run });
      active.set(item.id, (active.get(item.id) ?? 0) + 1);
      return launchResult ?? { ok: true, key: `lane-${++counter}` };
    },
    activeFor: (id) => active.get(id) ?? 0,
    rows: () => rows,
    notify: (_item, run) => { notified.push({ ...run }); },
    changed: () => undefined,
    failureLimit: 3,
  });
  const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: "Nightly review", prompt: "Review the diff", timing: { cadence: { kind: "daily", time: "09:00" }, timeZone: "UTC" },
    workspace: "folder", taskMode: "ask", permission: "read_only", model: "model-a", limits: "standard", ...over,
  });
  const result = (key: string, outcome: LaneResult["outcome"], extra: Partial<Task> = {}): LaneResult => ({
    key, outcome, spec: {} as never, startedAt: now - 1000, finishedAt: now,
    task: { id: "s-20261201-090000-abcdef", root: "/project", title: "t", status: "completed", entries: [], changes: [{ id: "c1", path: "a.txt", kind: "update", current: "" }], checks: [], transmission: [], ...extra },
  });
  return {
    engine, store, launched, notified, input, result,
    advance: (ms: number) => { now += ms; },
    set: (value: string) => { now = utc(value); },
    setSandbox: (value: SandboxFacts) => { sandbox = value; },
    setGit: (value: boolean) => { git = value; },
    setAccount: (value: boolean) => { account = value; },
    setRows: (value: LaneRow[]) => { rows = value; },
    setLaunch: (value: LaunchOutcome | null) => { launchResult = value; },
    finish(item: ScheduleItem) { active.set(item.id, 0); },
    async enable() { await engine.startup(); return engine.command({ action: "enable", enabled: true, acknowledged: true }); },
    idOf: () => engine.view().items[0]!.id,
  };
}

test("schedules stay off until the person acknowledges that runs start unattended", async () => {
  const w = world();
  w.engine.startup();
  assert.equal(w.engine.view().enabled, false);
  assert.deepEqual(await w.engine.command({ action: "enable", enabled: true }), { ok: false, reason: "needs-acknowledgement" });
  assert.deepEqual(await w.engine.command({ action: "enable", enabled: true, acknowledged: false }), { ok: false, reason: "needs-acknowledgement" });
  assert.equal(w.engine.view().enabled, false);
  assert.deepEqual(await w.engine.command({ action: "enable", enabled: true, acknowledged: true }), { ok: true });
  assert.equal(w.engine.view().enabled, true);
});

test("nothing runs while schedules are off", async () => {
  const w = world();
  w.engine.startup();
  assert.deepEqual(await w.engine.command({ action: "save", input: w.input() }), { ok: true });
  w.advance(2 * 60 * 60_000);
  await w.engine.tick();
  assert.equal(w.launched.length, 0);
  assert.deepEqual(await w.engine.command({ action: "run-now", id: w.idOf() }), { ok: false, reason: "disabled" });
});

test("a due schedule starts one run, and is not started again while that run lasts", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input() });
  w.set("2026-12-01T09:00:10Z");
  await w.engine.tick();
  assert.equal(w.launched.length, 1);
  assert.equal(w.launched[0]!.run.scheduledFor, utc("2026-12-01T09:00:00Z"));
  // A second occurrence comes due before the first run ended.
  const id = w.idOf();
  assert.equal(w.engine.view().items[0]!.running, true);
  const item = w.engine.view().items[0]!;
  w.set("2026-12-02T09:00:10Z");
  await w.engine.tick();
  assert.equal(w.launched.length, 1, "no second run while the first one is active");
  const skipped = w.engine.view().runs.find((run) => run.status === "skipped");
  assert.equal(skipped?.reason, "overlap");
  assert.equal(skipped?.scheduleId, id);
  assert.equal(item.id, id);
  assert.deepEqual(await w.engine.command({ action: "run-now", id }), { ok: false, reason: "busy-schedule" });
});

test("two triggers at the same moment start one run", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input() });
  const id = w.idOf();
  const [first, second] = await Promise.all([w.engine.command({ action: "run-now", id }), w.engine.command({ action: "run-now", id })]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.launched.length, 1);
});

test("what came due while the app was closed is recorded as missed and never run", async () => {
  const store = { text: null as string | null };
  const first = world("2026-12-01T08:00:00Z", store);
  await first.enable();
  await first.engine.command({ action: "save", input: first.input() });
  first.engine.shutdown();
  const second = world("2026-12-04T09:30:00Z", store);
  second.engine.startup();
  assert.equal(second.launched.length, 0);
  const runs = second.engine.view().runs;
  assert.deepEqual(runs.map((run) => run.status), ["missed", "missed", "missed", "missed"]);
  assert.deepEqual(runs.map((run) => new Date(run.scheduledFor).toISOString()).reverse(),
    ["2026-12-01T09:00:00.000Z", "2026-12-02T09:00:00.000Z", "2026-12-03T09:00:00.000Z", "2026-12-04T09:00:00.000Z"]);
  await second.engine.tick();
  assert.equal(second.launched.length, 0, "no catch-up run after start");
});

test("a run that was in flight when the app ended is recorded as ended, not as running", async () => {
  const store = { text: null as string | null };
  const first = world("2026-12-01T08:00:00Z", store);
  await first.enable();
  await first.engine.command({ action: "save", input: first.input() });
  first.set("2026-12-01T09:00:05Z");
  await first.engine.tick();
  first.engine.shutdown();
  const second = world("2026-12-01T09:05:00Z", store);
  second.engine.startup();
  const run = second.engine.view().runs[0]!;
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "crashed");
});

test("allow all needs a new worktree and an OS sandbox that really refuses writes", async () => {
  const w = world();
  await w.enable();
  const allowAll = (over: Partial<ScheduleInput> = {}) => w.input({ taskMode: "agent", permission: "allow_all", workspace: "worktree", ...over });
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll({ workspace: "folder" }) }), { ok: false, reason: "needs-worktree" });
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll({ taskMode: "ask" }) }), { ok: false, reason: "needs-agent" });
  w.setSandbox(notEnforced);
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll() }), { ok: false, reason: "needs-sandbox" });
  w.setSandbox({ mode: "workspace-write", available: false, writes: "none" });
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll() }), { ok: false, reason: "needs-sandbox" });
  w.setSandbox({ mode: "workspace-write", available: true, writes: "none" });
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll() }), { ok: false, reason: "needs-sandbox" });
  w.setGit(false);
  w.setSandbox(enforced);
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll() }), { ok: false, reason: "needs-git" });
  w.setGit(true);
  assert.deepEqual(await w.engine.command({ action: "save", input: allowAll() }), { ok: true });
  // The other modes need none of this.
  for (const permission of ["read_only", "ask", "auto_review"] as const) {
    assert.deepEqual(await w.engine.command({ action: "save", input: w.input({ permission, name: permission }) }), { ok: true });
  }
});

test("an allow-all schedule does not start when the sandbox stopped being enforced after it was saved", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input({ taskMode: "agent", permission: "allow_all", workspace: "worktree" }) });
  w.setSandbox(notEnforced);
  w.set("2026-12-01T09:00:10Z");
  await w.engine.tick();
  assert.equal(w.launched.length, 0);
  const run = w.engine.view().runs[0]!;
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "sandbox");
  assert.equal(w.engine.view().items[0]!.failures, 1);
});

test("three failures in a row turn the schedule off; a success starts the count again", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input({ timing: { cadence: { kind: "interval", everyMinutes: 5, anchor: utc("2026-12-01T08:00:00Z") }, timeZone: "UTC" } }) });
  const id = w.idOf();
  const cycle = async (outcome: LaneResult["outcome"]) => {
    w.advance(5 * 60_000);
    await w.engine.tick();
    const key = `lane-${w.launched.length}`;
    w.finish(w.engine.view().items[0]!);
    w.engine.settled(w.result(key, outcome));
  };
  await cycle("failed");
  await cycle("crashed");
  assert.equal(w.engine.view().items[0]!.failures, 2);
  await cycle("completed");
  assert.equal(w.engine.view().items[0]!.failures, 0);
  await cycle("failed");
  await cycle("unknown");
  assert.equal(w.engine.view().items[0]!.enabled, true);
  await cycle("approval-timeout");
  const item = w.engine.view().items[0]!;
  assert.equal(item.enabled, false);
  assert.equal(item.disabledBy, "failures");
  assert.equal(item.nextRun, null);
  const before = w.launched.length;
  w.advance(10 * 60_000);
  await w.engine.tick();
  assert.equal(w.launched.length, before, "a schedule that turned itself off does not run");
  assert.deepEqual(await w.engine.command({ action: "toggle", id, enabled: true }), { ok: true });
  assert.equal(w.engine.view().items[0]!.failures, 0);
});

test("a run record carries its times, status, files and the task to open, and a notification goes out", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input() });
  w.set("2026-12-01T09:00:10Z");
  await w.engine.tick();
  w.engine.settled(w.result("lane-1", "completed"));
  const run = w.engine.view().runs[0]!;
  assert.equal(run.status, "completed");
  assert.equal(run.taskId, "s-20261201-090000-abcdef");
  assert.deepEqual(run.files, { count: 1, paths: ["a.txt"] });
  assert.ok(run.finishedAt && run.startedAt);
  assert.equal(w.notified.length, 1);
  assert.equal(w.notified[0]!.status, "completed");
});

test("a person's stop is not counted as a failure; a missing account or model skips the run", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input({ timing: { cadence: { kind: "interval", everyMinutes: 5, anchor: utc("2026-12-01T08:00:00Z") }, timeZone: "UTC" } }) });
  w.advance(5 * 60_000);
  await w.engine.tick();
  w.finish(w.engine.view().items[0]!);
  w.engine.settled(w.result("lane-1", "stopped"));
  assert.equal(w.engine.view().runs[0]!.status, "stopped");
  assert.equal(w.engine.view().items[0]!.failures, 0);
  w.setAccount(false);
  w.advance(5 * 60_000);
  await w.engine.tick();
  assert.equal(w.engine.view().runs[0]!.status, "skipped");
  assert.equal(w.engine.view().runs[0]!.reason, "no-account");
  assert.equal(w.engine.view().items[0]!.failures, 0);
  assert.equal(w.launched.length, 1);
});

test("the run list shows a live run as queued, running or waiting for approval from its lane", async () => {
  const w = world();
  await w.enable();
  await w.engine.command({ action: "save", input: w.input() });
  w.set("2026-12-01T09:00:10Z");
  await w.engine.tick();
  const row = (state: LaneRow["state"]): LaneRow => ({ key: "lane-1", kind: "scheduled", title: "x", folder: "/p", isolated: false, state, status: "running",
    taskId: "s-1", changes: 0, approvals: 0, unattendedApproval: false, canStop: true, startedAt: utc("2026-12-01T09:00:11Z") });
  w.setRows([row("queued")]);
  assert.equal(w.engine.view().runs[0]!.status, "queued");
  w.setRows([row("running")]);
  assert.equal(w.engine.view().runs[0]!.status, "running");
  w.setRows([row("approval")]);
  assert.equal(w.engine.view().runs[0]!.status, "awaiting_approval");
});

test("a one-time schedule runs once and then finishes", async () => {
  const w = world();
  await w.enable();
  const at = utc("2026-12-01T08:10:00Z");
  assert.deepEqual(await w.engine.command({ action: "save", input: w.input({ timing: { cadence: { kind: "once", at: utc("2026-12-01T07:00:00Z") }, timeZone: "UTC" } }) }), { ok: false, reason: "past" });
  assert.deepEqual(await w.engine.command({ action: "save", input: w.input({ timing: { cadence: { kind: "once", at }, timeZone: "UTC" } }) }), { ok: true });
  w.set("2026-12-01T08:10:05Z");
  await w.engine.tick();
  assert.equal(w.launched.length, 1);
  w.advance(60_000);
  await w.engine.tick();
  assert.equal(w.launched.length, 1);
  assert.equal(w.engine.view().items[0]!.nextRun, null);
});

test("a schedule's request cap is never unlimited and nothing but the typed input can make one", () => {
  const base = { name: "n", prompt: "p", timing: { cadence: { kind: "daily", time: "09:00" }, timeZone: "UTC" }, workspace: "folder", taskMode: "ask", permission: "read_only", model: "m" };
  assert.equal(scheduleInput.safeParse({ ...base, limits: "standard" }).success, true);
  assert.equal(scheduleInput.safeParse({ ...base, limits: "extended" }).success, true);
  assert.equal(scheduleInput.safeParse({ ...base, limits: "unlimited" }).success, false);
  assert.equal(scheduleInput.safeParse({ ...base, limits: "standard", project: "/elsewhere" }).success, false, "the folder is never sent by the screen");
});

test("a saved file that does not parse leaves schedules off and empty", () => {
  const w = world("2026-12-01T08:00:00Z", { text: JSON.stringify({ version: 1, enabled: true, items: "nope" }) });
  w.engine.startup();
  assert.deepEqual(w.engine.view().items, []);
  assert.equal(w.engine.view().enabled, false);
});

test("policy: failure counting and the allow-all condition", () => {
  assert.equal(failuresAfter(2, "failed"), 3);
  assert.equal(failuresAfter(2, "completed"), 0);
  for (const status of ["stopped", "missed", "skipped"] as const) assert.equal(failuresAfter(2, status), 2);
  assert.equal(sandboxEnforcesWrites(enforced), true);
  assert.equal(sandboxEnforcesWrites({ mode: "read-only", available: true, writes: "os" }), true);
  assert.equal(sandboxEnforcesWrites({ mode: "off", available: true, writes: "os" }), false);
  assert.equal(scheduleShapeProblem({ taskMode: "agent", permission: "ask", workspace: "folder" }, { sandbox: notEnforced, gitProject: false }), null);
});
