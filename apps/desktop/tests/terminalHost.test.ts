import assert from "node:assert/strict";
import test from "node:test";
import { TerminalHost } from "../src/host/terminal-host";
import type { TerminalLaunch, TerminalLaunchOptions, TerminalSession } from "../src/host/terminal-session";
import { MAX_TERMINALS_PER_TASK, type TerminalEvent } from "../src/terminal-contract";

type Fake = TerminalSession & { options: TerminalLaunchOptions; written: string[]; killed: number; killedSync: number; sizes: Array<[number, number]> };

function setup(extra: { perTask?: number; total?: number; scrollback?: number } = {}) {
  const sessions: Fake[] = [];
  const events: TerminalEvent[] = [];
  const launch: TerminalLaunch = (options) => {
    const session: Fake = {
      kind: "pty", pid: 5000 + sessions.length, options, written: [], killed: 0, killedSync: 0, sizes: [],
      write(data) { this.written.push(data); },
      resize(cols, rows) { this.sizes.push([cols, rows]); },
      async kill() { this.killed += 1; },
      killSync() { this.killedSync += 1; },
    };
    sessions.push(session);
    return session;
  };
  const host = new TerminalHost({ launch, env: () => ({ PATH: "/bin" }), emit: (event) => events.push(event), ...extra });
  return { host, sessions, events };
}

test("a task keeps several terminals up to a limit, and the lowest free number is reused", async () => {
  const { host } = setup();
  const opened = Array.from({ length: MAX_TERMINALS_PER_TASK }, () => host.open("task-a", "/work", 80, 24));
  assert.deepEqual(opened.map((info) => info.index), [1, 2, 3, 4]);
  assert.throws(() => host.open("task-a", "/work", 80, 24), /Close a terminal/);
  assert.equal(host.open("task-b", "/work", 80, 24).index, 1, "The limit is per task.");
  await host.close(opened[1]!.id);
  assert.equal(host.open("task-a", "/work", 80, 24).index, 2);
});

test("the number of terminals across all tasks is bounded", () => {
  const { host } = setup({ total: 3, perTask: 2 });
  host.open("a", "/w", 80, 24);
  host.open("a", "/w", 80, 24);
  host.open("b", "/w", 80, 24);
  assert.throws(() => host.open("c", "/w", 80, 24), /Too many terminals/);
  assert.equal(host.count, 3);
});

test("the shell starts in the folder the host chose, with the environment the host supplied", () => {
  const { host, sessions } = setup();
  host.open("task-a", "/the/task/worktree", 100, 30);
  assert.equal(sessions[0]!.options.cwd, "/the/task/worktree");
  assert.deepEqual([sessions[0]!.options.cols, sessions[0]!.options.rows], [100, 30]);
  assert.deepEqual(sessions[0]!.options.env, { PATH: "/bin" });
});

test("output is kept per terminal, replayed on attach, and numbered so a view can skip what it already has", () => {
  const { host, sessions, events } = setup();
  const first = host.open("task-a", "/w", 80, 24);
  const second = host.open("task-b", "/w", 80, 24);
  sessions[0]!.options.onData("hello\r\n");
  sessions[0]!.options.onData("world\r\n");
  sessions[1]!.options.onData("other task\r\n");
  const outputs = events.filter((event) => event.type === "output");
  assert.deepEqual(outputs.map((event) => event.type === "output" && [event.terminal, event.seq]), [[first.id, 1], [first.id, 2], [second.id, 1]]);
  // Another task is on screen meanwhile; coming back replays the whole scrollback.
  assert.deepEqual(host.attach(first.id), { data: "hello\r\nworld\r\n", seq: 2 });
  assert.deepEqual(host.attach(second.id), { data: "other task\r\n", seq: 1 });
  assert.equal(host.attach("00000000-0000-4000-8000-000000000000"), null);
});

