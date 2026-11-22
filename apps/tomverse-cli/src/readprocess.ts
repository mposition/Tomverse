import { commandEnv } from "./env.js";
import { spawn } from "node:child_process";

/** Bounded, cancellable subprocess for file discovery, search and process-tree control. */
export const readProcess = (
    file: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        signal: AbortSignal;
        timeoutMs: number;
        maxBytes?: number;
    },
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> =>
    new Promise((resolve, reject) => {
        options.signal.throwIfAborted();
        const child = spawn(file, args, {
            cwd: options.cwd,
            env: commandEnv(["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_PAGER"], options.env),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let bytes = 0;
        let failure: Error | undefined;
        let missing = false;
        let forceKill: ReturnType<typeof setTimeout> | undefined;
        const stop = (error: Error) => {
            failure ??= error;
            child.kill();
            forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
        };
        const abort = () => stop(new Error("Search cancelled."));
        const timer = setTimeout(() => stop(new Error("Search time limit reached.")), options.timeoutMs);
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
        const collect = (chunks: Buffer[], chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) stop(new Error("Search output limit reached; narrow the path or pattern."));
            else chunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
        child.on("error", (error: NodeJS.ErrnoException) => {
            missing = error.code === "ENOENT";
            if (!missing) failure = error;
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (forceKill) clearTimeout(forceKill);
            options.signal.removeEventListener("abort", abort);
            if (failure) reject(failure);
            else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), missing });
        });
    });
