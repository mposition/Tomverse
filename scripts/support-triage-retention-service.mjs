// The Support Triage Retention service's entry point (docs/policy/support-triage.md §3, §5).
// Railway runs it with
// `node --experimental-strip-types scripts/support-triage-retention-service.mjs`
// (never through npm, which adds variables the start check refuses).
//
// It checks the environment, starts the child with the same environment, and
// kills the child with SIGKILL if it has not finished at five minutes, so a
// child stuck in a synchronous loop, ignoring SIGTERM or held open by a handle
// still ends. The child's exit code becomes the service's; a killed child is
// exit 1. Nothing here retries.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS,
  supportTriageRetentionStartRefusal,
} from "../lib/supportTriageRetentionServiceCore.ts";

export const CHILD_SCRIPT = fileURLToPath(new URL("./support-triage-retention-child.mjs", import.meta.url));

/** Resolves to the exit code. `spawnChild(env)` returns a ChildProcess; tests pass their own. */
export function superviseSupportTriageRetention({
  env,
  spawnChild,
  deadlineMs = SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS,
  log = console.log,
}) {
  const refusal = supportTriageRetentionStartRefusal(env);
  if (refusal) {
    log(JSON.stringify({ event: "support_triage_retention_service", ...refusal }));
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
      log(JSON.stringify({ event: "support_triage_retention_service", exitCode: 1, outcome: "child_spawn_failed" }));
      resolve(1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) {
        log(JSON.stringify({ event: "support_triage_retention_service", exitCode: 1, outcome: "deadline_killed" }));
        resolve(1);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await superviseSupportTriageRetention({
    env: { ...process.env },
    spawnChild: (childEnv) =>
      spawn(process.execPath, ["--experimental-strip-types", CHILD_SCRIPT], { env: childEnv, stdio: "inherit" }),
  });
  process.exit(code);
}
