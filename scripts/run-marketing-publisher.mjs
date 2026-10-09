// The marketing publisher's Railway service: a clock and a supervisor.
//
// Contract: the S2 plan's "S2d1 -- Railway service and deadline that reaches
// the work". Railway starts this every five minutes (`Marketing Publisher` in
// .railway/agent-runners.ts). It generates a run id, fixes an absolute
// deadline four minutes out, starts the worker as a child process, and kills
// that child at the deadline if it has not finished.
//
// Why a child process and not a timer around a fetch. A timer in the same
// process is advice: an event loop blocked by a stuck await, or a request that
// ignores its abort signal, runs straight past it. A SIGKILL from the parent
// is not advice. And Railway's own rule -- it skips a run while the previous
// one is still going -- decides whether a run starts, not when one stops, so it
// is not a deadline either.
//
// This process holds two variables and nothing else: MARKETING_PUBLISH_SECRET
// and MARKETING_PUBLISH_URL. No database credential, no platform credential.
// The work happens in the app route; this is what makes sure the app is asked
// on time and that the asking stops on time.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Four minutes. Must equal MARKETING_PUBLISHER_RUN_DEADLINE_MS in
 * lib/marketingPublisherRunCore.ts, which this plain-node script cannot import;
 * tests/marketingPublisherService.test.ts fails if the two differ.
 */
export const RUN_DEADLINE_MS = 4 * 60 * 1000;

export const DEFAULT_WORKER = fileURLToPath(
  new URL("./marketing-publisher-worker.mjs", import.meta.url),
);

/**
 * The worker's environment: its two variables and what Node itself needs.
 *
 * Not the whole of this process's environment. Railway injects its own
 * variables into every service, and a worker that inherited all of them would
 * hold whatever the platform chose to add; the plan's list is two names, and
 * that is what the worker gets. `PATH` and, on Windows, `SystemRoot` are
 * there because a Node process without them cannot resolve its own tools or
 * open a network socket -- not because the worker reads them.
 */
const WORKER_VARIABLES = [
  "MARKETING_PUBLISH_SECRET",
  "MARKETING_PUBLISH_URL",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
];

const workerEnvironment = (env) =>
  Object.fromEntries(
    WORKER_VARIABLES.filter((name) => typeof env[name] === "string").map((name) => [
      name,
      env[name],
    ]),
  );

/**
 * Start one run's worker and kill it at the deadline.
 *
 * Resolves with how the worker ended: an exit code, or the signal that ended
 * it. Takes the worker and the deadline as arguments so a test can hand it a
 * worker that never finishes and a deadline measured in milliseconds, and see
 * the kill happen -- which is the whole point of this file, and the one thing a
 * test that only read its source could not show.
 */
export const superviseMarketingPublisherRun = ({
  worker = DEFAULT_WORKER,
  deadlineMs = RUN_DEADLINE_MS,
  env = process.env,
  stdio = "inherit",
} = {}) =>
  new Promise((resolve) => {
    const runId = randomUUID();
    const deadline = new Date(Date.now() + deadlineMs);

    const child = spawn(process.execPath, [worker], {
      env: {
        ...workerEnvironment(env),
        MARKETING_PUBLISHER_RUN_ID: runId,
        MARKETING_PUBLISHER_DEADLINE: deadline.toISOString(),
      },
      stdio,
    });

    let killedAtDeadline = false;
    const killer = setTimeout(() => {
      // The deadline, not a suggestion. Whatever the worker was waiting on, it
      // stops here; the route's run row closes late -- failed, never
      // succeeded -- by the database's rule, not this process's say-so.
      killedAtDeadline = true;
      console.error(`Marketing publisher run ${runId} reached its deadline; killing the worker.`);
      child.kill("SIGKILL");
    }, Math.max(0, deadline.getTime() - Date.now()));

    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ runId, code, signal, killedAtDeadline });
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      console.error(`Marketing publisher run ${runId} could not start its worker:`, error);
      resolve({ runId, code: 1, signal: null, killedAtDeadline: false });
    });
  });

// Run when executed, not when imported by the test. A `.then()` rather than a
// top-level `await`: the TypeScript test that imports this file is compiled as
// CommonJS, which has no top-level await.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  superviseMarketingPublisherRun().then((outcome) => {
    if (outcome.signal) {
      console.error(`Marketing publisher run ${outcome.runId} ended by ${outcome.signal}.`);
      process.exitCode = 1;
    } else {
      process.exitCode = outcome.code ?? 1;
    }
  });
}
