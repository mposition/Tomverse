// The marketing generator's Railway service: a clock and a supervisor
// (S3 plan, S3e3; the publisher's shape, scripts/run-marketing-publisher.mjs).
//
// It generates a run id, fixes an absolute deadline, starts the worker as a
// child process and kills that child at the deadline if it has not finished.
// The kill is the hard timeout the plan names for this service: a timer in
// the same process is advice, a SIGKILL from the parent is not
// (agent foundation section 6.2a).
//
// The worker gets its four variables and what Node itself needs -- not the
// rest of this process's environment, which Railway fills with its own.
//
// Not yet wired into .railway/agent-runners.ts: the service needs the
// operator's dedicated OpenAI project, key and price pin first (D4).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Forty minutes: A3's twenty-minute share (about thirteen tracked competitors
 * at its ninety-second budget), then nine A5 accounts at the cycle's
 * ninety-second call budget, and room to spare. The ledger's reservation
 * lives fifteen minutes and its dispatch an hour, each call's own, so a run
 * this long does not outlive them.
 */
export const RUN_DEADLINE_MS = 40 * 60 * 1000;

export const DEFAULT_WORKER = fileURLToPath(new URL("./marketing-generator-worker.mjs", import.meta.url));

const WORKER_VARIABLES = [
  "MARKETING_APP_URL",
  "MARKETING_GENERATOR_SUBMIT_SECRET",
  "MARKETING_LLM_API_KEY",
  "MARKETING_GENERATOR_MODEL",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
];

const workerEnvironment = (env) =>
  Object.fromEntries(
    WORKER_VARIABLES.filter((name) => typeof env[name] === "string").map((name) => [name, env[name]]),
  );

/**
 * Start one run's worker and kill it at the deadline. Resolves with how the
 * worker ended. Takes the worker and the deadline so a test can hand it a
 * worker that never finishes and watch the kill happen.
 */
export const superviseMarketingGeneratorRun = ({
  worker = DEFAULT_WORKER,
  deadlineMs = RUN_DEADLINE_MS,
  env = process.env,
  stdio = "inherit",
} = {}) =>
  new Promise((resolve) => {
    const runId = randomUUID();
    const deadline = new Date(Date.now() + deadlineMs);

    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", worker], {
      env: {
        ...workerEnvironment(env),
        MARKETING_GENERATOR_RUN_ID: runId,
        MARKETING_GENERATOR_DEADLINE: deadline.toISOString(),
      },
      stdio,
    });

    let killedAtDeadline = false;
    const killer = setTimeout(() => {
      killedAtDeadline = true;
      console.error(`Marketing generator run ${runId} reached its deadline; killing the worker.`);
      child.kill("SIGKILL");
    }, Math.max(0, deadline.getTime() - Date.now()));

    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ runId, code, signal, killedAtDeadline });
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      console.error(`Marketing generator run ${runId} could not start its worker:`, error);
      resolve({ runId, code: 1, signal: null, killedAtDeadline: false });
    });
  });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  superviseMarketingGeneratorRun().then((outcome) => {
    if (outcome.signal) {
      console.error(`Marketing generator run ${outcome.runId} ended by ${outcome.signal}.`);
      process.exitCode = 1;
    } else {
      process.exitCode = outcome.code ?? 1;
    }
  });
}
