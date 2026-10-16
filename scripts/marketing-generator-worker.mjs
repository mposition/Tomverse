// The marketing generator's worker: one run, then exit (S3 plan, S3e3).
//
// Started by scripts/marketing-generator-service.mjs, which gives it the run
// id and the deadline and kills it at that deadline. It reads the app's
// context, asks the model once per approval-mode account through the LLM cost
// ledger, and submits what survives the reading to the draft intake, where
// the Guard judges it again. It holds the LLM key and the generator's secret
// and nothing else: no database, publishing, bucket or GitHub credential.
//
// It does not retry. A call whose outcome is unknown stops the run; the ledger
// closes the row and a person looks.
//
// Loaded with --experimental-strip-types: every import is node or a relative
// module of this repository.

import { randomUUID } from "node:crypto";

import { MARKETING_LLM_PRICE_PINS } from "../lib/marketingLlmBudgetCore.ts";
import { marketingLlmBudgetHttpPort, runMarketingLlmCall } from "../lib/marketingLlmClientCore.ts";
import {
  marketingGeneratorAppPorts,
  marketingGeneratorWorkerConfig,
  runMarketingGeneratorCycle,
} from "../lib/marketingGeneratorCycleCore.ts";

/** Drafts asked of each account per run. */
const POSTS_PER_ACCOUNT = 3;

const runId = process.env.MARKETING_GENERATOR_RUN_ID;
const deadlineAt = process.env.MARKETING_GENERATOR_DEADLINE;
if (!runId || !deadlineAt) {
  console.error("This worker is started by scripts/marketing-generator-service.mjs, which supplies the run id and deadline.");
  process.exit(1);
}

const configured = marketingGeneratorWorkerConfig(process.env, MARKETING_LLM_PRICE_PINS);
if (!configured.ok) {
  // Not an error in the run: a worker without a pin or a key has nothing to do.
  console.error(`Marketing generator will not run: ${configured.reason}.`);
  process.exit(1);
}
const { appUrl, secret, apiKey, pin } = configured.config;

// Aborted a little before the deadline, so the run can say it ran out of time
// rather than vanish when the supervisor's SIGKILL lands.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Math.max(0, Date.parse(deadlineAt) - Date.now() - 5_000));

const budget = marketingLlmBudgetHttpPort({
  appUrl: appUrl.toString(),
  secret,
  deadlineAt,
  fetch,
  signal: controller.signal,
});

try {
  const summary = await runMarketingGeneratorCycle(
    { generatorRunId: runId, deadlineAt, postsPerAccount: POSTS_PER_ACCOUNT },
    {
      ...marketingGeneratorAppPorts({ appUrl, secret, generatorRunId: runId, fetch, signal: controller.signal }),
      callLlm: (messages, requestKey) =>
        runMarketingLlmCall(
          { pin, generatorRunId: runId, purpose: "draft", messages, requestKey },
          { budget, transport: fetch, apiKey, signal: controller.signal },
        ),
      secret,
      newId: randomUUID,
      now: Date.now,
    },
  );
  // Counts and the stop reason only: no words, no ids a reader could act on.
  console.log(JSON.stringify({ event: "marketing_generator_run", runId, model: pin.model, ...summary }));
  process.exitCode = summary.stoppedAt === null ? 0 : 2;
} catch (error) {
  console.error(
    JSON.stringify({
      event: "marketing_generator_run_failed",
      runId,
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
