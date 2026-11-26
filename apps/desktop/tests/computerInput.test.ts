import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsBackend } from "../src/host/computer-backend-windows";
import { refusalText } from "../src/host/computer-policy";
import { WINDOWS_COMPUTER_SCRIPT } from "../src/host/computer-win-script";

/**
 * The input path of the Windows backend that can be checked without touching a screen: what the generated script verifies before it
 * sends mouse input, and that stopping a request ends the PowerShell process that is sending it. Nothing here sends real input.
 */

const actSection = (() => {
  const from = WINDOWS_COMPUTER_SCRIPT.indexOf("static Dictionary<string, object> Act(");
  const to = WINDOWS_COMPUTER_SCRIPT.indexOf("static string Escape(");
  assert.ok(from > 0 && to > from);
  return WINDOWS_COMPUTER_SCRIPT.slice(from, to);
})();

test("the script puts the pointer on the target, checks that it got there, and re-checks the pointer and the window right before every mouse input", () => {
  assert.match(WINDOWS_COMPUTER_SCRIPT, /static extern bool GetCursorPos\(out POINT p\)/);
  assert.match(actSection, /if \(!SetCursorPos\(px, py\)\) \{[^}]*"cursor-failed"/, "the result of SetCursorPos is used");

  const check = WINDOWS_COMPUTER_SCRIPT.slice(WINDOWS_COMPUTER_SCRIPT.indexOf("static string PointCheck("), WINDOWS_COMPUTER_SCRIPT.indexOf("static int IdleMs()"));
  for (const part of ["Find(r) != h", "Check(h, r)", "GetCursorPos(out c)", "\"cursor-moved\"", "\"moved\"", "AtPoint(h, f, px, py)"]) assert.ok(check.includes(part), part);

  const sends = [...actSection.matchAll(/Send\(Mouse\(/g)].map((match) => match.index!);
  assert.equal(sends.length, 3, "a click and the two wheel inputs");
  for (const at of sends) {
    const before = actSection.slice(0, at);
    assert.ok(before.lastIndexOf("PointCheck(") > before.lastIndexOf("Send("), "the check comes after the previous input and before this one");
    assert.ok(before.lastIndexOf("PointCheck(") > before.lastIndexOf("SetCursorPos("));
  }
  // The second click of a double click is checked too: the check is inside the loop that sends the clicks.
  const loop = actSection.slice(actSection.indexOf("for (int i = 0; i < times; i++)"));
  assert.ok(loop.indexOf("PointCheck(") > 0 && loop.indexOf("PointCheck(") < loop.indexOf("Send(Mouse(down, 0), Mouse(up, 0))"));
  assert.ok(loop.indexOf("Thread.Sleep(60)") > loop.indexOf("Send(Mouse(down, 0), Mouse(up, 0))"), "the pause sits between the clicks, so the check after it is the one before the second click");
});

test("a refused pointer check tells the agent what happened", () => {
  assert.match(refusalText("cursor-moved"), /pointer was moved/);
  assert.match(refusalText("cursor-failed"), /could not be placed/);
  assert.match(refusalText("moved"), /window moved/);
});

// A stand-in for PowerShell: it answers every request but "act", which it records and never answers, as an input still being sent.
const STAND_IN = [
  "const fs = require('fs');",
  "process.stdout.write(JSON.stringify({ ready: true }) + '\\n');",
  "require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const req = JSON.parse(line);",
  "  if (req.op === 'act') { fs.appendFileSync(process.env.TV_MARK, process.pid + '\\n'); return; }",
  "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, idleMs: 5 }) + '\\n');",
  "});",
].join("\n");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(read: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!read()) { if (Date.now() > end) throw new Error("Timed out waiting for " + what); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
const WINDOW = { id: "1a2b:4242", pid: 4242, cls: "FixtureWindow" };
const SIZE = { width: 400, height: 240 };
const CLICK = { kind: "click", x: 1, y: 1, button: "left", double: true } as const;

test("stopping an input in progress ends the process that is sending it, and only that one", async () => {
  const folder = mkdtempSync(join(tmpdir(), "tomverse-computer-input-"));
  const mark = join(folder, "mark.txt");
  process.env.TV_MARK = mark;
  const backend = createWindowsBackend({ powershell: process.execPath, args: ["-e", STAND_IN] });
  try {
    const controller = new AbortController();
    const sending = backend.act(WINDOW, SIZE, CLICK, 0, controller.signal);
    const outcome = sending.then(() => "answered", (error: Error) => error.message);
    await until(() => existsSync(mark) && readFileSync(mark, "utf8").trim() !== "", "the input to reach the process");
    const pid = Number(readFileSync(mark, "utf8").trim());
    assert.ok(pid > 0 && pid !== process.pid && alive(pid));
    controller.abort();
    assert.match(await outcome, /stopped/, "the request ends with an error, not with an answer");
    await until(() => !alive(pid), "the process to end");
    assert.ok(alive(process.pid), "the host process is untouched");
    // The next request starts a new process and works.
    assert.equal(await backend.idleMs(), 5);
  } finally {
    backend.dispose();
    delete process.env.TV_MARK;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an input that was stopped before it started is never sent", async () => {
  const folder = mkdtempSync(join(tmpdir(), "tomverse-computer-input-"));
  const mark = join(folder, "mark.txt");
  process.env.TV_MARK = mark;
  const backend = createWindowsBackend({ powershell: process.execPath, args: ["-e", STAND_IN] });
  try {
    await backend.idleMs();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => backend.act(WINDOW, SIZE, CLICK, 0, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(mark), false, "the process never saw the request");
  } finally {
    backend.dispose();
    delete process.env.TV_MARK;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the generated script compiles in Windows PowerShell and answers a read-only request (no input is sent)", { skip: process.platform !== "win32" && "Windows only", timeout: 120_000 }, async () => {
  const backend = createWindowsBackend();
  try {
    const idle = await backend.idleMs();
    assert.ok(Number.isFinite(idle) && idle >= 0);
  } finally { backend.dispose(); }
});
