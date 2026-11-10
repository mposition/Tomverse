import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { prepareChatSendInputs } from "../lib/chatSendPreparation.ts";
import { latencyDistribution } from "../lib/responseLatencyCore.ts";

// Offline only: fixed endpoint/provider delays, no network, DB or paid calls.
// The baseline reproduces the previous serial context-then-draft boundary.
const rounds = 40;
const rows = { before: [], after: [] };
const run = async (parallel, round) => {
  const started = performance.now();
  const calls = [];
  const context = async () => { calls.push("context"); await delay(30 + round % 5); return "same-context"; };
  const draft = async () => { calls.push("draft"); await delay(50 + round % 7); return "same-draft"; };
  const result = parallel
    ? await prepareChatSendInputs({ context, draft, isCurrent: () => true, abortDraft: () => assert.fail() })
    : { contextBundle: await context(), preparedDraft: await draft() };
  assert.deepEqual(result, { contextBundle: "same-context", preparedDraft: "same-draft" });
  assert.deepEqual(calls, ["context", "draft"]);
  // Unchanged durable-save, enabled location-intent and model/search work.
  await delay(15); await delay(20); await delay(60);
  const firstContentMs = performance.now() - started;
  await delay(20);
  return { firstContentMs, completionMs: performance.now() - started };
};
for (let round = 0; round < rounds; round++) {
  // Alternate order to reduce warmup/order bias; never run a pair concurrently.
  for (const variant of round % 2 ? ["after", "before"] : ["before", "after"]) {
    rows[variant].push(await run(variant === "after", round));
  }
}
console.log(JSON.stringify({ kind: "offline-controlled-delays-not-production", rounds,
  fixtureMs: { context: "30..34", draft: "50..56", save: 15, location: 20, providerToContent: 60, stream: 20 },
  results: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, {
    firstContent: latencyDistribution(values.map(value => value.firstContentMs)),
    completion: latencyDistribution(values.map(value => value.completionMs)),
  }])),
}, null, 2));
