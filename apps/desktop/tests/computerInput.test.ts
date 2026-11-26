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
  "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, idleMs: 5, inputTick: 4242 }) + '\\n');",
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
    assert.deepEqual(await backend.lastInput(), { idleMs: 5, inputTick: 4242 });
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
    await backend.lastInput();
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
    const input = await backend.lastInput();
    assert.ok(Number.isFinite(input.idleMs) && input.idleMs >= 0);
    // The input tick is a 32-bit timer tick, on the clock the script stamps its own input with.
    assert.ok(Number.isInteger(input.inputTick) && input.inputTick >= 0 && input.inputTick <= 0xffffffff);
  } finally { backend.dispose(); }
});

// ── An input refused after an earlier one went out ────────────────────────

test("a refusal after the first click or the first wheel input reports how much went out, and a refusal before any input does not", () => {
  // Every mouse refusal goes through Refused with the number of inputs already sent; none returns a bare "performed: false" after an input.
  const afterPointer = actSection.slice(actSection.indexOf("Thread.Sleep(20);"), actSection.indexOf('kind == "key"'));
  assert.doesNotMatch(afterPointer, /d\["reason"\] = why/, "once the pointer is placed, no refusal is built by hand: each goes through Refused");
  const click = actSection.slice(actSection.indexOf("for (int i = 0; i < times; i++)"), actSection.indexOf("} else {\n        int dx"));
  assert.match(click, /if \(why != null\) return Refused\(d, why, i, times\);/, "the second click's refusal counts the first");
  assert.match(click, /catch \(Exception\) \{ if \(i == 0\) throw; why = "input-failed"; \}/, "a Windows failure on the second click is reported as partial, on the first it is an error");
  const scroll = actSection.slice(actSection.indexOf("int steps ="), actSection.indexOf("d[\"performed\"] = true;"));
  assert.match(scroll, /Refused\(d, why, done, steps\)/);
  assert.equal([...scroll.matchAll(/done\+\+;/g)].length, 1, "the first wheel input is counted once it is sent");
  assert.ok(scroll.indexOf("done++;") > scroll.indexOf("Send(Mouse(0x800"), "...and only after it is sent");
  assert.match(scroll, /catch \(Exception\) \{ if \(done == 0\) throw; why = "input-failed"; \}/);
  const refused = WINDOWS_COMPUTER_SCRIPT.slice(WINDOWS_COMPUTER_SCRIPT.indexOf("static Dictionary<string, object> Refused("), WINDOWS_COMPUTER_SCRIPT.indexOf("static int IdleMs()"));
  assert.match(refused, /d\["performed"\] = false; d\["reason"\] = why;/);
  assert.match(refused, /if \(done > 0\) \{ d\["done"\] = done; d\["of"\] = of; \}/, "nothing is added when nothing went out");
});

