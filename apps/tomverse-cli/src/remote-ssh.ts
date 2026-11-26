import { spawn } from "node:child_process";
import { killTree } from "./commands.js";
import { commandEnv } from "./env.js";
import { sshArguments, type RemoteTarget } from "./remote-target.js";

/**
 * Runs the user's own `ssh`, once per call. Nothing is kept between calls (Windows' OpenSSH has no connection sharing, and the
 * app must not depend on it), so a dropped connection costs one call, never a hidden state. The runner is a plain function so a
 * test can stand in for ssh and for the machine behind it.
 */

export type SshRunRequest = {
    target: Pick<RemoteTarget, "destination" | "port">;
    /** The one string ssh sends to the remote machine (see remoteShellCommand). */
    command: string;
    /** Bytes written to the remote command's input, then the input is closed. */
    stdin?: Buffer;
    /** Keep the remote command's input open until the call ends: a closed input is how the remote side learns the connection is gone. */
    holdStdin?: boolean;
    signal?: AbortSignal;
    timeoutMs: number;
    /** Stop (and say so) once the output is this long. */
    maxStdoutBytes?: number;
    /** Hand output over as it arrives instead of keeping it. */
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
};

export type SshRunResult = {
    exitCode: number | null;
    signal: string | null;
    stdout: Buffer;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
    /** The output was cut at maxStdoutBytes. */
    truncated: boolean;
    spawnError?: string;
    durationMs: number;
};

export type SshRunner = (request: SshRunRequest) => Promise<SshRunResult>;

/** What ssh may see of this process's environment: where the user's files and agent are, and nothing of Tomverse. */
const SSH_ENV = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USER", "USERNAME", "LOGNAME", "LANG", "LC_ALL",
    "SSH_AUTH_SOCK", "SSH_AGENT_PID",
] as const;

export const sshEnvironment = (env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}) => {
    const out: Record<string, string> = {};
    for (const name of SSH_ENV) {
        const value = env[name];
        if (typeof value === "string") out[name] = value;
    }
    for (const [name, value] of Object.entries(extra)) if ((SSH_ENV as readonly string[]).includes(name) && typeof value === "string") out[name] = value;
    return out;
};

export type SshRunnerOptions = {
    /** The program to run. Default: ssh. A test points it at a stand-in. */
    file?: string;
    /** Arguments placed before the ssh arguments (a test runs `node fake-ssh.mjs`). */
    prefixArgs?: readonly string[];
    env?: Record<string, string>;
    connectTimeoutSeconds?: number;
    platform?: NodeJS.Platform;
};

export const createSshRunner = (options: SshRunnerOptions = {}): SshRunner => (request) => new Promise<SshRunResult>((resolve) => {
    const started = Date.now();
    const args = [...(options.prefixArgs ?? []), ...sshArguments(request.target, request.command, {
        connectTimeoutSeconds: options.connectTimeoutSeconds, platform: options.platform,
    })];
    const chunks: Buffer[] = [];
    let held = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let killing: Promise<unknown> | null = null;
    const finish = (exitCode: number | null, signal: string | null) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, signal, stdout: Buffer.concat(chunks), stderr: stderr.slice(0, 64 * 1024), timedOut, aborted, truncated, ...(spawnError ? { spawnError } : {}), durationMs: Date.now() - started });
    };
    let child: ReturnType<typeof spawn>;
    try {
        child = spawn(options.file ?? "ssh", args, {
            stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
            // The CLI's minimal environment, plus what ssh needs to find the person's agent and files, and what the host passed on for it.
            env: commandEnv(["SSH_AUTH_SOCK", "SSH_AGENT_PID", "USERNAME", "APPDATA", "LOCALAPPDATA"], process.env, sshEnvironment({}, options.env)),
        });
    } catch (error) {
        spawnError = (error as Error).message;
        finish(null, null);
        return;
    }
    const stop = () => {
        killing ??= killTree(child).catch(() => undefined);
    };
    timer = request.timeoutMs > 0 ? setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs) : undefined;
    const onAbort = () => { aborted = true; stop(); };
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin?.on("error", () => undefined);
    if (request.stdin) child.stdin?.end(request.stdin);
    else if (!request.holdStdin) child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => {
        if (request.onStdout) { request.onStdout(chunk); return; }
        if (truncated) return;
        const room = (request.maxStdoutBytes ?? Number.POSITIVE_INFINITY) - held;
        if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            held += Math.max(0, room);
            truncated = true;
            stop();
            return;
        }
        chunks.push(chunk);
        held += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        if (request.onStderr) request.onStderr(chunk);
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
        spawnError = error.message;
        // A program that never started has no exit to wait for.
        if (!child.pid) finish(null, null);
    });
    child.on("close", (code, signal) => {
        void (killing ?? Promise.resolve()).then(() => finish(code, signal));
    });
});
