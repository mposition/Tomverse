// The weekly AI-exposure measurement worker: one run, then exit (marketing S5,
// policy 10.4; lib/marketingAiVisibilityCore.ts).
//
// Started by scripts/marketing-generator-service.mjs after a clean generator
// run, on the measurement weekday, and only while MARKETING_AI_VISIBILITY_ENABLED
// is exactly "true". The service gives it the run id and the deadline and kills
// it at that deadline. It checks the switch itself first, before any request:
// started by hand with the switch off, it reserves nothing and calls nothing.
//
// Every call goes through the marketing LLM cost ledger (reservation before the
// call, the operator's monthly cap, the generator's pinned model) as the
// `market_intel` purpose, so no new paid path exists. The answers are judged by
// a second call and dropped; what is submitted is one signed `measurement_120d`
// rate per locale and metric. It holds the LLM key and the generator's secret
// and nothing else: no database, publishing, bucket or GitHub credential.
//
// It does not retry. A call whose outcome is unknown stops the run and reports
// nothing; the ledger closes the row and a person looks.
//
// Loaded with --experimental-strip-types: every import is node or a relative
// module of this repository.

import { randomUUID } from "node:crypto";

import { marketingAiVisibilityGate, runMarketingAiVisibilityCycle } from "../lib/marketingAiVisibilityCore.ts";
import { marketingLlmPinProblems } from "../lib/marketingLlmBudgetCore.ts";
import { marketingLlmBudgetHttpPort, runMarketingLlmCall } from "../lib/marketingLlmClientCore.ts";
import {
  marketingGeneratorAppPorts,
  marketingGeneratorPinForContext,
  marketingGeneratorWorkerConfig,
} from "../lib/marketingGeneratorCycleCore.ts";

const gate = marketingAiVisibilityGate(process.env);
if (!gate.on) {
  console.log(JSON.stringify({ event: "marketing_ai_visibility", status: "off", reason: gate.reason }));
  process.exit(0);
}

const runId = process.env.MARKETING_GENERATOR_RUN_ID;
const deadlineAt = process.env.MARKETING_GENERATOR_DEADLINE;
if (!runId || !deadlineAt) {
  console.error("This worker is started by scripts/marketing-generator-service.mjs, which supplies the run id and deadline.");
  process.exit(1);
}

const configured = marketingGeneratorWorkerConfig(process.env);
if (!configured.ok) {
  console.error(`Marketing AI visibility will not run: ${configured.reason}.`);
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

try {
  // The model is the operator's Admin Console setting, read from the context;
  // the ledger refuses any other. A web-search call also needs a pin that
  // prices its searches, and the ledger refuses the reservation without one.
  const chosen = marketingGeneratorPinForContext(await app.readContext(), marketingLlmPinProblems);
  if (!chosen.ok) {
    console.error(`Marketing AI visibility will not run: ${chosen.reason}.`);
    process.exitCode = 1;
  } else {
    const { pin } = chosen;
    const summary = await runMarketingAiVisibilityCycle(
      { generatorRunId: runId, deadlineAt, env: process.env },
      {
        // The question as a person would ask it, answered with the provider's web search (unrestricted).
        callAnswer: (messages, requestKey) =>
          runMarketingLlmCall(
            { pin, generatorRunId: runId, purpose: "market_intel", messages, requestKey, webSearch: { allowedDomains: [] } },
            { budget, transport: fetch, apiKey, signal: controller.signal },
          ),
        callJudge: (messages, requestKey) =>
          runMarketingLlmCall(
            { pin, generatorRunId: runId, purpose: "market_intel", messages, requestKey },
            { budget, transport: fetch, apiKey, signal: controller.signal },
          ),
        submitReport: app.submitReport,
        secret,
        newId: randomUUID,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
    // Counts and the stop reason only: no question text, no answer, no URL.
    console.log(JSON.stringify({ event: "marketing_ai_visibility", runId, model: pin.model, ...summary }));
    // An unknown outcome, a refused reservation or a report with no answer needs a person;
    // running out of time only means no measurement this week.
    process.exitCode = summary.stoppedAt !== null && (summary.stoppedAt.stage === "llm" || summary.stoppedAt.stage === "submit") ? 2 : 0;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "marketing_ai_visibility_failed",
      runId,
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
