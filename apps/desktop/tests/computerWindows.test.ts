import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import type { ComputerAgentReply } from "../../tomverse-cli/src/computer-tools";
import { createWindowsBackend } from "../src/host/computer-backend-windows";
import { windowDenial } from "../src/host/computer-deny";
import { createComputerHost } from "../src/host/computer-host";

/**
 * The Windows backend against REAL windows. It opens small WinForms windows of its own (a green window with a red button and a
 * yellow text box), takes their pictures, clicks, types and presses keys through SendInput, covers one with another and minimizes
 * it. It moves the real mouse and sends real key presses, and it needs the test window to hold the focus, so it runs only when
 * TOMVERSE_COMPUTER_WINDOWS_TEST=1 and not while someone is working on the same PC. When the focus is taken away the actions are
 * "not done", and the test checks exactly that: nothing may ever land in a window that was not the chosen one.
 */
const enabled = process.platform === "win32" && process.env.TOMVERSE_COMPUTER_WINDOWS_TEST === "1";
const FORM = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:TV_TITLE
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point([int]$env:TV_X, [int]$env:TV_Y)
$form.Size = New-Object System.Drawing.Size(420, 320)
$form.TopMost = $true
$parts = $env:TV_COLOR.Split(',')
$form.BackColor = [System.Drawing.Color]::FromArgb([int]$parts[0], [int]$parts[1], [int]$parts[2])
$button = New-Object System.Windows.Forms.Button
$button.FlatStyle = 'Flat'
$button.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 0)
$button.Location = New-Object System.Drawing.Point(30, 40)
$button.Size = New-Object System.Drawing.Size(120, 60)
$button.Add_Click({ [Console]::Out.WriteLine('clicked'); [Console]::Out.Flush() })
$box = New-Object System.Windows.Forms.TextBox
$box.BackColor = [System.Drawing.Color]::FromArgb(255, 255, 0)
$box.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$box.Location = New-Object System.Drawing.Point(30, 140)
$box.Size = New-Object System.Drawing.Size(330, 40)
$box.Add_TextChanged({ [Console]::Out.WriteLine('text:' + $box.Text); [Console]::Out.Flush() })
$form.Controls.Add($button)
$form.Controls.Add($box)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (Test-Path $env:TV_CMD) {
    $command = (Get-Content $env:TV_CMD -Raw).Trim()
    Remove-Item $env:TV_CMD
    if ($command -eq 'min') { $form.WindowState = 'Minimized' }
    elseif ($command -eq 'close') { $form.Close() }
  }
})
$timer.Start()
$form.Add_Shown({ $form.Activate(); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($form)
`;

type TestWindow = { title: string; child: ChildProcessWithoutNullStreams; lines: string[]; command: string; send(text: string): void; close(): Promise<void> };

async function until<T>(read: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

async function openWindow(folder: string, name: string, color: string, x: number, y: number): Promise<TestWindow> {
  const title = `Tomverse computer test ${name} ${process.pid}`;
  const command = join(folder, name + ".cmd");
  const script = join(folder, name + ".ps1");
  writeFileSync(script, FORM, "utf8");
  // A window of powershell.exe is a terminal's program and is never offered, so the test program runs from a copy under its own name.
  const program = join(folder, "tvtestwin.exe");
  try { copyFileSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), program); } catch { /* Already copied. */ }
  const child = spawn(program, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], {
    env: { ...process.env, TV_TITLE: title, TV_COLOR: color, TV_X: String(x), TV_Y: String(y), TV_CMD: command }, windowsHide: false,
  });
  const lines: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffer += text;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { lines.push(buffer.slice(0, at).trim()); buffer = buffer.slice(at + 1); }
  });
  await until(() => lines.includes("ready"), `window ${name} to open`, 30_000);
  return {
    title, child, lines, command,
    send(text) { writeFileSync(command, text); },
    async close() {
      writeFileSync(command, "close");
      await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill(); resolve(); }, 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    },
  };
}

/** The pixels of a PNG the backend made (8-bit RGB or RGBA, not interlaced). */
function decodePng(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  let at = 8;
  let width = 0, height = 0, channels = 3;
  const data: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : 3; assert.equal(body[8], 8); assert.equal(body[12], 0); }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? out[y * stride + x - channels]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const paeth = () => { const p = left + up - upLeft; const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft); return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; };
      out[y * stride + x] = (value + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth())) & 255;
    }
  }
  const find = (r: number, g: number, b: number) => {
    let count = 0, sx = 0, sy = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = y * stride + x * channels;
      // PNG stores R, G, B in this order.
      if (Math.abs(out[i]! - r) < 40 && Math.abs(out[i + 1]! - g) < 40 && Math.abs(out[i + 2]! - b) < 40) { count += 1; sx += x; sy += y; }
    }
    return { count, x: count ? Math.round(sx / count) : -1, y: count ? Math.round(sy / count) : -1 };
  };
  return { width, height, find };
}

test("real windows: the picture is the chosen window only, clicks, typing and keys land in it, and nothing lands when it is not in front", { skip: !enabled && "set TOMVERSE_COMPUTER_WINDOWS_TEST=1 on Windows to run this against real windows", timeout: 240_000 }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "tomverse-computer-test-"));
  const backend = createWindowsBackend();
  const windows: TestWindow[] = [];
  try {
    const target = await openWindow(folder, "a", "12,200,34", 120, 120);
    windows.push(target);
    const listed = await backend.list();
    const row = listed.find((entry) => entry.title === target.title);
    assert.ok(row, "the window is in the list");
    assert.equal(row.pid, target.child.pid, "the list names the process that owns it");
    assert.equal(windowDenial(row, [process.pid]), null, "a window of a small test program may be chosen");
    assert.equal(windowDenial({ app: "cmd", cls: "ConsoleWindowClass", pid: 1 }, [process.pid]), "terminal");

    // A host over the real backend, with a person who is never touching the machine (the test sends the input itself).
    const replies: ComputerAgentReply[] = [];
    const host = createComputerHost({
      createBackend: () => backend, enabled: () => true, setEnabled: () => undefined,
      run: () => ({ runId: "run", taskId: "task", running: true, apiExecution: true, suspended: false, scope: "acct" }),
      ownPids: () => [process.pid], publish: () => undefined, reply: (_run, _request, reply) => replies.push(reply), clean: (text) => text,
      registerStopKey: () => true, unregisterStopKey: () => undefined, now: () => Date.now(),
    });
    const ask = async (request: unknown) => { const before = replies.length; await host.handle({ runId: "run", requestId: String(before), request }); return replies[before]!; };
    await host.command({ type: "select", id: row.id });
    // The agent acts only while the window is in front; the machine may have taken the focus (another test, the person).
    const info = await backend.info({ id: row.id, pid: row.pid, cls: row.cls });
    assert.equal(info.gone, false);
    if (info.gone || !info.foreground) { t.skip("the test window could not take the focus on this machine"); return; }

    // 1. The picture is that window and only that window.
    const first = await ask({ tool: "screenshot" });
    assert.ok(first.status === "ok" && first.image && first.position === "front", JSON.stringify({ ...first, image: undefined }));
    const picture = decodePng(first.image!.base64);
    assert.equal(picture.width, first.width);
    assert.ok(picture.width < 1000 && picture.height < 800, "a window, not the screen");
    const green = picture.find(12, 200, 34), red = picture.find(255, 0, 0), yellow = picture.find(255, 255, 0);
    assert.ok(green.count > picture.width * picture.height * 0.2, "the window's own colour fills it");
    assert.ok(red.count > 500 && yellow.count > 500, "its button and text box are in the picture");

    // 2. A click on the red button, by the picture's own coordinates, lands in the window.
    const click = await ask({ tool: "click", window: row.id, x: red.x, y: red.y, button: "left", double: false });
    assert.equal(click.status, "ok", JSON.stringify(click));
    await until(() => target.lines.includes("clicked"), "the click to reach the button", 5_000);

    // 3. Typing goes where the focus is: click the text box, type text with non-ASCII characters, then edit with keys.
    assert.equal((await ask({ tool: "click", window: row.id, x: yellow.x, y: yellow.y, button: "left", double: false })).status, "ok");
    assert.equal((await ask({ tool: "type", window: row.id, text: "Ada Ünï 한글" })).status, "ok");
    await until(() => target.lines.includes("text:Ada Ünï 한글"), "the typed text to reach the text box", 5_000);
    assert.equal((await ask({ tool: "key", window: row.id, key: "ctrl+a" })).status, "ok");
    assert.equal((await ask({ tool: "key", window: row.id, key: "backspace" })).status, "ok");
    await until(() => target.lines.at(-1) === "text:", "the keys to clear the text", 5_000);

    // 4. Points outside the picture are not clicked.
    const clicksBefore = target.lines.filter((line) => line === "clicked").length;
    const outside = await ask({ tool: "click", window: row.id, x: picture.width + 5, y: 5, button: "left", double: false });
    assert.equal(outside.status, "error");

    // 5. Another window comes in front and covers part of it: the picture is still the chosen window alone, it says it is behind,
    //    and no input is sent (it would land in the other window).
    const cover = await openWindow(folder, "b", "0,0,255", 120, 120);
    windows.push(cover);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const behind = await ask({ tool: "screenshot" });
    assert.ok(behind.status === "ok" && behind.image, JSON.stringify({ ...behind, image: undefined }));
    assert.equal(behind.position, "behind");
    assert.equal(decodePng(behind.image!.base64).find(0, 0, 255).count, 0, "the covering window is not in the picture");
    const refused = await ask({ tool: "click", window: row.id, x: red.x, y: red.y, button: "left", double: false });
    assert.equal(refused.status, "error");
    assert.match((refused as { message: string }).message, /not in front|Another window is over/);
    assert.equal((await ask({ tool: "type", window: row.id, text: "must not land" })).status, "error");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(target.lines.filter((line) => line === "clicked").length, clicksBefore, "no click landed in the chosen window");
    assert.equal(cover.lines.filter((line) => line !== "ready").length, 0, "nothing at all landed in the window that was in front");
    assert.ok(!target.lines.includes("text:must not land"));

    // 6. A window of another program may not hand the focus back: the backend refuses unless the front window is Tomverse's own.
    const direct = await backend.act({ id: row.id, pid: row.pid, cls: row.cls }, { width: info.width, height: info.height }, { kind: "key", ctrl: false, shift: false, vk: 0x0d }, 0);
    assert.equal(direct.performed, false);
    await cover.close();
    windows.pop();

    // 7. Minimized: no picture, no input.
    target.send("min");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const minimized = await ask({ tool: "screenshot" });
    assert.ok(minimized.status === "ok" && minimized.position === "minimized" && !minimized.image);
    assert.equal((await ask({ tool: "key", window: row.id, key: "enter" })).status, "error");

    // 8. Closed: the choice ends.
    await target.close();
    windows.pop();
    const gone = await ask({ tool: "screenshot" });
    assert.equal(gone.status, "error");
    assert.equal(host.state().selected, null);
  } finally {
    for (const window of windows) { try { await window.close(); } catch { /* Already closed. */ } }
    backend.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});
