import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";

/**
 * Runs one approved command. It runs with the user's own operating-system
 * permissions: the working folder is where it starts, not a sandbox, and it
 * can read or change anything the user can, or use the network.
 *
 * Two forms. `argv` runs a program directly with no shell, so what was
 * approved is exactly what runs. `command` is a line for the named shell
 * (PowerShell on Windows, the user's bash/zsh or /bin/sh elsewhere), and the
 * approval says so. On Windows a .cmd/.bat program (npm, npx, yarn) cannot be
 * run without cmd.exe re-reading its arguments, so argv refuses it and the
 * `command` form is the way to run it.
 */

export type CommandInput = { argv?: string[]; command?: string; cwd?: string; timeoutSeconds?: number };

export type CommandPlan = {
    mode: "argv" | "shell";
    file: string;
    args: string[];
    /** What the approval shows as the command. */
    display: string;
    shell: string | null;
    cwd: string;
    timeoutMs: number;
    envNames: string[];
};

export type CommandResult = {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    cancelled: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    stdoutOmittedBytes: number;
    stderrOmittedBytes: number;
    residualProcesses: number[];
    spawnError?: string;
};

export class CommandError extends Error {}

const MAX_TIMEOUT_MS = 30 * 60_000;

/** Variables an approved command gets. Never a Tomverse key, whatever the config says. */
const BASE_ENV = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL",
];

export const commandEnv = (extraNames: string[] = [], env: NodeJS.ProcessEnv = process.env) => {
    const out: Record<string, string> = {};
    for (const name of [...BASE_ENV, ...extraNames]) {
        if (/^TOMVERSE_/i.test(name)) continue;
        const value = env[name];
        if (typeof value === "string") out[name] = value;
    }
    out.NO_COLOR = "1";
    out.FORCE_COLOR = "0";
    out.TERM = "dumb";
    out.CI = env.CI ?? "";
    if (!out.CI) delete out.CI;
    return out;
};

export const userShell = (env: NodeJS.ProcessEnv = process.env) => {
    if (process.platform === "win32") {
        const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
        return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    }
    const preferred = env.SHELL;
    if (preferred && isAbsolute(preferred) && ["bash", "zsh", "sh", "dash"].includes(basename(preferred)) && existsSync(preferred)) return preferred;
    return "/bin/sh";
};

const shellArgs = (shell: string, command: string) =>
    process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

/** Finds a program on PATH the way Windows would, to tell an .exe from a .cmd. */
const resolveWindowsProgram = (program: string, env: Record<string, string>) => {
    const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
    const candidates = (dir: string) => (extname(program) ? [join(dir, program)] : exts.map((ext) => join(dir, `${program}${ext}`)));
    if (isAbsolute(program) || program.includes("\\") || program.includes("/")) {
        return candidates("").map((p) => p).find((p) => existsSync(p)) ?? (existsSync(program) ? program : null);
    }
    const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
    for (const dir of dirs) {
        const hit = candidates(dir).find((p) => existsSync(p));
        if (hit) return hit;
    }
    return null;
};

const quoteForDisplay = (arg: string) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : JSON.stringify(arg));

export const planCommand = (input: CommandInput, cwd: string, defaultTimeoutMs: number, extraEnv: string[] = []): CommandPlan => {
    const hasArgv = Array.isArray(input.argv) && input.argv.length > 0;
    const hasCommand = typeof input.command === "string" && input.command.trim().length > 0;
    if (hasArgv === hasCommand) throw new CommandError("Give exactly one of argv (a program and its arguments) or command (a shell line).");
    const requested = input.timeoutSeconds;
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw new CommandError("timeoutSeconds must be a positive number.");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, requested ? Math.round(requested * 1000) : defaultTimeoutMs);
    const env = commandEnv(extraEnv);
    const envNames = Object.keys(env).sort();
    if (hasArgv) {
        const argv = input.argv!;
        if (argv.some((a) => typeof a !== "string" || a.includes("\0"))) throw new CommandError("argv must be strings without NUL.");
        let file = argv[0]!;
        if (process.platform === "win32") {
            const resolved = resolveWindowsProgram(file, env);
            if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
                throw new CommandError(
                    `${basename(resolved)} is a batch script; Windows runs it through cmd.exe, which re-reads the arguments. Use the command form instead (it runs in PowerShell and the approval shows it as a shell line).`
                );
            }
            if (resolved) file = resolved;
        }
        return { mode: "argv", file, args: argv.slice(1), display: argv.map(quoteForDisplay).join(" "), shell: null, cwd, timeoutMs, envNames };
    }
    const shell = userShell();
    const command = input.command!;
    if (command.includes("\0")) throw new CommandError("The command cannot contain NUL.");
    return { mode: "shell", file: shell, args: shellArgs(shell, command), display: command, shell, cwd, timeoutMs, envNames };
};

const LIMIT = 32 * 1024;

