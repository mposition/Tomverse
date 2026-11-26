import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parallelCommand, scheduleCommand } from "../src/parallel-contract";

const here = dirname(fileURLToPath(import.meta.url));
const desktopSource = join(here, "..", "src");
const cliSource = join(here, "..", "..", "tomverse-cli", "src");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("the agent has no way to make or change a schedule: nothing in its runtime or tools knows schedules exist", () => {
  const offenders = sources(cliSource).filter((file) => !file.endsWith("sandbox-windows.ts")).filter((file) =>
    /schedul|parallel-contract|schedule-engine|task-lanes/i.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders.map((file) => relative(cliSource, file)), []);
  // The Desktop runtime process (the one that runs the agent) does not import the schedule or lane code either.
  const runner = readFileSync(join(desktopSource, "host", "runner-process.ts"), "utf8");
  assert.doesNotMatch(runner, /schedule|parallel-contract|task-lanes|parallel-host/i);
});

test("schedules and lanes are changed only through the typed commands of the window the person uses", () => {
  const main = readFileSync(join(desktopSource, "host", "main.ts"), "utf8");
  for (const channel of ["desktop:schedules", "desktop:parallel", "desktop:start-parallel"]) {
    assert.match(main, new RegExp(`main\\("${channel}"`), `${channel} goes through main(), which only the signed-in main window may call`);
  }
  const host = readFileSync(join(desktopSource, "host", "parallel-host.ts"), "utf8");
  assert.match(host, /scheduleCommand\.parse\(value\)/);
  assert.match(host, /parallelCommand\.parse\(value\)/);
  // A task's own window gets its task from the window it is bound to, never from anything the page sends.
  assert.match(host, /ipcMain\.handle\("task-window:read", \(event\) => windowView\(boundKey\(event\)\)\)/);
  assert.match(host, /ipcMain\.handle\("task-window:stop", \(event\) => lanes\.stop\(boundKey\(event\)\)\)/);
  const preload = readFileSync(join(desktopSource, "host", "preload.ts"), "utf8");
  const taskBranch = preload.slice(preload.indexOf('location.pathname === "/task"'), preload.indexOf('location.pathname === "/login"'));
  assert.doesNotMatch(taskBranch, /desktop:/, "the task window's bridge reaches no desktop: channel");
  assert.match(taskBranch, /task-window:read/);
});

test("the typed commands carry no folder, process id or approval answer", () => {
  assert.equal(parallelCommand.safeParse({ action: "stop", key: "../../etc" }).success, false);
  assert.equal(parallelCommand.safeParse({ action: "stop", key: "00000000-0000-4000-8000-000000000001", folder: "/x" }).success, false);
  assert.equal(parallelCommand.safeParse({ action: "observe", keys: ["a", "b", "c"] }).success, false);
  assert.equal(parallelCommand.safeParse({ action: "set-limit", limit: 0 }).success, false);
  assert.equal(parallelCommand.safeParse({ action: "set-limit", limit: 99 }).success, false);
  assert.equal(parallelCommand.safeParse({ action: "answer", key: "00000000-0000-4000-8000-000000000001" }).success, false);
  assert.equal(scheduleCommand.safeParse({ action: "enable", enabled: true, acknowledged: true, bypass: true }).success, false);
  assert.equal(scheduleCommand.safeParse({ action: "run-now", id: "not-an-id" }).success, false);
});

test("the approval window answers lane requests only through the lane that asked", () => {
  const main = readFileSync(join(desktopSource, "host", "main.ts"), "utf8");
  const answer = main.slice(main.indexOf("function answer(decision: Decision)"), main.indexOf("function stop()"));
  assert.match(answer, /parallel\.lanes\.hasApproval\(pending\.id\)/);
  assert.match(answer, /pending\.id !== decision\.id \|\| !parallel\.lanes\.decide\(decision\)/);
});
