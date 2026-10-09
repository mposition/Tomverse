#!/usr/bin/env node
// The ops-observer service entry point (docs/policy/sre-ops.md §3 rules 5 and
// 7, §8 "되돌림").
//
// It is the only process that sees the whole environment. In order:
// 1. If `OPS_OBSERVER_ENABLED` is not exactly "true" it exits 0 and does
//    nothing -- the service is dark, and no heartbeat is sent.
// 2. Every environment name must pass `judgeEnvironmentNames()`; otherwise
//    it exits 1 before any child exists, naming the refused names.
// 3. The service's required variables must be present, and the app URL must
//    be the fixed production origin.
// 4. It starts the observation child with only that child's variables, and
//    kills it with SIGKILL if it has not finished by the deadline. The child's
//    exit code becomes the service's exit code; a killed child is exit 1.
//
// Nothing here retries. A failed run ends; the next cron tick starts fresh.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PRODUCTION_ORIGIN } from "./content-guard-core.mjs";
import { childEnvironment, judgeEnvironmentNames } from "./runtime-variables-core.mjs";

/** The supervisor deadline, which is also the run deadline (policy §6). */
export const SUPERVISOR_DEADLINE_MS = 180_000;

/** Required at start, per service. The page webhook is S2-only and optional. */
export const REQUIRED_VARIABLES = Object.freeze({
  page: Object.freeze(["OPS_OBSERVER_SECRET", "OPS_OBSERVER_HEARTBEAT_URL", "OPS_OBSERVER_APP_URL"]),
  digest: Object.freeze([
    "OPS_OBSERVER_DIGEST_SECRET",
    "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
    "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
    "OPS_OBSERVER_APP_URL",
  ]),
});

export const CHILD_SCRIPTS = Object.freeze({
  page: fileURLToPath(new URL("./run-page.mjs", import.meta.url)),
  digest: fileURLToPath(new URL("./run-digest.mjs", import.meta.url)),
});

/**
 * Decide what the supervisor does with this environment, without doing it.
 * Returns `{ action: "dark" }`, `{ action: "config_error", reason, names }`
 * or `{ action: "start", childEnv }`.
 */
export function planStart(service, env) {
  if (env.OPS_OBSERVER_ENABLED !== "true") return { action: "dark" };

  const verdict = judgeEnvironmentNames(service, Object.keys(env));
  if (!verdict.ok) {
    const names = [...new Set([...verdict.notAllowed, ...verdict.credentialShaped])].sort();
    return { action: "config_error", reason: "env_not_allowed", names };
  }
  const missing = REQUIRED_VARIABLES[service].filter((name) => !env[name]);
  if (missing.length > 0) return { action: "config_error", reason: "env_missing", names: missing };
  if (env.OPS_OBSERVER_APP_URL !== PRODUCTION_ORIGIN) {
    return { action: "config_error", reason: "app_url_not_production", names: ["OPS_OBSERVER_APP_URL"] };
  }
  return { action: "start", childEnv: childEnvironment(service, env) };
}

/**
 * Run one supervised execution. Resolves to the exit code the service should
 * use. `spawnChild(childEnv)` returns a ChildProcess; tests inject their own.
 */
export function supervise({ service, env, spawnChild, deadlineMs = SUPERVISOR_DEADLINE_MS, log = console.log }) {
  const plan = planStart(service, env);
  if (plan.action === "dark") {
    log(`ops_observer_supervisor=dark service=${service}`);
    return Promise.resolve(0);
  }
  if (plan.action === "config_error") {
    log(`ops_observer_supervisor=config_error service=${service} reason=${plan.reason} names=${JSON.stringify(plan.names)}`);
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const child = spawnChild(plan.childEnv);
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.on("error", () => {
      clearTimeout(timer);
      log(`ops_observer_supervisor=child_spawn_failed service=${service}`);
      resolve(1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) {
        log(`ops_observer_supervisor=deadline_killed service=${service}`);
        resolve(1);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

async function main() {
  const service = process.argv[2];
  if (service !== "page" && service !== "digest") {
    console.log("ops_observer_supervisor=config_error reason=service_argument");
    process.exit(1);
  }
  const code = await supervise({
    service,
    env: { ...process.env },
    spawnChild: (childEnv) =>
      spawn(process.execPath, [CHILD_SCRIPTS[service]], { env: childEnv, stdio: "inherit" }),
  });
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
