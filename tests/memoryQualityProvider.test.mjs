import assert from "node:assert/strict";
import test from "node:test";
import { budgetedProviderPort, existingProviderPort } from "../tools/memory-quality/provider.ts";
import { createReplayAdapter } from "../tools/memory-quality/mock.ts";
import { digest } from "../tools/memory-quality/schema.ts";
import { MEMORY_EXTRACTION_OUTPUT_SCHEMA } from "../lib/memoryExtractionPrompt.ts";

const request = { task: "propose", system: "Synthetic only", input: {}, schema: {} };
const scope = { providerLimit: 100, providerUsed: 0, subBudgetLimit: 50, subBudgetUsed: 0,
  resetAt: "2026-10-22T00:00:00Z" };
function budget(events, extra = {}) {
  return { reserve: async (input) => {
    events.push("reserved");
    assert.equal(input.purpose, "memory-quality");
    return { grant: { requestDigest: input.requestDigest, reservedMicroUsd: 10, day: scope, month: scope, ...extra },
      markIssued: async () => { events.push("issued"); },
      close: async (outcome) => { events.push(outcome); } };
  } };
}
test("paid execution is off before any reservation or provider invocation", async () => {
  const events = [];
  const port = budgetedProviderPort({ maxRunMicroUsd: 100, provider: async () => { events.push("provider"); },
    budget: budget(events) });
  await assert.rejects(port(request), /paid_execution_disabled/);
  assert.deepEqual(events, []);
});
test("existing provider and sub-budget caps refuse before dispatch", async () => {
  for (const extra of [
    { day: { ...scope, providerUsed: 99 } },
    { month: { ...scope, subBudgetUsed: 49 } },
    { requestDigest: "a".repeat(64) }, { reservedMicroUsd: -1 },
  ]) {
    const events = [];
    const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 100,
      provider: async () => { events.push("provider"); }, budget: budget(events, extra) });
    await assert.rejects(port(request));
    assert.equal(events.includes("provider"), false);
    assert.deepEqual(events.at(-1), { outcome: "undispatched", retainReservation: false });
  }
});
test("all tasks consume the same run cap and retain conservative issued cost", async () => {
  const events = [];
  const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 20,
    provider: async () => ({ ok: true }), budget: budget(events) });
  await port(request);
  await port({ ...request, task: "judge" });
  await assert.rejects(port({ ...request, task: "select" }), /budget_refused/);
  assert.equal(events.filter((entry) => entry === "issued").length, 2);
  assert.ok(events.some((entry) => entry.outcome === "returned" && entry.retainReservation));
});
test("unknown provider outcome retains reservation, latches and never retries", async () => {
  const events = [];
  let calls = 0;
  const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 100,
    provider: async () => { calls++; throw new Error("potentially secret provider error"); }, budget: budget(events) });
  await assert.rejects(port(request), /provider_outcome_unknown/);
  await assert.rejects(port(request), /provider_outcome_unknown/);
  assert.equal(calls, 1);
  assert.deepEqual(events.at(-1), { outcome: "unknown", retainReservation: true });
});
test("existing extraction seam preserves prompt and schema without loading an SDK", async () => {
  const calls = [];
  const controller = new AbortController();
  const port = existingProviderPort({ extraction: (signal) => async (value) => {
    assert.equal(signal, controller.signal);
    signal.throwIfAborted();
    calls.push(value); return { output: { candidates: [] } };
  }, structured: async () => ({ analysis: "mock" }) });
  assert.deepEqual(await port({ task: "extract", system: "Candidate", input: { caseId: "a", prompt: "Synthetic" },
    schema: MEMORY_EXTRACTION_OUTPUT_SCHEMA }, { signal: controller.signal }), { candidates: [] });
  assert.equal(calls[0].prompt.system, "Candidate");
  assert.equal(calls[0].prompt.user, "Synthetic");
  await assert.rejects(port({ ...request, task: "extract" }), /extraction_schema_drift/);
  controller.abort();
  await assert.rejects(port({ task: "extract", system: "Candidate", input: { caseId: "a", prompt: "Synthetic" },
    schema: MEMORY_EXTRACTION_OUTPUT_SCHEMA }, { signal: controller.signal }));
  assert.equal(calls.length, 1);
});
test("an uncertain reservation commit latches without a second reservation", async () => {
  let reservations = 0, dispatched = 0;
  const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 100,
    provider: async () => { dispatched++; return {}; },
    budget: { reserve: async () => { reservations++; throw new Error("uncertain reservation commit"); } } });
  await assert.rejects(port(request), /budget_outcome_unknown/);
  await assert.rejects(port(request), /budget_outcome_unknown/);
  assert.equal(reservations, 1);
  assert.equal(dispatched, 0);
});
test("a late aborted provider response remains unknown and retains its reservation", async () => {
  const controller = new AbortController(), events = [];
  const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 100, budget: budget(events),
    provider: async () => { controller.abort(); return {}; } });
  await assert.rejects(port(request, { signal: controller.signal }), /provider_outcome_unknown/);
  assert.deepEqual(events.at(-1), { outcome: "unknown", retainReservation: true });
});
test("uncertain settlement is latched without issuing a second close write", async () => {
  let closes = 0, reservations = 0;
  const port = budgetedProviderPort({ enabled: true, maxRunMicroUsd: 100,
    provider: async () => ({}), budget: { reserve: async (input) => {
      reservations++;
      return { grant: { requestDigest: input.requestDigest, reservedMicroUsd: 10, day: scope, month: scope },
        markIssued: async () => {},
        close: async () => { closes++; throw new Error("unknown commit result"); } };
    } } });
  await assert.rejects(port(request), /provider_outcome_unknown/);
  await assert.rejects(port(request), /provider_outcome_unknown/);
  assert.equal(closes, 1);
  assert.equal(reservations, 1);
});
test("replay requires exact request binding and refuses duplicates or missing outputs", async () => {
  const entry = { requestDigest: digest(request), output: { analysis: "Archived response" } };
  assert.deepEqual(await createReplayAdapter([entry])(request), entry.output);
  await assert.rejects(createReplayAdapter([entry])({ ...request, system: "Changed" }), /replay_request_missing/);
  assert.throws(() => createReplayAdapter([entry, entry]), /invalid_replay/);
});
