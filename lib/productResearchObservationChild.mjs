// Running a child process so that a deadline can actually end it.
//
// Separated from the runner script because how a child is ended is a decision,
// and a decision in the script is one the tests cannot reach. Two independent
// reviewers found this one by reading, which is what a module nothing can
// exercise costs.
//
// What it replaces: `spawnSync`. That blocks the event loop, so the run's own
// fifteen-minute deadline -- the one that exists precisely for a child that
// hangs -- cannot fire while a child is running. And `spawnSync`'s `timeout`
// sends `SIGTERM` and then *waits*, so a child that ignores `SIGTERM` is waited
// for forever. Railway skips the next scheduled run while one is still going,
// so a single hung run stops every run after it.

import { spawn } from "node:child_process";

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
 * It never throws. A watchdog is the last thing that should be taken down by
 * the cleanup it attempted.
 */
export const endChild = (child, signal, { platform = process.platform } = {}) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch {
    // Already gone, or never started. Either way there is nothing to end.
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
      resolve({ status: null, signal: null, stdout: "", stderr: "", error });
      return;
    }
    if (typeof onStart === "function") onStart(child);

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflowed = false;
    const read = (append) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!overflowed) {
          overflowed = true;
          // Stopped rather than buffered: a child printing without end would
          // otherwise be held in the memory of a container that has none spare.
          endChild(child, "SIGKILL", { platform });
        }
        return;
      }
      append(String(chunk));
    };
    child.stdout.on("data", read((text) => { stdout += text; }));
    child.stderr.on("data", read((text) => { stderr += text; }));

    let timedOut = false;
    let killTimer;
    const deadline =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            endChild(child, "SIGTERM", { platform });
            // And then it is not asked again.
            killTimer = setTimeout(
              () => endChild(child, "SIGKILL", { platform }),
              CHILD_KILL_GRACE_MS,
            );
          }, timeoutMs);

    let settled = false;
    const settle = (status, signal, error) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      clearTimeout(killTimer);
      resolve({ status, signal, stdout, stderr, timedOut, overflowed, error });
    };
    child.on("error", (error) => settle(null, null, error));
    child.on("close", (status, signal) => settle(status, signal));

  });
