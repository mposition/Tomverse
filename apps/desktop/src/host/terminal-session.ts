import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type * as NodePty from "node-pty";
import { killTree, killTreeSync } from "../../../tomverse-cli/src/commands.js";

export type TerminalKind = "pty" | "pipe";
export type TerminalSession = {
  readonly kind: TerminalKind;
  readonly pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the shell and everything it started, and resolves when that is done. */
  kill(): Promise<void>;
  /** The same without waiting, for the moment the app is quitting. */
  killSync(): void;
};
export type TerminalLaunchOptions = {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
};
export type TerminalLaunch = (options: TerminalLaunchOptions) => TerminalSession;
export type Shell = { file: string; args: string[] };

/** The person's own shell: PowerShell on Windows, their login shell elsewhere. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Shell {
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return existsSync(powershell) ? { file: powershell, args: ["-NoLogo"] }
      : { file: join(root, "System32", "cmd.exe"), args: [] };
  }
  const configured = env.SHELL;
  const file = [configured, "/bin/bash", "/bin/sh"].find((candidate) => candidate && candidate.startsWith("/") && existsSync(candidate)) ?? "/bin/sh";
  return { file, args: ["-l"] };
}

function ptySession(pty: typeof NodePty, shell: Shell, options: TerminalLaunchOptions): TerminalSession {
  const child = pty.spawn(shell.file, shell.args, {
    name: "xterm-256color", cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env,
  });
  let ended = false;
  child.onData(options.onData);
  child.onExit(({ exitCode }) => { ended = true; options.onExit(exitCode); });
  const release = () => { if (!ended) { try { child.kill(); } catch { /* The shell already ended. */ } } };
  return {
    kind: "pty", pid: child.pid,
    write: (data) => { if (!ended) child.write(data); },
    resize: (cols, rows) => { if (!ended) { try { child.resize(cols, rows); } catch { /* The shell ended while resizing. */ } } },
    kill: async () => {
      if (!ended) await killTree({ pid: child.pid } as ChildProcess);
      release();
    },
    killSync: () => { if (!ended) killTreeSync(child.pid); release(); },
  };
}

/**
 * The limited terminal, for a machine without the native pseudo-terminal module: the shell runs on pipes, so it has no
 * screen editing. The host echoes what is typed and sends a line when Enter is pressed.
 */
export function pipeSession(shell: Shell, options: TerminalLaunchOptions): TerminalSession {
  const child = spawn(shell.file, shell.args, {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    detached: process.platform !== "win32",
  });
  let ended = false;
  let line = "";
  const show = (data: string) => options.onData(data.replace(/\r?\n/g, "\r\n"));
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => { const text = decoder.write(chunk); if (text) show(text); });
  }
  child.stdin.on("error", () => { /* The shell ended while input was being written. */ });
  child.on("error", () => { if (!ended) { ended = true; options.onExit(null); } });
  child.on("close", (code) => { if (!ended) { ended = true; options.onExit(code); } });
  return {
    kind: "pipe", pid: child.pid,
    write(data) {
      if (ended) return;
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          options.onData("\r\n");
          child.stdin.write(line + "\n");
          line = "";
        } else if (character === "\x7f" || character === "\b") {
          if (line) { line = line.slice(0, -1); options.onData("\b \b"); }
        } else if (character === "\x03") {
          line = "";
          options.onData("^C\r\n");
        } else if (character >= " ") {
          line += character;
          options.onData(character);
        }
      }
    },
    resize: () => {},
    kill: async () => { if (!ended) await killTree(child); },
    killSync: () => { if (!ended) killTreeSync(child.pid!); },
  };
}

/** Opens a pseudo-terminal when `loadPty` finds the native module, and the limited pipe shell otherwise. */
export function createTerminalLaunch(loadPty: () => typeof NodePty | null, shell: Shell = defaultShell()): TerminalLaunch {
  return (options) => {
    let pty: typeof NodePty | null = null;
    try { pty = loadPty(); } catch { pty = null; }
    if (pty) {
      try { return ptySession(pty, shell, options); } catch { /* A pseudo-terminal that cannot start falls back to pipes. */ }
    }
    return pipeSession(shell, options);
  };
}
