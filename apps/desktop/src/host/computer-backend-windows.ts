import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActOutcome, BackendAction, ComputerBackend, RawWindow, WindowGone, WindowImage, WindowRef, WindowStatus } from "./computer-backend";
import { WINDOWS_COMPUTER_SCRIPT } from "./computer-win-script";

/**
 * The Windows backend: one Windows PowerShell process that holds the compiled P/Invoke class (computer-win-script.ts) and answers
 * one JSON line per request. Nothing is built or installed, nothing is written but the script itself (in a private temporary folder,
 * removed when the process ends), and pictures only ever travel through the pipe: they are never written to a file.
 */

const START_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 15_000;

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** JSON with every non-ASCII character as an escape, so no console code page can change what is typed or read. */
const asciiJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

export function parseWindowId(id: string): { hwnd: string; pid: number } {
  const match = /^([0-9a-f]{1,16}):([0-9]{1,10})$/.exec(id);
  if (!match) throw new Error("Not a window id.");
  return { hwnd: match[1]!, pid: Number(match[2]) };
}
const ref = (window: WindowRef) => ({ ...parseWindowId(window.id), cls: window.cls });

/** `args` replaces the PowerShell arguments; only a test that runs a stand-in program sets it. */
export function createWindowsBackend(options: { powershell?: string; args?: string[] } = {}): ComputerBackend {
  const powershell = options.powershell ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let child: ChildProcessWithoutNullStreams | undefined;
  let folder: string | undefined;
  let ready: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const stop = (reason: string) => {
    const running = child;
    child = undefined;
    ready = undefined;
    // Only the process this backend started is ended, through its own handle, and first, so nothing more is sent to the desktop.
    if (running) { try { running.kill(); } catch { /* Already gone. */ } }
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(reason)); pending.delete(id); }
    if (folder) { try { rmSync(folder, { recursive: true, force: true }); } catch { /* Best effort; it holds only the script. */ } folder = undefined; }
  };

  function start(): Promise<void> {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      folder = mkdtempSync(join(tmpdir(), "tomverse-computer-" + randomBytes(3).toString("hex") + "-"));
      mkdirSync(folder, { recursive: true });
      const script = join(folder, "host.ps1");
      writeFileSync(script, WINDOWS_COMPUTER_SCRIPT, "utf8");
      // The script is run from its text, not as a file, so a machine whose execution policy blocks scripts still runs it.
      const proc = spawn(powershell, options.args ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:TOMVERSE_COMPUTER_SCRIPT)))"], {
        env: { ...process.env, TOMVERSE_COMPUTER_SCRIPT: script }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      let buffer = "";
      let errors = "";
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; stop("PowerShell did not start in time."); reject(new Error("PowerShell did not start in time.")); } }, START_TIMEOUT_MS);
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (text: string) => { errors = (errors + text).slice(-600); });
      proc.stdout.on("data", (text: string) => {
        buffer += text;
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          let value: Record<string, unknown>;
          try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          if (value.ready === true && !settled) { settled = true; clearTimeout(timer); resolve(); continue; }
          const entry = typeof value.id === "number" ? pending.get(value.id) : undefined;
          if (entry && typeof value.id === "number") { clearTimeout(entry.timer); pending.delete(value.id); entry.resolve(value); }
        }
      });
      const ended = (reason: string) => {
        if (child !== proc) return;
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(reason)); }
        stop(reason);
      };
      proc.on("error", (error) => ended(`PowerShell could not start (${error.message}).`));
      proc.on("exit", () => ended("PowerShell ended" + (errors ? `: ${errors.trim().slice(0, 300)}` : ".")));
      proc.stdin.on("error", () => { /* The exit handler reports it. */ });
    });
    ready.catch(() => undefined);
    return ready;
  }

  /** `signal`: when it aborts, the PowerShell process is ended at once, so a request in progress sends nothing more. */
  async function call(op: string, payload: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    await start();
    signal?.throwIfAborted();
    const proc = child;
    if (!proc) throw new Error("PowerShell is not running.");
    const id = nextId++;
    const onAbort = () => stop(`The ${op} request was stopped.`);
    let answer: Record<string, unknown>;
    try {
      answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); stop(`The ${op} request timed out.`); reject(new Error(`The ${op} request timed out.`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        signal?.addEventListener("abort", onAbort, { once: true });
        proc.stdin.write(asciiJson({ id, op, ...payload }) + "\n");
      });
    } finally { signal?.removeEventListener("abort", onAbort); }
    if (answer.ok !== true) throw new Error(String(answer.error ?? "The window request failed.").slice(0, 300));
    return answer;
  }

  const status = (value: Record<string, unknown>): WindowStatus => ({
    gone: false, title: String(value.title ?? ""), app: String(value.app ?? ""), minimized: value.minimized === true, foreground: value.foreground === true,
    covered: value.covered === true, foregroundPid: Number(value.fgPid ?? 0), width: Number(value.w ?? 0), height: Number(value.h ?? 0),
  });

  return {
    async list() {
      const answer = await call("list");
      const rows = Array.isArray(answer.windows) ? answer.windows as Array<Record<string, unknown>> : [];
      return rows.map((row): RawWindow => ({ id: `${String(row.hwnd)}:${Number(row.pid)}`, pid: Number(row.pid), cls: String(row.cls ?? ""), title: String(row.title ?? ""), app: String(row.app ?? "") }));
    },
    async info(window): Promise<WindowStatus | WindowGone> {
      const answer = await call("info", ref(window));
      return answer.gone === true ? { gone: true } : status(answer);
    },
    async capture(window, maxEdge) {
      const answer = await call("capture", { ...ref(window), maxEdge }, 25_000);
      if (answer.gone === true) return { gone: true as const };
      const current = status(answer);
      if (typeof answer.base64 !== "string" || current.minimized) return { status: current };
      const image: WindowImage = { mediaType: answer.mediaType === "image/jpeg" ? "image/jpeg" : "image/png", base64: answer.base64,
        imageWidth: Number(answer.imageW), imageHeight: Number(answer.imageH), width: Number(answer.physW), height: Number(answer.physH) };
      return { status: current, image };
    },
    async act(window, size, action: BackendAction, handBackFrom, signal?: AbortSignal): Promise<ActOutcome> {
      const answer = await call("act", { ...ref(window), w: size.width, h: size.height, allowPid: handBackFrom, ...action }, CALL_TIMEOUT_MS, signal);
      return { performed: answer.performed === true, ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
        ...(typeof answer.typed === "number" ? { typed: answer.typed } : {}),
        ...(typeof answer.done === "number" && typeof answer.of === "number" ? { delivered: answer.done, planned: answer.of } : {}),
        ...(typeof answer.idleMs === "number" ? { idleMs: answer.idleMs } : {}) };
    },
    async bringToFront(window) {
      const answer = await call("front", ref(window));
      return answer.foreground === true;
    },
    async idleMs() {
      const answer = await call("idle");
      return Number(answer.idleMs ?? 0);
    },
    dispose() { stop("The window tools were turned off."); },
  };
}
