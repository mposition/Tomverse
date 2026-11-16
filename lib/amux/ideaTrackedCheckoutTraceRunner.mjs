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
// A drain slower than this is only noted (`drainSlow`, diagnostic runs); the
// trace is waited for, never given up on.
const TRACE_DRAIN_NOTE_MS = 8_000;

/** Opening both ends unblocks a reader waiting in open(2) when no writer ever
 * opened the FIFO; the extra writer is closed again at once, so data already
 * in the pipe is still read to its end. */
async function releaseFifoReader(fifo) {
  try {
    const unblock = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    await unblock.close();
  } catch { /* The FIFO may already be gone. */ }
}

/** Trace every read-capable checkout open through a private FIFO. No syscall
 * text is written to a regular file or retained after the observer sees it.
 * A missing strace, incomplete FIFO, or nonzero child leaves the manifest
 * unverified. The post-exit drain has no deadline: the trace stream ends when
 * strace exits, and a slow drain is noted, not a reason to drop the result.
 * bwrap installs the v19 seccomp filter (ideaTrackedCheckoutSeccomp.mjs) from
 * fd 3, so io_uring and handle opens are refused and every read goes through
 * the open family the observer decodes; the caller may not supply its own. */
export async function launchAmuxV19TracedSandbox({ args, directory, files,
  diagnostic = false, detail = false }) {
  if (process.platform !== "linux" || !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      args.slice(0, Math.max(0, args.indexOf("--"))).includes("--seccomp") ||
      !args.includes("--"))
    throw new TypeError("invalid tracked checkout trace launch");
  const observer = createAmuxTrackedCheckoutOpenTraceObserver({
    directory, files, diagnostic, detail });
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
        const drainStarted = Date.now();
        // strace has exited, so no writer is left. A reader still blocked in
        // open(2) (strace never opened the FIFO) is released here instead of
        // waiting on a deadline.
        await releaseFifoReader(fifo);
        await traceDone;
        const drainSlow = Date.now() - drainStarted > TRACE_DRAIN_NOTE_MS;
        if (!traceComplete) trace.destroy();
        const settled = observer.finish({ traceComplete: traceComplete &&
          !traceFailed && exit?.code === 0 && exit?.signal == null &&
          !exit?.stopped });
        return diagnostic && drainSlow ? { ...settled, drainSlow: true }
          : settled;
      },
      async cleanup() {
        if (!traceComplete) {
          trace.destroy();
          await releaseFifoReader(fifo);
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
