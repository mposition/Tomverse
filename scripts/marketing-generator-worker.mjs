// The marketing generator's worker: one run, then exit (S3 plan, S3e3, S3f).
//
// Started by scripts/marketing-generator-service.mjs, which gives it the run
// id and the deadline and kills it at that deadline. A3 runs first: it reads
// the pages a person approved for each tracked competitor and reports the
// facts it finds. A5 then reads the app's context -- which now holds those
// facts -- asks the model once per approval-mode account through the LLM cost
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

import { marketingLlmPinProblems } from "../lib/marketingLlmBudgetCore.ts";
import { marketingLlmBudgetHttpPort, runMarketingLlmCall } from "../lib/marketingLlmClientCore.ts";
import { fetchMarketingA3Page } from "../lib/marketingA3Core.ts";
import { runMarketingA3Cycle } from "../lib/marketingA3CycleCore.ts";
import {
  marketingGeneratorAppPorts,
  marketingGeneratorPinForContext,
  marketingGeneratorWorkerConfig,
  runMarketingGeneratorCycle,
} from "../lib/marketingGeneratorCycleCore.ts";

/** Thrown to end the run after A3 stopped; not an error of its own. */
class StopRun extends Error {}

/**
 * A3's share of the run: twenty minutes from the start, so A5 always has the
 * rest (scripts/marketing-generator-service.mjs gives the run forty).
 */
const A3_SHARE_MS = 20 * 60 * 1000;

/** Drafts asked of each account per run. */
const POSTS_PER_ACCOUNT = 3;

const runId = process.env.MARKETING_GENERATOR_RUN_ID;
const deadlineAt = process.env.MARKETING_GENERATOR_DEADLINE;
if (!runId || !deadlineAt) {
  console.error("This worker is started by scripts/marketing-generator-service.mjs, which supplies the run id and deadline.");
  process.exit(1);
}

const configured = marketingGeneratorWorkerConfig(process.env);
if (!configured.ok) {
  // Not an error in the run: a worker without its variables has nothing to do.
  console.error(`Marketing generator will not run: ${configured.reason}.`);
  process.exit(1);
}
const { appUrl, secret, apiKey } = configured.config;

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

const app = marketingGeneratorAppPorts({ appUrl, secret, generatorRunId: runId, fetch, signal: controller.signal });

// The model is the operator's Admin Console setting, read from the context;
// the ledger refuses any other, so a worker started before a change spends
// nothing on the old model.
const chosen = marketingGeneratorPinForContext(await app.readContext(), marketingLlmPinProblems);
if (!chosen.ok) {
  console.error(`Marketing generator will not run: ${chosen.reason}.`);
  clearTimeout(timer);
  process.exit(1);
}
const pin = chosen.pin;

try {
  // A3's share is enforced, not just checked between competitors: every
  // request A3 makes is aborted when the share runs out, a call not yet sent
  // is given up rather than dispatched, and its ledger rows and report carry
  // the share's deadline, so nothing of A3's is recorded after it.
  const a3DeadlineAt = new Date(Math.min(Date.parse(deadlineAt), Date.now() + A3_SHARE_MS)).toISOString();
  const a3Controller = new AbortController();
  const a3Timer = setTimeout(() => a3Controller.abort(), Math.max(0, Date.parse(a3DeadlineAt) - Date.now()));
  // Not what keeps the worker alive: a run that ends early exits at once.
  a3Timer.unref();
  const a3Signal = AbortSignal.any([controller.signal, a3Controller.signal]);
  const a3Budget = marketingLlmBudgetHttpPort({
    appUrl: appUrl.toString(),
    secret,
    deadlineAt: a3DeadlineAt,
    fetch,
    signal: a3Signal,
  });
  const a3App = marketingGeneratorAppPorts({ appUrl, secret, generatorRunId: runId, fetch, signal: a3Signal });
  const intel = await runMarketingA3Cycle(
    { generatorRunId: runId, deadlineAt: a3DeadlineAt },
    {
      readContext: a3App.readContext,
      // A page gets no credential and no header of the app's: the plain fetch,
      // bounded by fetchMarketingA3Page and by A3's share.
      fetchPage: (url, hosts) => fetchMarketingA3Page({ url, hosts }, { fetch, signal: a3Signal }),
      callLlm: (messages, requestKey) =>
        runMarketingLlmCall(
          { pin, generatorRunId: runId, purpose: "market_intel", messages, requestKey },
          {
            budget: a3Budget,
            transport: fetch,
            apiKey,
            signal: a3Signal,
            // A minute before the share ends, a reserved call is released, not sent.
            proceed: () => Date.parse(a3DeadlineAt) - Date.now() > 60_000,
          },
        ),
      submitReport: a3App.submitReport,
      secret,
      newId: randomUUID,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  clearTimeout(a3Timer);
  // Counts and the stop reason only: no page text, no fact, no URL.
  console.log(JSON.stringify({ event: "marketing_generator_a3", runId, model: pin.model, ...intel }));
  if (intel.stoppedAt !== null && (intel.stoppedAt.stage === "llm" || intel.stoppedAt.stage === "submit")) {
    // An unknown outcome, a refused reservation or a report with no answer
    // stops the whole run, as it stops A5 within its own: a person looks
    // before anything else is sent. Running out of A3's share, or a context
    // A3 cannot read, only means no market facts this run; A5 goes on.
    process.exitCode = 2;
    throw new StopRun();
  }

  const summary = await runMarketingGeneratorCycle(
    { generatorRunId: runId, deadlineAt, postsPerAccount: POSTS_PER_ACCOUNT },
    {
      readContext: app.readContext,
      submit: app.submit,
      callLlm: (messages, requestKey) =>
        runMarketingLlmCall(
          { pin, generatorRunId: runId, purpose: "draft", messages, requestKey },
          { budget, transport: fetch, apiKey, signal: controller.signal },
        ),
      secret,
      newId: randomUUID,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  // Counts and the stop reason only: no words, no ids a reader could act on.
  console.log(JSON.stringify({ event: "marketing_generator_run", runId, model: pin.model, ...summary }));
  process.exitCode = summary.stoppedAt === null ? 0 : 2;
} catch (error) {
  if (error instanceof StopRun) {
    // Already reported above.
  } else {
  console.error(
    JSON.stringify({
      event: "marketing_generator_run_failed",
      runId,
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
  process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}
