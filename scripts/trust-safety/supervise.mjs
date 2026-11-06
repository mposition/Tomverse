#!/usr/bin/env node
// The trust-safety observer service's entry point
// (docs/policy/trust-safety-compliance-agent.md §4).
//
// It is the only process that sees the whole environment. In order:
//
//   1. every name in the environment must pass `judgeEnvironmentNames()`;
//      otherwise it exits non-zero before a child exists, naming the refused
//      names and never their values;
//   2. both of §4's variables must be present;
//   3. it starts the child with only the child's variables and SIGKILLs it at
//      the deadline. The child's exit code becomes the service's; a killed
//      child is a failure.
//
// **There is no enable switch, and that is §4.** The service holds two
// variables and no more, so the switch is the activation row in the database
// (§6): a service that is deployed but not activated calls the route every
// period and the route answers `failed` without writing anything. Stopping the
// observation is the owner turning the switch off in the Admin section, and
// stopping the service is removing it from the IaC file.
//
// Nothing here retries. A failed run ends; the next cron tick starts fresh,
// and the deploy is configured never to restart this service.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { childEnvironment, judgeEnvironmentNames, SERVICE_VARIABLES } from "./runtime-variables-core.mjs";
import { SUPERVISOR_DEADLINE_MS } from "./timing-core.mjs";

export const CHILD_SCRIPT = fileURLToPath(new URL("./observe.mjs", import.meta.url));

/** Exit codes this process uses for its own refusals. */
export const EXIT = Object.freeze({
  configError: 2,
  childKilled: 1,
});

/**
 * Decide what the supervisor does with this environment, without doing it.
 *
 * Returns `{ action: "config_error", reason, names }` or
 * `{ action: "start", childEnv }`.
 */
export function planStart(env) {
  const verdict = judgeEnvironmentNames(Object.keys(env));
  if (!verdict.ok) {
    const names = [...new Set([...verdict.notAllowed, ...verdict.credentialShaped])].sort();
    return { action: "config_error", reason: "env_not_allowed", names };
  }
  const missing = SERVICE_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0) {
    return { action: "config_error", reason: "env_missing", names: missing };
  }
  return { action: "start", childEnv: childEnvironment(env) };
}

/**
 * Run one supervised execution, resolving to the exit code the service should
 * use. `spawnChild(childEnv)` returns a ChildProcess; tests inject their own.
 */
export function supervise({
  env,
  spawnChild,
  deadlineMs = SUPERVISOR_DEADLINE_MS,
  log = console.log,
}) {
  const plan = planStart(env);
  if (plan.action === "config_error") {
    log(
      JSON.stringify({
        event: "trust_safety_supervisor_config_error",
        reason: plan.reason,
        names: plan.names,
      }),
    );
    return Promise.resolve(EXIT.configError);
  }

  const child = spawnChild(plan.childEnv);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: §4 puts the hard limit here, and a child that
      // is wedged inside a request would not act on a signal it can ignore.
      // The round it started is not cancelled by this -- the app cannot take
      // back a COMMIT -- so the row, if the route wrote one, stands on the
      // database's own deadline judgement (§5.4).
      log(JSON.stringify({ event: "trust_safety_supervisor_killed_child", deadlineMs }));
      child.kill("SIGKILL");
      finish(EXIT.childKilled);
    }, deadlineMs);
    child.on("error", (error) => {
      log(
        JSON.stringify({
          event: "trust_safety_supervisor_child_error",
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      );
      finish(EXIT.configError);
    });
    child.on("exit", (code, signal) => {
      log(
        JSON.stringify({
          event: "trust_safety_supervisor_child_exit",
          code: code ?? null,
          signal: signal ?? null,
        }),
      );
      finish(code === null ? EXIT.childKilled : code);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await supervise({
    env: process.env,
    spawnChild: (childEnv) =>
      spawn(process.execPath, [CHILD_SCRIPT], { env: childEnv, stdio: "inherit" }),
  });
}
