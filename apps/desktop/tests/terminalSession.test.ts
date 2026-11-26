import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import type * as NodePty from "node-pty";
import { terminalEnv } from "../src/host/terminal-env";
import { createTerminalLaunch, defaultShell, type Shell, type TerminalSession } from "../src/host/terminal-session";

const nodeRequire = createRequire(import.meta.url);
const loadPty = (): typeof NodePty | null => { try { return nodeRequire("node-pty"); } catch { return null; } };
const ptyAvailable = loadPty() !== null;

// A tiny program standing in for a shell: reports where it started and what it was given, starts a grandchild
// that must not outlive it, and echoes each line it is sent.
const program = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "console.log('GRANDCHILD=' + grandchild.pid);",
  "console.log('CWD=' + process.cwd());",
  "console.log('PROBE=' + (process.env.TOMVERSE_LEAK_PROBE ?? 'absent') + ' TERM=' + process.env.TERM);",
  "process.stdin.on('data', (data) => console.log('LINE=' + String(data).trim()));",
  "setInterval(() => {}, 1000);",
].join("\n");
const fakeShell: Shell = { file: process.execPath, args: ["-e", program] };

// A native handle that outlives the tests must never keep this process, and the suite around it, from ending.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref(); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
async function until(condition: () => boolean, label: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error("Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exercise(launchPty: boolean, folder: string) {
  const previous = process.env.TOMVERSE_LEAK_PROBE;
  process.env.TOMVERSE_LEAK_PROBE = "must-not-reach-the-shell";
  let output = "";
  let exit: number | null | undefined;
  const launch = createTerminalLaunch(launchPty ? loadPty : () => null, fakeShell);
  let session: TerminalSession | undefined;
  let grandchild: number | undefined;
  try {
    session = launch({ cwd: folder, cols: 100, rows: 30, env: terminalEnv(),
      onData: (data) => { output += data; }, onExit: (code) => { exit = code; } });
    assert.equal(session.kind, launchPty ? "pty" : "pipe");
    await until(() => /GRANDCHILD=\d+/.test(output) && /PROBE=/.test(output), "the program's start-up output");
    assert.match(output, /PROBE=absent TERM=xterm-256color/);
    assert.ok(output.includes("CWD=") && output.toLowerCase().includes(folder.toLowerCase().replaceAll("\\", "/").split("/").pop()!),
      "The shell starts in the folder the host chose.");
    session.write("hello terminal\r");
    await until(() => output.includes("LINE=hello terminal"), "the echoed line");
    grandchild = Number(/GRANDCHILD=(\d+)/.exec(output)![1]);
    assert.ok(alive(grandchild));
    await session.kill();
    await until(() => exit !== undefined, "the exit notification");
    const ended = grandchild;
    await until(() => !alive(ended), "the grandchild to end");
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_LEAK_PROBE; else process.env.TOMVERSE_LEAK_PROBE = previous;
    // Whatever happened above, no shell or grandchild may outlive the test.
    await session?.kill().catch(() => {});
    session?.killSync();
    if (grandchild !== undefined && alive(grandchild)) { try { process.kill(grandchild); } catch { /* Already gone. */ } }
  }
}

test("the limited pipe terminal echoes input, starts in the chosen folder, hides the app's variables and ends the whole tree", { timeout: 60_000 }, async () => {
  await exercise(false, process.cwd());
});

test("the pseudo-terminal does the same when the native module loads", { timeout: 60_000, skip: !ptyAvailable && "node-pty is not available on this platform" }, async () => {
  await exercise(true, process.cwd());
});

test("a pseudo-terminal that cannot load or start falls back to the pipe shell", () => {
  const launch = createTerminalLaunch(() => { throw new Error("native module missing"); }, fakeShell);
  const session = launch({ cwd: process.cwd(), cols: 80, rows: 24, env: terminalEnv(), onData: () => {}, onExit: () => {} });
  try { assert.equal(session.kind, "pipe"); } finally { session.killSync(); }
});

test("the default shell is the person's own: PowerShell on Windows and an absolute login shell elsewhere", () => {
  const windows = defaultShell({ SystemRoot: "C:/Windows" }, "win32");
  assert.match(windows.file, /powershell\.exe$|cmd\.exe$/);
  const posix = defaultShell({ SHELL: "relative/shell" }, "linux");
  assert.ok(posix.file.startsWith("/"), "A relative SHELL value is never run.");
});
