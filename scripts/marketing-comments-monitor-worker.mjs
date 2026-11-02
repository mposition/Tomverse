// The comment monitor's hourly run: one run, then exit (marketing S4d, policy
// 12.1; lib/marketingCommentsClassifierCore.ts).
//
// Started by scripts/marketing-comments-monitor-service.mjs, which gives it the
// run id and the deadline and kills it at that deadline. It checks the switch
// itself first, before any request: with MARKETING_COMMENTS_MONITOR_ENABLED not
// true it asks the app for nothing, reserves nothing and calls nothing.
//
// The app reads the comments (it holds the posting tool's key and the
// database); this worker holds the LLM key and the generator's secret and
// nothing else. It is handed comment bodies alone, classifies them through the
// marketing LLM cost ledger as the `comment_triage` purpose (the operator's
// model, a reservation before each call, the monthly cap), and hands back one
// verdict per body. It logs counts only: no body, no verdict text.
//
// It does not retry. A call whose outcome is unknown stops the classifying;
// what was answered is still handed back, the ledger closes the row and a
// person looks.
//
// Loaded with --experimental-strip-types: every import is node or a relative
// module of this repository.

import { randomUUID } from "node:crypto";

import {
  MARKETING_COMMENT_VERDICT_SCHEMA,
  marketingCommentsAppPorts,
  marketingCommentsMonitorGate,
  runMarketingCommentsClassifyCycle,
} from "../lib/marketingCommentsClassifierCore.ts";
import { marketingLlmPinProblems } from "../lib/marketingLlmBudgetCore.ts";
import { marketingLlmBudgetHttpPort, runMarketingLlmCall } from "../lib/marketingLlmClientCore.ts";
import {
  marketingGeneratorAppPorts,
  marketingGeneratorPinForContext,
  marketingGeneratorWorkerConfig,
} from "../lib/marketingGeneratorCycleCore.ts";

const gate = marketingCommentsMonitorGate(process.env);
if (!gate.on) {
  console.log(JSON.stringify({ event: "marketing_comments_monitor", status: "off", reason: gate.reason }));
  process.exit(0);
}

const runId = process.env.MARKETING_GENERATOR_RUN_ID;
const deadlineAt = process.env.MARKETING_GENERATOR_DEADLINE;
if (!runId || !deadlineAt) {
  console.error("This worker is started by scripts/marketing-comments-monitor-service.mjs, which supplies the run id and deadline.");
  process.exit(1);
}

const configured = marketingGeneratorWorkerConfig(process.env);
if (!configured.ok) {
  console.error(`Marketing comment monitor will not run: ${configured.reason}.`);
  process.exit(1);
}
const { appUrl, secret, apiKey } = configured.config;

// Aborted a little before the deadline, so the run can say it ran out of time
// rather than vanish when the supervisor's SIGKILL lands.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), Math.max(0, Date.parse(deadlineAt) - Date.now() - 5_000));

const budget = marketingLlmBudgetHttpPort({ appUrl: appUrl.toString(), secret, deadlineAt, fetch, signal: controller.signal });
const generatorApp = marketingGeneratorAppPorts({ appUrl, secret, generatorRunId: runId, fetch, signal: controller.signal });

try {
  const summary = await runMarketingCommentsClassifyCycle(
    { deadlineAt },
    {
      ...marketingCommentsAppPorts({ appUrl, secret, fetch, signal: controller.signal }),
      // The model is the operator's Admin Console setting, read from the
      // generator's context only when there is something to classify.
      model: async () => {
        const chosen = marketingGeneratorPinForContext(await generatorApp.readContext(), marketingLlmPinProblems);
        if (!chosen.ok) return chosen;
        const { pin } = chosen;
        return {
          ok: true,
          call: (messages, requestKey) =>
            runMarketingLlmCall(
              { pin, generatorRunId: runId, purpose: "comment_triage", messages, requestKey, answerSchema: MARKETING_COMMENT_VERDICT_SCHEMA },
              { budget, transport: fetch, apiKey, signal: controller.signal },
            ),
        };
      },
      newId: randomUUID,
      now: Date.now,
    },
  );
  console.log(JSON.stringify({ event: "marketing_comments_monitor", runId, ...summary }));
  // A model that could not be used or a call that did not settle needs a
  // person; so does a step the app did not answer. Running out of time does not.
  const stage = summary.stoppedAt?.stage;
  process.exitCode = stage === "llm" || stage === "model" ? 2 : stage === "collect" || stage === "judge" ? 1 : 0;
} catch (error) {
  console.error(
    JSON.stringify({
      event: "marketing_comments_monitor_failed",
      runId,
      errorName: error instanceof Error ? error.name : typeof error,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
