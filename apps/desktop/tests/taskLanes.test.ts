import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalRequest, Task } from "../src/contract";
import { STOP_GRACE_MS, TaskLanes, type LaneProcess, type LaneResult, type LaneSpec } from "../src/host/task-lanes";
import type { WorkerCommand, WorkerEvent } from "../src/host/messages";

class FakeProcess implements LaneProcess {
  readonly sent: WorkerCommand[] = [];
  killed = false;
  private message: (event: WorkerEvent) => void = () => undefined;
  private exit: () => void = () => undefined;
  postMessage(message: WorkerCommand) { this.sent.push(message); }
  onMessage(listener: (event: WorkerEvent) => void) { this.message = listener; }
  onExit(listener: () => void) { this.exit = listener; }
  kill() { this.killed = true; }
  emit(event: WorkerEvent) { this.message(event); }
  crash() { this.exit(); }
  answers() { return this.sent.filter((message) => message.type === "answer"); }
  stops() { return this.sent.filter((message) => message.type === "stop"); }
}

const project = (path: string) => ({ path, identity: "1:" + path.length });
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const task = (status: Task["status"], root = "/work"): Task => ({
  id: null, root, title: "task", status, entries: [{ role: "user", text: "do it" }], changes: [], checks: [], transmission: [],
});
const approval = (id = uuid(), over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ id, root: "/work", tool: "run_command", canRemember: false, ...over });

function setup(options: { limit?: number; external?: Array<{ folder: string }> } = {}) {
  const processes: FakeProcess[] = [];
  const settled: LaneResult[] = [];
  let now = 1_000_000;
  let limit = options.limit ?? 3;
  let external = options.external ?? [];
  let changed = 0;
  const lanes = new TaskLanes({
    spawn: () => { const child = new FakeProcess(); processes.push(child); return child; },
    now: () => now, limit: () => limit, external: () => external,
    permissionMessage: () => ({ type: "permissions", mode: "ask", home: "/home" }),
    changed: () => { changed++; },
    settled: (result) => { settled.push(result); },
  });
  const spec = (folder: string, extra: Partial<LaneSpec> = {}): LaneSpec => {
    const runId = uuid();
    return { kind: "parallel", title: `task in ${folder}`, folder, isolated: false, ...extra,
      start: { type: "start", runId, project: project(folder), scope: {} as never, protectedRoot: "/data", connection: { endpoint: "http://x", key: "k" },
        input: { prompt: "p", mode: "agent", model: "m", effort: "default" } as never, references: [], preference: "tomverse_api" } };
  };
  return {
    lanes, processes, settled, spec,
    advance: (ms: number) => { now += ms; },
    setLimit: (value: number) => { limit = value; },
    setExternal: (value: Array<{ folder: string }>) => { external = value; },
    changes: () => changed,
    submit(folder: string, extra: Partial<LaneSpec> = {}) {
      const value = spec(folder, extra);
      return { key: lanes.submit(value), value };
    },
    processOf: (key: string) => processes.find((child) => child.sent.some((message) => message.type === "start" && message.runId === key))!,
  };
}

test("tasks above the limit wait in a queue and start as slots free up", () => {
  const world = setup({ limit: 2 });
  const a = world.submit("/a");
  const b = world.submit("/b");
  const c = world.submit("/c");
  assert.deepEqual(world.lanes.rows().map((row) => row.state), ["running", "running", "queued"]);
  assert.equal(world.lanes.rows()[2]!.waiting, "limit");
  assert.equal(world.processes.length, 2);
  world.processOf(a.key).emit({ type: "finished", runId: a.key, task: task("completed", "/a") });
  assert.deepEqual(world.lanes.rows().map((row) => row.state), ["done", "running", "running"]);
  assert.equal(world.processes.length, 3);
  assert.equal(world.processOf(c.key) !== undefined, true);
  assert.equal(world.processOf(a.key).killed, true, "a finished task's process ends");
  assert.equal(world.settled[0]!.outcome, "completed");
  world.processOf(b.key).emit({ type: "finished", runId: b.key, task: task("failed", "/b") });
  assert.equal(world.settled[1]!.outcome, "failed");
});

