// The Support Triage cron services' supervisor (docs/policy/support-triage.md §3, §5).
// Railway runs one of the two entry files that call it,
// scripts/support-triage-worker-service.mjs and
// scripts/support-triage-retention-service.mjs, with
// `node --experimental-strip-types <entry>` (never through npm, which adds
// variables the start check refuses).
//
// It checks the environment, starts the child with the same environment, and
// kills the child with SIGKILL if it has not finished at the service's
// supervisor deadline, so a child stuck in a synchronous loop, ignoring
// SIGTERM or held open by a handle still ends. The child's exit code becomes
// the service's; a killed child is exit 1. Nothing here retries.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SUPPORT_TRIAGE_SERVICES,
  supportTriageServiceStartRefusal,
} from "../lib/supportTriageServiceCore.ts";

export const CHILD_SCRIPT = fileURLToPath(new URL("./support-triage-child.mjs", import.meta.url));

/** Resolves to the exit code. `spawnChild(env)` returns a ChildProcess; tests pass their own. */
export function superviseSupportTriageService({
  kind,
  env,
  spawnChild,
  deadlineMs = SUPPORT_TRIAGE_SERVICES[kind].supervisorDeadlineMs,
  log = console.log,
}) {
  const refusal = supportTriageServiceStartRefusal(kind, env);
  if (refusal) {
    log(JSON.stringify({ event: "support_triage_service", service: kind, ...refusal }));
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawnChild(env);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.on("error", () => {
      clearTimeout(timer);
      log(JSON.stringify({ event: "support_triage_service", service: kind, exitCode: 1, outcome: "child_spawn_failed" }));
      resolve(1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) {
        log(JSON.stringify({ event: "support_triage_service", service: kind, exitCode: 1, outcome: "deadline_killed" }));
        resolve(1);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

/** Runs one service end to end; the two entry files call this with their kind. */
export async function runSupportTriageServiceEntry(kind) {
  const code = await superviseSupportTriageService({
    kind,
    env: { ...process.env },
    spawnChild: (childEnv) =>
      spawn(process.execPath, ["--experimental-strip-types", CHILD_SCRIPT, kind], { env: childEnv, stdio: "inherit" }),
  });
  process.exit(code);
}
