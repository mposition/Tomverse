import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalApi, type TerminalWorkspace } from "../src/host/terminal-api";
import { TerminalHost } from "../src/host/terminal-host";
import type { TerminalLaunch, TerminalLaunchOptions } from "../src/host/terminal-session";
import type { TerminalInfo, TerminalListing } from "../src/terminal-contract";

function setup(initial: { enabled?: boolean; workspace?: TerminalWorkspace | null } = {}) {
  const launched: TerminalLaunchOptions[] = [];
  let killed = 0;
  const launch: TerminalLaunch = (options) => {
    launched.push(options);
    return { kind: "pty", pid: 1, write() {}, resize() {}, async kill() { killed += 1; }, killSync() {} };
  };
  const host = new TerminalHost({ launch, env: () => ({}), emit: () => {} });
  const flags = { enabled: initial.enabled ?? true, workspace: initial.workspace === undefined ? { task: "task-a", cwd: "/worktree/a" } : initial.workspace };
  const api = createTerminalApi({ host, workspace: () => flags.workspace, enabled: () => flags.enabled,
    setEnabled: (enabled) => { flags.enabled = enabled; } });
  return { api, host, flags, launched, killed: () => killed };
}
const open = { type: "open", task: "task-a", cols: 80, rows: 24 } as const;

test("a terminal starts in the folder the host resolved for the open task, whatever the window sends", async () => {
  const { api, launched } = setup();
  const info = await api.run(open) as TerminalInfo;
  assert.equal(info.index, 1);
  assert.equal(launched[0]!.cwd, "/worktree/a");
  await assert.rejects(api.run({ ...open, cwd: "/etc" }), /./);
  await assert.rejects(api.run({ ...open, task: "task-b" }), /task changed/);
  assert.equal(launched.length, 1);
});

test("nothing opens while terminals are off or no task is open, and a listing says so", async () => {
  const off = setup({ enabled: false });
  await assert.rejects(off.api.run(open), /terminal is off/);
  assert.deepEqual(await off.api.run({ type: "list", task: "task-a" }), { enabled: false, terminals: [] } satisfies TerminalListing);
  const none = setup({ workspace: null });
  await assert.rejects(none.api.run(open), /Open a task/);
  assert.deepEqual(await none.api.run({ type: "list", task: "task-a" }), { enabled: true, terminals: [] });
  assert.equal(none.api.read({ lines: 5 }), null);
});

test("turning terminals off ends every shell", async () => {
  const { api, host, killed } = setup();
  await api.run(open);
  await api.run(open);
  await api.run({ type: "set-enabled", enabled: false });
  assert.equal(killed(), 2);
  assert.equal(host.count, 0);
});

test("the agent reads only the open task's shared terminals while terminals are on", async () => {
  const { api, host, flags, launched } = setup();
  const info = await api.run(open) as TerminalInfo;
  launched[0]!.onData("build ok\r\n");
  assert.deepEqual(api.read({ lines: 5 }), { terminals: [{ index: 1, running: true, exitCode: null }], terminal: 1, text: "build ok" });
  host.share(info.id, false);
  assert.deepEqual(api.read({ lines: 5 })?.terminals, []);
  host.share(info.id, true);
  flags.workspace = { task: "task-b", cwd: "/worktree/b" };
  assert.deepEqual(api.read({ lines: 5 })?.terminals, [], "Another task's terminals are not readable.");
  flags.enabled = false;
  assert.equal(api.read({ lines: 5 }), null);
});