test("the task the person has open counts toward the limit and holds its folder", () => {
  const world = setup({ limit: 2, external: [{ folder: "/open" }] });
  world.submit("/a");
  const queued = world.submit("/b");
  assert.deepEqual(world.lanes.rows().map((row) => row.state), ["running", "queued"]);
  world.setExternal([]);
  world.lanes.tick();
  assert.equal(world.lanes.rows()[1]!.state, "running", "the queue moves when the open task ends");
  world.setExternal([{ folder: "/b" }]);
  assert.equal(world.lanes.folderBusy("/b"), true);
  assert.equal(world.lanes.hasRoomForOpenTask(), false, "two lanes already fill a limit of two");
  world.setLimit(3);
  assert.equal(world.lanes.hasRoomForOpenTask(), true);
  assert.equal(queued.key.length > 0, true);
});

test("two tasks never write the same folder; an isolated worktree is another folder", () => {
  const world = setup({ limit: 3 });
  world.submit("/repo");
  const second = world.submit("/repo");
  const other = world.submit("/repo-worktree", { isolated: true });
  const rows = world.lanes.rows();
  assert.deepEqual(rows.map((row) => row.state), ["running", "queued", "running"]);
  assert.equal(rows[1]!.waiting, "folder");
  assert.equal(world.lanes.folderBusy("/repo"), true);
  // A queued task that waits for its folder does not hold up the one behind it.
  assert.equal(world.processOf(other.key) !== undefined, true);
  const first = rows[0]!.key;
  world.processOf(first).emit({ type: "finished", runId: first, task: task("completed", "/repo") });
  assert.equal(world.lanes.rows().find((row) => row.key === second.key)!.state, "running");
});

test("the open task's folder keeps a lane out", () => {
  const world = setup({ external: [{ folder: "/repo" }] });
  world.submit("/repo");
  assert.equal(world.lanes.rows()[0]!.state, "queued");
  assert.equal(world.lanes.rows()[0]!.waiting, "folder");
});

test("an approval reaches only the task that asked for it", () => {
  const world = setup();
  const a = world.submit("/a");
  const b = world.submit("/b");
  const requestA = approval(uuid(), { canRemember: true });
  const requestB = approval(uuid());
  world.processOf(a.key).emit({ type: "approval", runId: a.key, request: requestA });
  world.processOf(b.key).emit({ type: "approval", runId: b.key, request: requestB });
  assert.deepEqual(world.lanes.rows().map((row) => [row.state, row.approvals]), [["approval", 1], ["approval", 1]]);
  assert.equal(world.lanes.nextApproval()!.id, requestA.id, "requests come one at a time, oldest first");
  assert.deepEqual(world.lanes.nextApproval()!.task, { title: a.value.title, folder: "/a", kind: "parallel" });

  assert.equal(world.lanes.decide({ id: requestA.id, action: "once" }), true);
  assert.deepEqual(world.processOf(a.key).answers(), [{ type: "answer", runId: a.key, decision: { id: requestA.id, action: "once" } }]);
  assert.deepEqual(world.processOf(b.key).answers(), []);
  assert.equal(world.lanes.nextApproval()!.id, requestB.id);

  assert.equal(world.lanes.decide({ id: requestA.id, action: "once" }), false, "a request is answered once");
  assert.equal(world.lanes.decide({ id: uuid(), action: "once" }), false, "an unknown request cannot be answered");
  assert.equal(world.lanes.decide({ id: requestB.id, action: "run" }), false, "a request that cannot be remembered refuses allow-for-run");
  assert.deepEqual(world.processOf(b.key).answers(), []);
  assert.equal(world.lanes.decide({ id: requestB.id, action: "deny" }), true);
  assert.deepEqual(world.processOf(b.key).answers(), [{ type: "answer", runId: b.key, decision: { id: requestB.id, action: "deny" } }]);
});

