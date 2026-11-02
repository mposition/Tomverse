// The comment monitor's Railway service (marketing S4d): a clock and a
// supervisor, the generator's shape (scripts/marketing-generator-service.mjs).
//
// Every hour it starts the worker as a child process with a run id and an
// absolute deadline, and kills the child at that deadline. Off -- the switch
// not true, or the marketing kill switch set -- it starts nothing.
//
// The worker gets its variables and what Node itself needs, not the rest of
// this process's environment.

import { fileURLToPath } from "node:url";

import { marketingCommentsMonitorGate } from "../lib/marketingCommentsClassifierCore.ts";
import { superviseMarketingGeneratorRun } from "./marketing-generator-service.mjs";

export const COMMENTS_MONITOR_WORKER = fileURLToPath(new URL("./marketing-comments-monitor-worker.mjs", import.meta.url));

/** Twenty minutes, inside the hour between runs: a few classifier calls, and two reads of every post's comments. */
export const COMMENTS_MONITOR_DEADLINE_MS = 20 * 60 * 1000;

/** What the worker reads, the same three the generator's worker does, and the two switches. */
export const COMMENTS_MONITOR_WORKER_VARIABLES = [
  "MARKETING_APP_URL",
  "MARKETING_GENERATOR_SUBMIT_SECRET",
  "MARKETING_LLM_API_KEY",
  "MARKETING_COMMENTS_MONITOR_ENABLED",
  "MARKETING_AUTOMATION_KILL_SWITCH",
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gate = marketingCommentsMonitorGate(process.env);
  if (!gate.on) {
    console.log(JSON.stringify({ event: "marketing_comments_monitor", status: "off", reason: gate.reason }));
  } else {
    superviseMarketingGeneratorRun({
      worker: COMMENTS_MONITOR_WORKER,
      deadlineMs: COMMENTS_MONITOR_DEADLINE_MS,
      variables: COMMENTS_MONITOR_WORKER_VARIABLES,
    }).then((outcome) => {
      if (outcome.signal) {
        console.error(`Marketing comment monitor run ${outcome.runId} ended by ${outcome.signal}.`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = outcome.code ?? 1;
    });
  }
}