/** Keeps the first and last 32 KB of a stream and counts what was left out. */
class BoundedCapture {
    private head: Buffer[] = [];
    private headBytes = 0;
    private tail: Buffer[] = [];
    private tailBytes = 0;
    omitted = 0;
    push(chunk: Buffer) {
        if (this.headBytes < LIMIT) {
            const take = chunk.subarray(0, LIMIT - this.headBytes);
            this.head.push(take);
            this.headBytes += take.length;
            chunk = chunk.subarray(take.length);
        }
        if (!chunk.length) return;
        this.tail.push(chunk);
        this.tailBytes += chunk.length;
        while (this.tailBytes > LIMIT && this.tail.length) {
            const first = this.tail[0]!;
            const excess = this.tailBytes - LIMIT;
            if (first.length <= excess) {
                this.tail.shift();
                this.tailBytes -= first.length;
                this.omitted += first.length;
            } else {
                this.tail[0] = first.subarray(excess);
                this.tailBytes -= excess;
                this.omitted += excess;
            }
        }
    }
    text() {
        const head = Buffer.concat(this.head).toString("utf8");
        const tail = Buffer.concat(this.tail).toString("utf8");
        if (!this.omitted) return head + tail;
        return `${head}\n[... ${this.omitted} bytes omitted ...]\n${tail}`;
    }
}

/** Every process recorded below `pid`, including orphans whose parent is gone. */
const windowsDescendants = (pid: number): number[] => {
    const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $seen = @(${pid}); $out = @(); do { $next = @($all | Where-Object { $seen -contains $_.ParentProcessId -and -not ($seen -contains $_.ProcessId) } | ForEach-Object { $_.ProcessId }); $seen += $next; $out += $next } while ($next.Count -gt 0); $out -join ','`;
    const result = spawnSync(userShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    return (result.stdout ?? "").trim().split(",").filter(Boolean).map(Number).filter(Number.isFinite);
};

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const groupAlive = (pgid: number) => {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

/**
 * Ends the command and everything it started. POSIX: the command leads its
 * own process group, which gets SIGTERM then SIGKILL. Windows: the tree is
 * listed, then `taskkill /T /F`. Either way the result lists any process that
 * is still alive afterwards rather than assuming the tree is gone.
 */
export const killTree = async (child: ChildProcess): Promise<number[]> => {
    const pid = child.pid;
    if (!pid) return [];
    if (process.platform === "win32") {
        // End the tree at once; listing it first can take seconds, and the
        // tree keeps running meanwhile.
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
        // Then look for anything below it that survived (an orphan keeps its
        // recorded parent id) and end that too.
        const descendants = windowsDescendants(pid).filter(alive);
        for (const d of descendants) spawnSync("taskkill", ["/PID", String(d), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
        await new Promise((r) => setTimeout(r, 300));
        return [pid, ...descendants].filter(alive);
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        // already gone
    }
    for (let i = 0; i < 20 && groupAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (groupAlive(pid)) {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // gone
        }
        for (let i = 0; i < 20 && groupAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
    }
    return groupAlive(pid) ? [pid] : [];
};

export const runCommand = (plan: CommandPlan, signal: AbortSignal, onOutput?: (stream: "stdout" | "stderr", text: string) => void, extraEnv: string[] = []) =>
    new Promise<CommandResult>((resolve) => {
        const started = Date.now();
        const stdout = new BoundedCapture();
        const stderr = new BoundedCapture();
        let timedOut = false;
        let cancelled = false;
        let residual: number[] = [];
        let killing: Promise<void> | null = null;
        let child: ChildProcess;
        try {
            child = spawn(plan.file, plan.args, {
                cwd: plan.cwd,
                env: commandEnv(extraEnv),
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
                windowsHide: true,
                // Its own process group on POSIX, so the whole tree can be ended.
                detached: process.platform !== "win32",
            });
        } catch (error) {
            resolve({ exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 0, stdout: "", stderr: "", stdoutOmittedBytes: 0, stderrOmittedBytes: 0, residualProcesses: [], spawnError: String((error as Error).message) });
            return;
        }
        const stop = (why: "timeout" | "cancel") => {
            if (killing) return;
            if (why === "timeout") timedOut = true;
            else cancelled = true;
            killing = killTree(child).then((left) => {
                residual = left;
            });
        };
        const timer = setTimeout(() => stop("timeout"), plan.timeoutMs);
        const onAbort = () => stop("cancel");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout.push(chunk);
            onOutput?.("stdout", chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr.push(chunk);
            onOutput?.("stderr", chunk.toString("utf8"));
        });
        let spawnError: string | undefined;
        child.on("error", (error) => {
            spawnError = error.message;
        });
        child.on("close", async (code, sig) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (killing) await killing;
            else if (process.platform !== "win32" && child.pid && groupAlive(child.pid)) {
                // The command exited but left background processes in its group.
                residual = await killTree(child);
            }
            resolve({
                exitCode: code,
                signal: sig,
                timedOut,
                cancelled,
                durationMs: Date.now() - started,
                stdout: stdout.text(),
                stderr: stderr.text(),
                stdoutOmittedBytes: stdout.omitted,
                stderrOmittedBytes: stderr.omitted,
                residualProcesses: residual,
                ...(spawnError ? { spawnError } : {}),
            });
        });
    });
