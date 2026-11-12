import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

/**
 * marketingLlmBudgetInProcessPort (lib/marketingLlmBudgetRequest.ts): the
 * budget port Admin's ad facts refresh hands runMarketingLlmCall. It must run
 * the same schema and the same store functions as the generator's signed
 * route, each in its own transaction, and answer in the route's shape; a
 * malformed field is refused before any store call.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

const calls: Array<{ fn: string; input: Record<string, unknown>; env: Record<string, unknown> }> = [];
let transactions = 0;
const store = (fn: string, outcome: unknown) => async (_tx: unknown, input: Record<string, unknown>, env: Record<string, unknown>) => {
  calls.push({ fn, input, env });
  return outcome;
};

mock.module(mod("lib/marketingLlmBudgetStore.ts"), {
  namedExports: {
    reserveMarketingLlmCall: store("reserve", { status: "ok", replay: false, value: { callId: "c123456789012345678901", reservedMicroUsd: 500 } }),
    dispatchMarketingLlmCall: store("dispatch", { status: "ok", replay: false, value: { callId: "c123456789012345678901", firstConsumption: true } }),
    settleMarketingLlmCall: store("settle", { status: "refused", code: "call_state" }),
    reportMarketingLlmCallUnknown: store("unknown", { status: "conflict" }),
    releaseMarketingLlmCall: store("release", { status: "ok", replay: false, value: {} }),
  },
});
mock.module(mod("lib/marketingLlmModelCatalog.ts"), { namedExports: { marketingLlmCatalogPins: async () => ["pin"] } });
mock.module(mod("lib/operationalMonitoring.ts"), { namedExports: { reportOperationalIncident: async () => undefined } });

const prisma = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    transactions += 1;
    return fn({});
  },
};
const deadlineAt = "2026-11-12T12:00:00.000Z";
const uuid = "00000000-0000-4000-8000-000000000001";

const port = async () => {
  const { marketingLlmBudgetInProcessPort } = await import(mod("lib/marketingLlmBudgetRequest.ts"));
  return marketingLlmBudgetInProcessPort(prisma as never, { killSwitchOn: false }, deadlineAt);
};

test("a reservation runs the store's reserve in a transaction, with the catalog's pins, and answers as the route does", async () => {
  calls.length = 0;
  transactions = 0;
  const answer = await (await port())("reserve", {
    requestKey: uuid,
    generatorRunId: "feature-refresh-1",
    purpose: "feature_refresh",
    model: "gpt-6-luna",
    adapterProfile: "text-only-v1",
  });
  assert.deepEqual(answer, { httpStatus: 200, body: { status: "ok", replay: false, callId: "c123456789012345678901", reservedMicroUsd: 500 } });
  assert.equal(transactions, 1);
  assert.equal(calls[0].fn, "reserve");
  assert.deepEqual(calls[0].input.payload, {
    requestKey: uuid,
    generatorRunId: "feature-refresh-1",
    purpose: "feature_refresh",
    model: "gpt-6-luna",
    adapterProfile: "text-only-v1",
  });
  assert.deepEqual(calls[0].input.deadlineAt, new Date(deadlineAt));
  assert.deepEqual(calls[0].env, { killSwitchOn: false, pins: ["pin"] });
});

test("refusals and conflicts keep the route's shapes", async () => {
  const send = await port();
  assert.deepEqual(
    await send("settle", {
      callId: "c123456789012345678901",
      dispatchIntentId: uuid,
      observationId: uuid,
      reportedModel: "gpt-6-luna",
      reportedServiceTier: "default",
      reportedInputTokens: 1,
      reportedOutputTokens: 1,
    }),
    { httpStatus: 200, body: { status: "refused", code: "call_state" } },
  );
  assert.deepEqual(await send("unknown", { callId: "c123456789012345678901", dispatchIntentId: uuid }), {
    httpStatus: 409,
    body: { status: "conflict" },
  });
});

test("a field the schema refuses never reaches the store", async () => {
  calls.length = 0;
  transactions = 0;
  const answer = await (await port())("reserve", { requestKey: "not-a-uuid", generatorRunId: "x", purpose: "nope", model: "m", adapterProfile: "text-only-v1" });
  assert.deepEqual(answer, { httpStatus: 400, body: { code: "invalid_request" } });
  assert.equal(calls.length, 0);
  assert.equal(transactions, 0);
});
