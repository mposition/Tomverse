import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { inProjectFolder } from "./project-root";

export type ProcessResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

/**
 * Finds an installed program on the PATH the person already has. Only absolute PATH entries count and a program inside the selected
 * project folder is skipped, so a planted executable in the repository is never run (Windows would otherwise search the working folder).
 */
export function resolveProgram(name: string, env: NodeJS.ProcessEnv, avoidFolder?: string): string | null {
  const executable = process.platform === "win32" ? name + ".exe" : name;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== "path") continue;
    for (const entry of (env[key] ?? "").split(delimiter)) {
      const folder = entry.replace(/^"(.*)"$/, "$1");
      if (!isAbsolute(folder)) continue;
      try {
        const path = realpathSync(join(folder, executable));
        if ((!avoidFolder || !inProjectFolder(avoidFolder, path)) && lstatSync(path).isFile()) return path;
      } catch { /* Try the next configured PATH entry. */ }
    }
  }
  return null;
}

/**
 * Runs one program without a shell and collects what it prints. Never throws for a program that ran: a non-zero exit is a result.
 * `code` is null when the program could not start or was ended by the time limit.
 */
export function runProgram(file: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string; maxBytes?: number; signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const limit = options.maxBytes ?? 4 * 1024 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, truncated });
    };
    const stop = () => { try { child.kill(); } catch { /* Already gone. */ } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch {
      finish(null);
      return;
    }
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes >= limit) { truncated = true; return; }
      out.push(chunk.subarray(0, limit - outBytes));
      outBytes += chunk.length;
      if (outBytes > limit) truncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes >= 64 * 1024) return;
      err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(timedOut ? null : code));
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
  });
}
