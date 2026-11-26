// Small process runner: timeout with process-tree kill, bounded output, stdin.
import { spawn, spawnSync } from "node:child_process";

const keepTail = (current, chunk, max) => {
    const next = current + chunk;
    return next.length > max ? next.slice(next.length - max) : next;
};

export const killTree = (child) => {
    if (!child || child.pid === undefined || child.exitCode !== null) return;
    try {
        if (process.platform === "win32") {
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
        }
    } catch {
        // best effort: the process may already be gone
    }
};

/**
 * Runs one process to completion. Never throws: a failure to start is reported
 * as `spawnError`. `shell: true` is only for Windows .cmd shims; their
 * arguments are quoted for cmd.exe (the prompt travels on stdin, never in argv).
 */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_.,:=@/\\-]+$/;
export const quoteForCmd = (value) => (PLAIN_ARGUMENT.test(value) ? value : `"${value.replaceAll('"', '""')}"`);

export const runProcess = ({ file, args = [], cwd, env, input, timeoutMs, shell = false, maxChars = 2_000_000 }) =>
    new Promise((resolve) => {
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let done = false;
        let timer = null;
        let child;
        const finish = (result) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr, timedOut, durationMs: Date.now() - startedAt, ...result });
        };
        try {
            const viaCmd = shell && process.platform === "win32";
            child = spawn(viaCmd ? quoteForCmd(file) : file, viaCmd ? args.map(quoteForCmd) : args, {
                cwd,
                env,
                shell,
                windowsHide: true,
                detached: process.platform !== "win32",
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            finish({ code: null, signal: null, spawnError: error.message });
            return;
        }
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout = keepTail(stdout, chunk, maxChars)));
        child.stderr.on("data", (chunk) => (stderr = keepTail(stderr, chunk, maxChars)));
        child.stdin.on("error", () => {});
        child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
        child.on("close", (code, signal) => finish({ code, signal }));
        if (timeoutMs) {
            timer = setTimeout(() => {
                timedOut = true;
                killTree(child);
            }, timeoutMs);
        }
        child.stdin.end(input ?? "");
    });

/** The environment a route's process gets: the parent's, minus the given names. */
export const envWithout = (names, base = process.env) => {
    const wanted = new Set(names.map((n) => (process.platform === "win32" ? n.toLowerCase() : n)));
    const out = {};
    for (const [key, value] of Object.entries(base)) {
        if (!wanted.has(process.platform === "win32" ? key.toLowerCase() : key)) out[key] = value;
    }
    return out;
};
