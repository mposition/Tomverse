// The hard deadline of an engineering agent service cycle
// (docs/policy/engineering-agent.md §13-20: "watchdog 부모가 작업 프로세스
// 그룹을 강제 종료한다"). The entry point runs twice: once as this supervisor,
// which starts the same entry again as a worker in a process group of its
// own, and once as that worker, which runs the cycle. At the deadline the
// supervisor kills the whole group -- the worker and every git it started --
// with SIGKILL, sends the failure signal, and exits without a success signal.
// A timer inside the worker could not do this: a blocked event loop never
// fires it, and process.exit leaves the children running.
//
// Imports: node builtins only.

import { spawn } from "node:child_process";

/** Set on the worker's environment; its absence makes a process the supervisor. */
export const SUPERVISED_ENV = "ENGINEERING_AGENT_SUPERVISED";

export const isSupervisedWorker = (env = process.env) => env[SUPERVISED_ENV] === "1";

/** Kills a process group; a group already gone is not an error. */
const killGroup = (kill, pid) => {
  try {
    kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: nothing left in the group.
  }
};

/**
 * Runs the current entry point as a supervised worker and resolves with the
 * exit code. `ports` are injected for tests; in production they are Node's.
 */
export function superviseCycle({
  deadlineMs,
  failUrl,
  event,
  spawnImpl = spawn,
  kill = process.kill.bind(process),
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv,
  env = process.env,
}) {
  const child = spawnImpl(execPath, [...execArgv, ...argv.slice(1)], {
    detached: true,
    stdio: "inherit",
    env: { ...env, [SUPERVISED_ENV]: "1" },
  });
  return new Promise((resolve) => {
    let deadlinePassed = false;
    const timer = setTimer(async () => {
      deadlinePassed = true;
      killGroup(kill, child.pid);
      console.error(JSON.stringify({ event, reason: "hard_deadline" }));
      // No success signal after a killed cycle; the failure one if it can go.
      if (failUrl) {
        await fetchImpl(failUrl, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(
          () => undefined,
        );
      }
      resolve(70);
    }, deadlineMs);
    const finish = (code) => {
      if (deadlinePassed) return;
      clearTimer(timer);
      // Anything the worker left in its group ends with it.
      killGroup(kill, child.pid);
      resolve(code);
    };
    child.on("exit", (code) => finish(typeof code === "number" ? code : 1));
    child.on("error", () => finish(1));
  });
}
