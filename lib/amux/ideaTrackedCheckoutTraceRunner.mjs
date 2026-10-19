import { execFile, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { chmod, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { AMUX_V19_OPEN_TRACE_SYSCALLS,
  createAmuxTrackedCheckoutOpenTraceObserver } from
  "./ideaTrackedCheckoutOpenTrace.mjs";
import { amuxV19SeccompFilterBytes } from "./ideaTrackedCheckoutSeccomp.mjs";

const run = promisify(execFile);
const TRACE_DRAIN_MS = 8_000;

/** Trace every read-capable checkout open through a private FIFO. No syscall
 * text is written to a regular file or retained after the observer sees it.
 * A missing strace, incomplete FIFO, or nonzero child leaves the manifest
 * unverified. This post-exit drain deadline is not a CLI execution timeout.
 * bwrap installs the v19 seccomp filter (ideaTrackedCheckoutSeccomp.mjs) from
 * fd 3, so io_uring and handle opens are refused and every read goes through
 * the open family the observer decodes; the caller may not supply its own. */
export async function launchAmuxV19TracedSandbox({ args, directory, files,
  diagnostic = false }) {
  if (process.platform !== "linux" || !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      args.slice(0, Math.max(0, args.indexOf("--"))).includes("--seccomp") ||
      !args.includes("--"))
    throw new TypeError("invalid tracked checkout trace launch");
  const observer = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic });
  const traceDirectory = await mkdtemp("/tmp/amux-v19-trace-");
  const fifo = join(traceDirectory, "opens.pipe");
  let trace;
  try {
    await chmod(traceDirectory, 0o700);
    await run("/usr/bin/mkfifo", ["-m", "600", fifo], {
      env: { PATH: "/usr/bin:/bin" }, timeout: 10_000,
    });
    trace = createReadStream(fifo);
    let traceComplete = false;
    let traceFailed = false;
    const traceDone = new Promise((resolve) => {
      trace.on("data", (chunk) => observer.observeChunk(chunk));
      trace.once("end", () => { traceComplete = true; resolve(); });
      trace.once("error", () => { traceFailed = true; resolve(); });
      trace.once("close", resolve);
    });
    const child = spawn("/usr/bin/strace", [
      "-f", "-qq", "-e", `trace=${AMUX_V19_OPEN_TRACE_SYSCALLS}`,
      "-yy", "-s", "4096", "-o", fifo, "/usr/bin/bwrap", "--seccomp", "3", ...args,
    ], {
      cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"], shell: false,
    });
    // bwrap reads the whole program from fd 3 before it starts the sandbox; a
    // short or missing filter makes bwrap fail, which leaves the trace unverified.
    child.stdio[3].on("error", () => {});
    child.stdio[3].end(amuxV19SeccompFilterBytes());
    let finished = false;
    return Object.freeze({
      child,
      async finishTrace(exit) {
        if (finished) return { kind: "unverified" };
        finished = true;
        let timer;
        await Promise.race([traceDone, new Promise((resolve) => {
          timer = setTimeout(resolve, TRACE_DRAIN_MS);
        })]);
        clearTimeout(timer);
        if (!traceComplete) trace.destroy();
        return observer.finish({ traceComplete: traceComplete && !traceFailed &&
          exit?.code === 0 && exit?.signal == null && !exit?.stopped });
      },
      async cleanup() {
        if (!traceComplete) {
          trace.destroy();
          // Opening both ends unblocks a reader waiting in open(2) if strace
          // failed before opening the FIFO for writing.
          try {
            const unblock = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
            await unblock.close();
          } catch { /* The FIFO may already be gone. */ }
        }
        await traceDone;
        await unlink(fifo);
        await rmdir(traceDirectory);
      },
    });
  } catch (error) {
    trace?.destroy();
    try { await unlink(fifo); } catch { /* No FIFO was created. */ }
    try { await rmdir(traceDirectory); } catch { /* Preserve first error. */ }
    throw error;
  }
}