test("typing that stops after some characters went out is never reported as performed or as untouched", () => {
  const typing = actSection.slice(actSection.indexOf('kind == "type"'), actSection.indexOf('Unknown input kind'));
  assert.match(typing, /if \(!IsFront\(h\)\) \{ d\["performed"\] = false; d\["reason"\] = "focus-lost"; d\["typed"\] = sent; return d; \}/);
  assert.doesNotMatch(typing, /performed"\] = sent > 0/);
  assert.match(typing, /catch \(Exception\) \{ if \(sent == 0\) throw; d\["performed"\] = false; d\["reason"\] = "input-failed"; d\["typed"\] = sent; return d; \}/);
});

// A stand-in that answers "act" as the script does when the second click was refused.
const ANSWERING = [
  "process.stdout.write(JSON.stringify({ ready: true }) + '\\n');",
  "require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const req = JSON.parse(line);",
  "  const reply = req.kind === 'type' ? { performed: false, reason: 'focus-lost', typed: 32 }",
  "    : req.double ? { performed: false, reason: 'cursor-moved', done: 1, of: 2 } : { performed: false, reason: 'covered-point' };",
  "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, ...reply }) + '\\n');",
  "});",
].join("\n");

test("the Windows backend hands the partial counts of an answer to the host", async () => {
  const backend = createWindowsBackend({ powershell: process.execPath, args: ["-e", ANSWERING] });
  try {
    assert.deepEqual(await backend.act(WINDOW, SIZE, CLICK, 0), { performed: false, reason: "cursor-moved", delivered: 1, planned: 2 });
    assert.deepEqual(await backend.act(WINDOW, SIZE, { ...CLICK, double: false }, 0), { performed: false, reason: "covered-point" }, "nothing went out: no counts");
    assert.deepEqual(await backend.act(WINDOW, SIZE, { kind: "type", text: "x".repeat(40) }, 0), { performed: false, reason: "focus-lost", typed: 32 });
  } finally { backend.dispose(); }
});

test("between the parts of one action the script looks for input that is not its own", () => {
  const helper = WINDOWS_COMPUTER_SCRIPT.slice(WINDOWS_COMPUTER_SCRIPT.indexOf("static bool OtherInputSince("), WINDOWS_COMPUTER_SCRIPT.indexOf("static Dictionary<string, object> Act("));
  assert.match(WINDOWS_COMPUTER_SCRIPT, /static uint InputTick\(\) \{[^}]*GetLastInputInfo\(ref i\); return i\.dwTime;/);
  assert.match(helper, /Sent && unchecked\(\(int\)\(InputTick\(\) - LastSent\)\) > 16/, "the stamp of the agent's own input, compared as a signed difference");
  const typing = actSection.slice(actSection.indexOf('kind == "type"'), actSection.indexOf('Unknown input kind'));
  const check = typing.indexOf('if (sent > 0 && OtherInputSince()) { d["performed"] = false; d["reason"] = "user-input"; d["typed"] = sent; return d; }');
  assert.ok(check > 0 && check < typing.indexOf("Send(batch.ToArray())"), "a batch is checked before it is sent");
  assert.match(typing, /try \{ Send\(batch\.ToArray\(\)\); \}/);
  const click = actSection.slice(actSection.indexOf('kind == "click"'), actSection.indexOf('kind == "key"'));
  assert.match(click, /if \(why == null && i > 0 && OtherInputSince\(\)\) why = "user-input";/);
  assert.match(click, /if \(why == null && done > 0 && OtherInputSince\(\)\) why = "user-input";/);
  assert.doesNotMatch(actSection, /sentAt/, "one stamp for every path, not one per path");
});

test("the script stamps the agent's own input on the system tick clock and hands the host both ticks", () => {
  const send = WINDOWS_COMPUTER_SCRIPT.slice(WINDOWS_COMPUTER_SCRIPT.indexOf("static void Send("), WINDOWS_COMPUTER_SCRIPT.indexOf("static bool IsExtended("));
  // The tick is read before the input goes out: input of the person after it, however late this thread runs on, is never the agent's.
  assert.match(send, /uint before = \(uint\)Environment\.TickCount;\s+uint n = SendInput\(/);
  assert.match(send, /if \(n > 0\) \{ LastSent = before; Sent = true; \}/);
  assert.doesNotMatch(send, /LastSent = \(uint\)Environment\.TickCount/);
  // Every mouse and keyboard input of the action is sent by Send (and the hand-back key press stamps itself).
  assert.equal([...actSection.matchAll(/SendInput\(/g)].length, 0);
  assert.match(WINDOWS_COMPUTER_SCRIPT, /static void Activate\(IntPtr h\) \{\s+LastSent = \(uint\)Environment\.TickCount; Sent = true;\s+keybd_event\(/);
  // act: the tick of the last input that went out, only when one did; the old idle time is no longer part of the answer.
  assert.match(WINDOWS_COMPUTER_SCRIPT, /Sent = false;\s+foreach \(var kv in Act\(req\)\) res\[kv\.Key\] = kv\.Value;\s+if \(Sent\) res\["sentTick"\] = \(long\)LastSent;/);
  assert.doesNotMatch(actSection, /idleMs/);
  // idle: how long ago and the system's tick of it.
  assert.match(WINDOWS_COMPUTER_SCRIPT, /op == "idle"\) \{ res\["ok"\] = true; res\["idleMs"\] = IdleMs\(\); res\["inputTick"\] = \(long\)InputTick\(\); \}/);
});

test("the Windows backend hands the sent tick of an action and the input tick of the system to the host", async () => {
  const TICKS = [
    "process.stdout.write(JSON.stringify({ ready: true }) + '\\n');",
    "require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const req = JSON.parse(line);",
    "  const reply = req.op === 'act' ? { performed: true, sentTick: 4294967290 } : { idleMs: 3, inputTick: 12 };",
    "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, ...reply }) + '\\n');",
    "});",
  ].join("\n");
  const backend = createWindowsBackend({ powershell: process.execPath, args: ["-e", TICKS] });
  try {
    assert.deepEqual(await backend.act(WINDOW, SIZE, CLICK, 0), { performed: true, sentTick: 4_294_967_290 });
    assert.deepEqual(await backend.lastInput(), { idleMs: 3, inputTick: 12 });
  } finally { backend.dispose(); }
});