test("input and resize reach a running shell only, and an exited terminal keeps its output and exit code", () => {
  const { host, sessions } = setup();
  const info = host.open("task-a", "/w", 80, 24);
  host.input(info.id, "ls\r");
  host.resize(info.id, 120, 40);
  assert.deepEqual(sessions[0]!.written, ["ls\r"]);
  assert.deepEqual(sessions[0]!.sizes, [[120, 40]]);
  sessions[0]!.options.onData("done\r\n");
  sessions[0]!.options.onExit(3);
  host.input(info.id, "more");
  assert.deepEqual(sessions[0]!.written, ["ls\r"]);
  assert.deepEqual(host.list("task-a").map(({ running, exitCode }) => ({ running, exitCode })), [{ running: false, exitCode: 3 }]);
  assert.equal(host.attach(info.id)?.data, "done\r\n");
});

test("closing a terminal or a task ends the shell trees and drops the scrollback", async () => {
  const { host, sessions, events } = setup();
  const one = host.open("task-a", "/w", 80, 24);
  host.open("task-a", "/w", 80, 24);
  host.open("task-b", "/w", 80, 24);
  await host.close(one.id);
  assert.equal(sessions[0]!.killed, 1);
  assert.equal(host.attach(one.id), null);
  sessions[0]!.options.onData("late output");
  assert.equal(events.some((event) => event.type === "output" && event.data === "late output"), false);
  await host.closeTask("task-a");
  assert.deepEqual(sessions.map((session) => session.killed), [1, 1, 0]);
  assert.deepEqual(host.list("task-a"), []);
  assert.equal(host.list("task-b").length, 1);
});

test("terminals of tasks that are gone are ended when the open tasks are reconciled", async () => {
  const { host, sessions } = setup();
  host.open("kept", "/w", 80, 24);
  host.open("deleted", "/w", 80, 24);
  host.open("deleted", "/w", 80, 24);
  await host.retainTasks(new Set(["kept"]));
  assert.deepEqual(sessions.map((session) => session.killed), [0, 1, 1]);
  assert.equal(host.count, 1);
});

test("quitting ends every shell tree synchronously", () => {
  const { host, sessions } = setup();
  host.open("a", "/w", 80, 24);
  host.open("b", "/w", 80, 24);
  host.closeAllSync();
  assert.deepEqual(sessions.map((session) => session.killedSync), [1, 1]);
  assert.equal(host.count, 0);
});

test("the agent reads only shared terminals, newest used by default, as plain text", () => {
  const { host, sessions } = setup();
  const one = host.open("task-a", "/w", 80, 24);
  const two = host.open("task-a", "/w", 80, 24);
  sessions[0]!.options.onData("\u001b[32mfirst\u001b[0m\r\n");
  sessions[1]!.options.onData("second\r\nthird\r\n");
  host.input(one.id, "x");
  assert.deepEqual(host.read("task-a", { lines: 10 }), {
    terminals: [{ index: 1, running: true, exitCode: null }, { index: 2, running: true, exitCode: null }], terminal: 1, text: "first",
  });
  assert.equal(host.read("task-a", { terminal: 2, lines: 1 }).text, "third");
  host.share(two.id, false);
  const hidden = host.read("task-a", { terminal: 2, lines: 5 });
  assert.deepEqual(hidden, { terminals: [{ index: 1, running: true, exitCode: null }], terminal: null, text: "" });
  host.share(one.id, false);
  assert.deepEqual(host.read("task-a", { lines: 5 }), { terminals: [], terminal: null, text: "" });
  assert.deepEqual(host.read("task-b", { lines: 5 }), { terminals: [], terminal: null, text: "" });
});

test("changes to a task's terminals are published with the current list", async () => {
  const { host, events } = setup();
  const info = host.open("task-a", "/w", 80, 24);
  host.share(info.id, false);
  await host.close(info.id);
  const changes = events.filter((event) => event.type === "changed");
  assert.deepEqual(changes.map((event) => event.type === "changed" && event.terminals.map(({ shared }) => shared)), [[true], [false], []]);
});
