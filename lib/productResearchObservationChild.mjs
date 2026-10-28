// Running a child process so that a deadline can actually end it.
//
// Separated from the runner script because how a child is ended is a decision,
// and a decision in the script is one the tests cannot reach. Two independent
// reviewers found the original defect by reading, which is what a module
// nothing can exercise costs.
//
// What it replaces: `spawnSync`. That blocks the event loop, so the run's own
// fifteen-minute deadline -- the one that exists precisely for a child that
// hangs -- cannot fire while a child is running. And `spawnSync`'s `timeout`
// sends `SIGTERM` and then *waits*, so a child that ignores `SIGTERM` is waited
// for forever. Railway skips the next scheduled run while one is still going,
// so a single hung run stops every run after it.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * How long a child gets to leave after being asked, before it is made to.
 *
 * `SIGTERM` is a request. git handles it and tidies up, which is worth the
 * wait; a child that ignores it is the case the deadline exists for, and after
 * this it gets `SIGKILL`, which nothing handles.
 */
export const CHILD_KILL_GRACE_MS = 5_000;

/** The most a child may print before it is stopped rather than buffered. */
export const CHILD_OUTPUT_MAX_BYTES = 1_000_000;

/**
 * Ends a child and everything it started.
 *
 * The negated pid addresses the process *group*, which is why children are
 * spawned detached: `git clone` starts `git-remote-https`, and killing only git
 * leaves that holding the connection. Windows has no process groups of this
 * kind, and its `kill` is forceful whatever signal is named, so there it is the
 * handle that is killed.
 *
 * **It does not refuse because the child itself has exited.** That guard was
 * here and was wrong: `SIGTERM` can take the parent while a grandchild ignores
 * it, and the child's `signalCode` is then set -- so the follow-up `SIGKILL`
 * and both watchdogs' kills were all refused by the very guard meant to make
 * them safe, leaving the group alive, the pipes open, `close` unfired and the
 * run alive past every deadline it has. The group can outlive the child, which
 * is the whole reason the kill is addressed to the group.
 *
 * What the removal costs, named rather than left implicit: between a group
 * dying and `close` firing, the operating system may reuse the group id, and
 * a kill sent in that window would reach whatever reused it. The window is
 * the few milliseconds between those two events, pids are handed out
 * sequentially and the space is large, and the alternative was a run that
 * survives every deadline it has and blocks every later slot. The trade is
 * deliberate.
 *
 * The pid check is not that guard. A pid of 0 or 1 negated names the caller's
 * own group or every process it may signal, so a child that never started is
 * refused rather than turned into a signal to everything.
 *
 * It never throws. A watchdog is the last thing that should be taken down by
 * the cleanup it attempted.
 */
export const endChild = (child, signal, { platform = process.platform } = {}) => {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    // `child.kill` answers whether it signalled anything; `process.kill`
    // throws instead. Returning its answer rather than `true` keeps the
    // contract honest on Windows, where killing an already-exited child
    // returns false without throwing.
    if (platform === "win32") return child.kill(signal);
    process.kill(-pid, signal);
    return true;
  } catch {
    // Already gone. There is nothing to end, and that is the ordinary case.
    return false;
  }
};

/**
 * One child process, run without blocking the event loop.
 *
 * Answers rather than throws, and always settles: a caller with a deadline of
 * its own must not be left waiting on a promise that never resolves.
 *
 * `timedOut` and `overflowed` are facts this function knows and the caller
 * cannot infer -- a kill looks the same from outside whatever caused it -- so
 * they are reported rather than left to be read off a signal.
 */
export const runChild = (
  command,
  argv,
  {
    cwd,
    timeoutMs,
    maxBytes = CHILD_OUTPUT_MAX_BYTES,
    env,
    platform = process.platform,
    /**
     * Called with the child as it starts, so a caller with a deadline of its
     * own can end what it is waiting on. A promise cannot hand back the handle
     * and the result both, and a watchdog needs the handle *while* the work is
     * still running.
     */
    onStart,
  } = {},
) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        // Its own process group, so the kill reaches the grandchildren.
        detached: platform !== "win32",
      });
    } catch (error) {
      // The same shape as every other answer. A result whose fields depend on
      // how it failed is one every reader has to special-case.
      resolve({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        overflowed: false,
        error,
      });
      return;
    }
    if (typeof onStart === "function") onStart(child);

    // Decoded per stream rather than per chunk. A multi-byte character split
    // across two chunks -- a Korean issue title in the report's JSON, say --
    // becomes two replacement characters if each chunk is decoded alone, and
    // the JSON still parses, so a corrupted observation would be stored as a
    // success. `spawnSync`'s `encoding: "utf8"` did not have that failure.
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflowed = false;
    let closed = false;

    // Gated on `close` rather than on the child's exit state, for the reason
    // `endChild` gives: the group can outlive the child.
    const kill = (signal) => {
      if (closed) return false;
      return endChild(child, signal, { platform });
    };

    const read = (which) => (chunk) => {
      // Measured on the bytes, which is what the cap is about; the decoded
      // string is shorter for anything outside ASCII.
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!overflowed) {
          overflowed = true;
          // Stopped rather than buffered: a child printing without end would
          // otherwise be held in the memory of a container that has none spare.
          kill("SIGKILL");
        }
        return;
      }
      const text = decoders[which].write(chunk);
      if (which === "out") stdout += text;
      else stderr += text;
    };
    child.stdout.on("data", read("out"));
    child.stderr.on("data", read("err"));

    let timedOut = false;
    let killTimer;
    const deadline =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            kill("SIGTERM");
            // And then it is not asked again.
            killTimer = setTimeout(() => kill("SIGKILL"), CHILD_KILL_GRACE_MS);
          }, timeoutMs);

    let settled = false;
    const settle = (status, signal, error) => {
      if (settled) return;
      settled = true;
      closed = true;
      if (deadline !== null) clearTimeout(deadline);
      clearTimeout(killTimer);
      // Whatever the decoders are still holding is an incomplete character at
      // the end of the stream, which is a truncated child rather than text.
      decoders.out.end();
      decoders.err.end();
      resolve({ status, signal, stdout, stderr, timedOut, overflowed, error });
    };
    child.on("error", (error) => settle(null, null, error));
    child.on("close", (status, signal) => settle(status, signal));
  });