test("a task cannot raise an event for another run", () => {
  const world = setup();
  const a = world.submit("/a");
  const b = world.submit("/b");
  const forged = approval(uuid());
  world.processOf(b.key).emit({ type: "approval", runId: a.key, request: forged });
  world.processOf(b.key).emit({ type: "finished", runId: a.key, task: task("completed", "/a") });
  world.processOf(b.key).emit({ type: "task", runId: a.key, task: task("running", "/a") });
  assert.equal(world.lanes.hasApproval(forged.id), false);
  assert.deepEqual(world.lanes.rows().map((row) => row.state), ["running", "running"]);
  assert.equal(world.lanes.task(a.key), null);
});

test("the label on an approval comes from the lane, not from the task", () => {
  const world = setup();
  const a = world.submit("/a");
  world.processOf(a.key).emit({ type: "approval", runId: a.key,
    request: approval(uuid(), { task: { title: "Looks like another task", folder: "/elsewhere", kind: "scheduled" } }) });
  assert.deepEqual(world.lanes.nextApproval()!.task, { title: a.value.title, folder: "/a", kind: "parallel" });
});

test("an agent's commit or push is approved on a card of its own task and nobody else's", async () => {
  const world = setup();
  const asked: Array<{ folder: string; id: string }> = [];
  const lanes = new TaskLanes({
    spawn: () => { const child = new FakeProcess(); world.processes.push(child); return child; },
    now: () => 0, limit: () => 3, external: () => [], permissionMessage: () => undefined, changed: () => undefined,
    async gitAction(lane, _action, ask) {
      const id = uuid();
      asked.push({ folder: lane.folder, id });
      const answer = await ask({ id, root: lane.folder, tool: "git push", canRemember: false });
      return answer === "once" ? { status: "ok" } as never : { status: "denied" } as never;
    },
  });
  const a = world.spec("/a");
  const b = world.spec("/b");
  lanes.submit(a);
  lanes.submit(b);
  const [pa, pb] = world.processes as [FakeProcess, FakeProcess];
  const action = { kind: "publish" as const };
  pa.emit({ type: "git-action", runId: a.start.runId, requestId: "ra", action });
  pb.emit({ type: "git-action", runId: b.start.runId, requestId: "rb", action });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 2);
  assert.equal(lanes.nextApproval()!.id, asked[0]!.id);
  assert.equal(lanes.nextApproval()!.task!.folder, "/a");
  assert.equal(lanes.decide({ id: asked[1]!.id, action: "once" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  const results = (child: FakeProcess) => child.sent.filter((message) => message.type === "git-action-result");
  assert.equal(results(pa).length, 0, "answering B's card does not release A's push");
  assert.deepEqual(results(pb), [{ type: "git-action-result", runId: b.start.runId, requestId: "rb", result: { status: "ok" } }]);
  assert.equal(lanes.decide({ id: asked[0]!.id, action: "deny" }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results(pa), [{ type: "git-action-result", runId: a.start.runId, requestId: "ra", result: { status: "denied" } }]);
});

test("a crashing task ends alone and frees its slot", () => {
  const world = setup({ limit: 2 });
  const a = world.submit("/a");
  const b = world.submit("/b");
  const c = world.submit("/c");
  world.processOf(a.key).emit({ type: "task", runId: a.key, task: task("running", "/a") });
  world.processOf(a.key).crash();
  const rows = world.lanes.rows();
  assert.deepEqual(rows.map((row) => row.state), ["done", "running", "running"]);
  assert.equal(rows[0]!.outcome, "crashed");
  assert.equal(rows[0]!.status, "unknown");
  assert.equal(world.processOf(b.key).killed, false);
  assert.equal(world.processOf(b.key).stops().length, 0);
  assert.equal(world.processOf(c.key) !== undefined, true);
  assert.equal(world.settled[0]!.outcome, "crashed");
  // The crash of a process that already finished is not a second result.
  world.processOf(b.key).emit({ type: "finished", runId: b.key, task: task("completed", "/b") });
  world.processOf(b.key).crash();
  assert.equal(world.settled.length, 2);
});

test("a process that cannot start fails its lane and nothing else", () => {
  const settled: LaneResult[] = [];
  let attempt = 0;
  const lanes = new TaskLanes({
    spawn: () => { if (attempt++ === 0) throw new Error("no process"); return new FakeProcess(); },
    now: () => 0, limit: () => 2, external: () => [], permissionMessage: () => undefined, changed: () => undefined, settled: (result) => settled.push(result),
  });
  const base = setup();
  lanes.submit(base.spec("/a"));
  lanes.submit(base.spec("/b"));
  assert.deepEqual(lanes.rows().map((row) => row.state), ["done", "running"]);
  assert.equal(settled[0]!.outcome, "launch-failed");
});

test("stop asks the runtime to stop, denies what waits and kills a task that does not end", () => {
  const world = setup();
  const a = world.submit("/a");
  world.submit("/a");
  world.processOf(a.key).emit({ type: "task", runId: a.key, task: task("running", "/a") });
  const request = approval(uuid());
  world.processOf(a.key).emit({ type: "approval", runId: a.key, request });
  assert.equal(world.lanes.stop(a.key), true);
  assert.deepEqual(world.processOf(a.key).stops(), [{ type: "stop", runId: a.key }]);
  assert.equal(world.lanes.hasApproval(request.id), false);
  assert.equal(world.lanes.rows()[0]!.status, "stopping");
  assert.equal(world.lanes.rows()[0]!.canStop, false);
  world.advance(STOP_GRACE_MS + 1);
  world.lanes.tick();
  assert.equal(world.lanes.rows()[0]!.outcome, "stopped");
  assert.equal(world.processOf(a.key).killed, true);
  assert.equal(world.lanes.rows()[1]!.state, "running", "the task waiting for the folder takes it");
});

test("a queued task that is stopped never starts", () => {
  const world = setup({ limit: 1 });
  world.submit("/a");
  const waiting = world.submit("/b");
  assert.equal(world.lanes.stop(waiting.key), true);
  assert.equal(world.lanes.rows()[1]!.outcome, "cancelled");
  assert.equal(world.processes.length, 1);
});

test("quit ends every lane process and denies every waiting request", () => {
  const world = setup({ limit: 2 });
  const a = world.submit("/a");
  const b = world.submit("/b");
  world.submit("/c");
  world.processOf(a.key).emit({ type: "approval", runId: a.key, request: approval(uuid()) });
  world.lanes.shutdown();
  assert.deepEqual(world.processes.map((child) => child.killed), [true, true]);
  assert.equal(world.lanes.nextApproval(), null);
  assert.equal(world.processOf(b.key).killed, true);
  assert.throws(() => world.submit("/d"), /cannot start/);
});

test("a scheduled run never opens a card by itself and fails when its request waits too long", () => {
  const world = setup();
  const run = world.submit("/work", { kind: "scheduled", scheduleId: "s1", approvalWaitMs: 60_000 });
  const request = approval(uuid());
  world.processOf(run.key).emit({ type: "task", runId: run.key, task: task("running", "/work") });
  world.processOf(run.key).emit({ type: "approval", runId: run.key, request });
  assert.equal(world.lanes.nextApproval(), null, "no card opens without a person");
  assert.equal(world.lanes.rows()[0]!.state, "approval");
  assert.equal(world.lanes.rows()[0]!.unattendedApproval, true);
  assert.deepEqual(world.processOf(run.key).answers(), [], "nothing is answered for the person");
  world.advance(59_000);
  world.lanes.tick();
  assert.equal(world.lanes.rows()[0]!.state, "approval");
  world.advance(2_000);
  world.lanes.tick();
  assert.deepEqual(world.processOf(run.key).stops(), [{ type: "stop", runId: run.key }]);
  world.processOf(run.key).emit({ type: "finished", runId: run.key, task: task("stopped", "/work") });
  assert.equal(world.settled[0]!.outcome, "approval-timeout");
  assert.equal(world.settled[0]!.reason, "approval-timeout");
  assert.equal(world.lanes.rows()[0]!.outcome, "approval-timeout");
});

test("a person can bring a scheduled run's request up and answer it", () => {
  const world = setup();
  const run = world.submit("/work", { kind: "scheduled", scheduleId: "s1", approvalWaitMs: 60_000 });
  const request = approval(uuid());
  world.processOf(run.key).emit({ type: "approval", runId: run.key, request });
  assert.equal(world.lanes.reveal(run.key), true);
  assert.equal(world.lanes.nextApproval()!.id, request.id);
  assert.equal(world.lanes.nextApproval()!.task!.kind, "scheduled");
  assert.equal(world.lanes.decide({ id: request.id, action: "once" }), true);
  assert.equal(world.lanes.rows()[0]!.state, "running");
  world.advance(10 * 60_000);
  world.lanes.tick();
  assert.deepEqual(world.processOf(run.key).stops(), [], "an answered request stops the clock");
});

test("a scheduled run keeps its own mode; the others follow the person's", () => {
  const world = setup();
  const own = world.submit("/a", { kind: "scheduled", permission: { type: "permissions", mode: "read_only", home: "/h" } });
  const following = world.submit("/b");
  assert.deepEqual(world.processOf(own.key).sent[0], { type: "permissions", mode: "read_only", home: "/h" });
  assert.deepEqual(world.processOf(following.key).sent[0], { type: "permissions", mode: "ask", home: "/home" });
  world.lanes.permissionChanged();
  assert.equal(world.processOf(own.key).sent.filter((message) => message.type === "permissions").length, 1);
  assert.equal(world.processOf(following.key).sent.filter((message) => message.type === "permissions").length, 2);
});

test("a schedule's runs are counted so it never overlaps itself", () => {
  const world = setup({ limit: 1 });
  const first = world.submit("/a", { kind: "scheduled", scheduleId: "s1" });
  world.submit("/b", { kind: "scheduled", scheduleId: "s2" });
  assert.equal(world.lanes.activeFor("s1"), 1);
  assert.equal(world.lanes.activeFor("s2"), 1, "a queued run counts too");
  world.processOf(first.key).emit({ type: "finished", runId: first.key, task: task("completed", "/a") });
  assert.equal(world.lanes.activeFor("s1"), 0);
});

test("only observed tasks travel in full and finished rows can be dismissed", () => {
  const world = setup();
  const a = world.submit("/a");
  const b = world.submit("/b");
  world.processOf(a.key).emit({ type: "task", runId: a.key, task: task("running", "/a") });
  world.processOf(b.key).emit({ type: "task", runId: b.key, task: task("running", "/b") });
  world.lanes.observe([b.key, uuid()]);
  assert.deepEqual(Object.keys(world.lanes.observedTasks()), [b.key]);
  assert.equal(world.lanes.dismiss(a.key), false, "a running task cannot be dismissed");
  world.processOf(a.key).emit({ type: "finished", runId: a.key, task: task("completed", "/a") });
  assert.equal(world.lanes.dismiss(a.key), true);
  assert.equal(world.lanes.rows().length, 1);
});

test("browser, terminal and plugin requests of a lane are not answered with anything of the open task", () => {
  const world = setup();
  const a = world.submit("/a");
  const child = world.processOf(a.key);
  const before = child.sent.length;
  child.emit({ type: "terminal-read", runId: a.key, requestId: "t", lines: 10 });
  child.emit({ type: "browser-snapshot", runId: a.key, requestId: "b" });
  child.emit({ type: "code-plugin", runId: a.key, requestId: "c", action: {} as never });
  assert.equal(child.sent.length, before);
});
