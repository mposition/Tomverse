import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import {
  marketingLlmAdapterConfigDigest,
  marketingLlmConfigSnapshot,
  MARKETING_LLM_ADAPTER_VERSION,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import {
  MARKETING_LLM_ACTIONS,
  dispatchMarketingLlmCall,
  releaseMarketingLlmCall,
  reportMarketingLlmCallUnknown,
  reserveMarketingLlmCall,
  settleMarketingLlmCall,
  type MarketingLlmBudgetEnvironment,
} from "@/lib/marketingLlmBudgetStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingLlmCall", "AdminAuditLog" RESTART IDENTITY CASCADE`);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const day = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const verifiedAt = Math.floor(Date.now() / day) * day - day;

// 128,000 x 0.8 + 4,096 x 3.2 -> 115,508 micro-USD per reservation.
const PIN: MarketingLlmPricePin = {
  model: "fixture-model-2026-10-01",
  tokenizerFamily: "o200k",
  projectId: "proj_fixture",
  region: "us",
  tiers: ["default", "flex"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: iso(verifiedAt),
  expiresAt: iso(verifiedAt + 90 * day),
  source: "https://example.invalid/pricing",
};
const RESERVATION = 115_508;
const ADAPTER = marketingLlmAdapterConfigDigest(
  marketingLlmConfigSnapshot({ pin: PIN, adapterVersion: MARKETING_LLM_ADAPTER_VERSION }),
);

const OPEN: MarketingLlmBudgetEnvironment = { killSwitchOn: false, monthlyCapRaw: "1", pins: [PIN] };

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deadline = (ms = 60_000) => new Date(Date.now() + ms);
const tx = <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);

const payload = (n: number, overrides: Partial<{ purpose: "draft" | "brief"; model: string; generatorRunId: string }> = {}) => ({
  requestKey: uuid(n),
  generatorRunId: overrides.generatorRunId ?? "run-1",
  purpose: overrides.purpose ?? ("draft" as const),
  model: overrides.model ?? PIN.model,
  adapterProfile: "text-only-v1",
});

const reserve = (n: number, env = OPEN, overrides = {}, ms?: number) =>
  tx((client) => reserveMarketingLlmCall(client, { payload: payload(n, overrides), deadlineAt: deadline(ms) }, env));

const reservedId = async (n: number, env = OPEN) => {
  const outcome = await reserve(n, env);
  assert.equal(outcome.status, "ok");
  return outcome.status === "ok" ? outcome.value.callId : "";
};

const dispatch = (callId: string, n: number, intent: number, env = OPEN, adapter = ADAPTER) =>
  tx((client) =>
    dispatchMarketingLlmCall(
      client,
      { callId, requestKey: uuid(n), dispatchIntentId: uuid(10_000 + intent), adapterConfigDigest: adapter, deadlineAt: deadline() },
      env,
    ),
  );

const observation = (n: number, overrides: Record<string, unknown> = {}) => ({
  observationId: uuid(20_000 + n),
  reportedModel: PIN.model,
  reportedServiceTier: "default",
  reportedInputTokens: 1_200,
  reportedOutputTokens: 300,
  ...overrides,
});

const settle = (callId: string, intent: number, obs = observation(intent), env = OPEN) =>
  tx((client) =>
    settleMarketingLlmCall(client, { callId, dispatchIntentId: uuid(10_000 + intent), observation: obs, deadlineAt: deadline() }, env),
  );

const row = (id: string) => prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } });

test("a reservation is the pin's maximum, audited by the generator actor, and replays from the row", async () => {
  const first = await reserve(1);
  assert.deepEqual(first.status === "ok" && { replay: first.replay, micro: first.value.reservedMicroUsd }, { replay: false, micro: RESERVATION });
  if (first.status !== "ok") return;
  const stored = await row(first.value.callId);
  assert.equal(stored.state, "reserved");
  assert.equal(stored.monthStart.toISOString().slice(8), "01T00:00:00.000Z");
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: stored.reservationAuditLogId } });
  assert.equal(audit.action, MARKETING_LLM_ACTIONS.reserved);
  assert.equal(audit.targetId, stored.id);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "marketing-generator");

  // The same body reads its answer back -- even with the kill switch on, no
  // pin and no cap, because a replay reads nothing current.
  const replay = await reserve(1, { killSwitchOn: true, monthlyCapRaw: undefined, pins: [] });
  assert.deepEqual(replay, { status: "ok", replay: true, value: first.value });
  // The same key with another body is a conflict, and writes nothing.
  assert.deepEqual(await reserve(1, OPEN, { purpose: "brief" }), { status: "conflict" });
  assert.equal(await prisma.marketingLlmCall.count(), 1);
  assert.equal(await prisma.adminAuditLog.count(), 1);
});

test("new reservations are refused without a switch, cap, pin or time, and leave nothing behind", async () => {
  assert.deepEqual(await reserve(1, { ...OPEN, killSwitchOn: true }), { status: "refused", code: "kill_switch" });
  assert.deepEqual(await reserve(1, { ...OPEN, killSwitchOn: null }), { status: "refused", code: "kill_switch" });
  assert.deepEqual(await reserve(1, { ...OPEN, monthlyCapRaw: "101" }), { status: "refused", code: "cap_unreadable" });
  assert.deepEqual(await reserve(1, { ...OPEN, monthlyCapRaw: undefined }), { status: "refused", code: "cap_unreadable" });
  assert.deepEqual(await reserve(1, { ...OPEN, pins: [] }), { status: "refused", code: "model_not_pinned" });
  assert.deepEqual(
    await reserve(1, { ...OPEN, pins: [{ ...PIN, verifiedAt: iso(verifiedAt - 100 * day), expiresAt: iso(verifiedAt - 10 * day) }] }),
    { status: "refused", code: "pin_expired" },
  );
  assert.deepEqual(await reserve(1, OPEN, {}, 5_000), { status: "refused", code: "deadline_too_close" });
  assert.equal(await prisma.marketingLlmCall.count(), 0);
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("the monthly cap admits exactly up to the cap and counts every reservation but released ones", async () => {
  const exact = { ...OPEN, monthlyCapRaw: "0.231016" }; // two reservations exactly
  await reservedId(1, exact);
  const second = await reservedId(2, exact);
  assert.deepEqual(await reserve(3, exact), { status: "refused", code: "budget_exhausted" });
  assert.deepEqual(await reserve(3, { ...OPEN, monthlyCapRaw: "0.231015" }), { status: "refused", code: "budget_exhausted" });

  // A dispatched call still counts at its reservation; a released one does not.
  assert.equal((await dispatch(second, 2, 2, exact)).status, "ok");
  assert.deepEqual(await reserve(3, exact), { status: "refused", code: "budget_exhausted" });
  const third = await reservedId(4, { ...OPEN, monthlyCapRaw: "1" });
  assert.equal((await tx((client) => releaseMarketingLlmCall(client, { callId: third, deadlineAt: deadline() }, OPEN))).status, "ok");
  const first = (await prisma.marketingLlmCall.findFirstOrThrow({ where: { requestKey: uuid(1) } })).id;
  assert.equal((await tx((client) => releaseMarketingLlmCall(client, { callId: first, deadlineAt: deadline() }, OPEN))).status, "ok");
  assert.equal((await reserve(5, exact)).status, "ok");
});

test("two connections reserving the last slot of a month admit exactly one", async () => {
  const env = { ...OPEN, monthlyCapRaw: "0.2" }; // room for one
  const outcomes = await Promise.all([reserve(1, env), reserve(2, env)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["ok", "refused"]);
  assert.equal(await prisma.marketingLlmCall.count(), 1);
});

test("dispatch is consumed once, bound to the stored adapter config, and refused outside reserved", async () => {
  const id = await reservedId(1);
  assert.deepEqual(await dispatch(id, 1, 1, OPEN, "f".repeat(64)), { status: "refused", code: "adapter_mismatch" });
  assert.deepEqual(await dispatch(id, 1, 1, { ...OPEN, killSwitchOn: true }), { status: "refused", code: "kill_switch" });
  const first = await dispatch(id, 1, 1);
  assert.equal(first.status === "ok" && first.value.firstConsumption, true);
  const again = await dispatch(id, 1, 1, { ...OPEN, killSwitchOn: true });
  assert.equal(again.status === "ok" && again.value.firstConsumption, false, "a replay never releases a second call");
  assert.deepEqual(await dispatch(id, 1, 2), { status: "conflict" });
  // The wrong request key is a conflict, not a dispatch.
  const other = await reservedId(2);
  assert.deepEqual(await dispatch(other, 3, 3), { status: "conflict" });
  // An intent already used by another call cannot be reused.
  assert.deepEqual(await dispatch(other, 2, 1), { status: "conflict" });
  const stored = await row(id);
  assert.equal(stored.state, "dispatched");
  assert.equal(stored.adapterConfigDigest, ADAPTER);

  const released = await reservedId(4);
  await tx((client) => releaseMarketingLlmCall(client, { callId: released, deadlineAt: deadline() }, OPEN));
  assert.deepEqual(await dispatch(released, 4, 4), { status: "refused", code: "call_state" });
});

test("settle closes once; contradictions keep the reservation as unknown with one fixed reason", async () => {
  const id = await reservedId(1);
  await dispatch(id, 1, 1);
  assert.deepEqual(await settle(id, 1, observation(1), { ...OPEN, killSwitchOn: true }), { status: "refused", code: "kill_switch" });
  const settled = await settle(id, 1);
  assert.deepEqual(settled, { status: "ok", replay: false, value: { callId: id, state: "settled", reason: "settled" } });
  assert.deepEqual(await settle(id, 1), { status: "ok", replay: true, value: { callId: id, state: "settled", reason: "settled" } });
  assert.deepEqual(await settle(id, 1, observation(1, { reportedOutputTokens: 301 })), { status: "conflict" });
  assert.deepEqual(
    await tx((client) => reportMarketingLlmCallUnknown(client, { callId: id, dispatchIntentId: uuid(10_001), deadlineAt: deadline() }, OPEN)),
    { status: "conflict" },
  );
  const stored = await row(id);
  assert.equal(stored.reportedInputTokens, 1_200);
  assert.equal((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: stored.closeAuditLogId! } })).action, MARKETING_LLM_ACTIONS.settled);

  const over = await reservedId(2);
  await dispatch(over, 2, 2);
  const outcome = await settle(over, 2, observation(2, { reportedOutputTokens: 4_097, reportedModel: "other", reportedServiceTier: "flex" }));
  assert.deepEqual(outcome.status === "ok" && outcome.value, { callId: over, state: "unknown_retained", reason: "tokens_over_bound" });
  assert.equal((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: (await row(over)).closeAuditLogId! } })).action, MARKETING_LLM_ACTIONS.unknownRetained);

  const tier = await reservedId(3);
  await dispatch(tier, 3, 3);
  const tierOutcome = await settle(tier, 3, observation(3, { reportedServiceTier: "flex" }));
  assert.equal(tierOutcome.status === "ok" && tierOutcome.value.reason, "tier_mismatch");

  // Another dispatch intent is a conflict.
  const wrong = await reservedId(4);
  await dispatch(wrong, 4, 4);
  assert.deepEqual(await settle(wrong, 5), { status: "conflict" });
});

test("unknown and release close only from their own state", async () => {
  const reserved = await reservedId(1);
  assert.deepEqual(await settle(reserved, 1), { status: "refused", code: "call_state" });
  assert.deepEqual(
    await tx((client) => reportMarketingLlmCallUnknown(client, { callId: reserved, dispatchIntentId: uuid(10_001), deadlineAt: deadline() }, OPEN)),
    { status: "refused", code: "call_state" },
  );
  const release = () => tx((client) => releaseMarketingLlmCall(client, { callId: reserved, deadlineAt: deadline() }, OPEN));
  assert.deepEqual(await release(), { status: "ok", replay: false, value: { callId: reserved, state: "released", reason: "reported_undispatched" } });
  assert.equal((await release()).status === "ok", true);

  // A dispatched call is never released: after a dispatch receipt the adapter
  // reports unknown, whether or not it called the provider.
  const dispatched = await reservedId(2);
  await dispatch(dispatched, 2, 2);
  assert.deepEqual(
    await tx((client) => releaseMarketingLlmCall(client, { callId: dispatched, deadlineAt: deadline() }, OPEN)),
    { status: "refused", code: "call_state" },
  );
  const unknown = await tx((client) =>
    reportMarketingLlmCallUnknown(client, { callId: dispatched, dispatchIntentId: uuid(10_002), deadlineAt: deadline() }, OPEN),
  );
  assert.deepEqual(unknown.status === "ok" && unknown.value, { callId: dispatched, state: "unknown_retained", reason: "reported_unknown" });
  assert.deepEqual(
    await tx((client) => releaseMarketingLlmCall(client, { callId: "cmissing000000000000000000", deadlineAt: deadline() }, OPEN)),
    { status: "refused", code: "call_not_found" },
  );
});

// Each action's longest path, counted as calls on the transaction client --
// what a statement budget can see. The plan's ceilings are reserve 12,
// dispatch 10, settle and unknown 10, release 9; the counts are pinned exactly
// so the next statement added to an action fails here.
const counting = (client: Prisma.TransactionClient) => {
  let calls = 0;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls += 1;
            return (value as (...inner: unknown[]) => unknown).apply(object, args);
          };
        }
        if (value && typeof value === "object" && typeof key === "string" && !key.startsWith("$")) {
          return wrap(value as object);
        }
        return value;
      },
    });
  return { client: wrap(client), calls: () => calls };
};

test("every action stays inside its statement ceiling", async () => {
  const measure = async <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) =>
    tx(async (client) => {
      const counted = counting(client);
      const outcome = await fn(counted.client);
      return { outcome, calls: counted.calls() };
    });
  const reserved = await measure((client) => reserveMarketingLlmCall(client, { payload: payload(1), deadlineAt: deadline() }, OPEN));
  assert.equal(reserved.outcome.status, "ok");
  const id = reserved.outcome.status === "ok" ? reserved.outcome.value.callId : "";
  const dispatched = await measure((client) =>
    dispatchMarketingLlmCall(
      client,
      { callId: id, requestKey: uuid(1), dispatchIntentId: uuid(10_001), adapterConfigDigest: ADAPTER, deadlineAt: deadline() },
      OPEN,
    ),
  );
  const settled = await measure((client) =>
    settleMarketingLlmCall(client, { callId: id, dispatchIntentId: uuid(10_001), observation: observation(1), deadlineAt: deadline() }, OPEN),
  );
  const other = await reservedId(2);
  await dispatch(other, 2, 2);
  const unknown = await measure((client) =>
    reportMarketingLlmCallUnknown(client, { callId: other, dispatchIntentId: uuid(10_002), deadlineAt: deadline() }, OPEN),
  );
  const third = await reservedId(3);
  const released = await measure((client) => releaseMarketingLlmCall(client, { callId: third, deadlineAt: deadline() }, OPEN));
  for (const measured of [dispatched, settled, unknown, released]) assert.equal(measured.outcome.status, "ok");
  assert.deepEqual(
    { reserve: reserved.calls, dispatch: dispatched.calls, settle: settled.calls, unknown: unknown.calls, release: released.calls },
    { reserve: 10, dispatch: 9, settle: 9, unknown: 9, release: 9 },
  );
});

// PostgreSQL 17 arms transaction_timeout from the moment it is set inside the
// transaction. The ledger relies on that, so it is shown here rather than
// assumed: after an action's bound() has run, the transaction cannot outlive
// the timer, even with every statement under the statement timeout.
test("an action arms the transaction timer inside the caller's transaction", async () => {
  const started = Date.now();
  await assert.rejects(
    prisma.$transaction(
      async (client) => {
        // Refused after bound() -- no pin -- so nothing is written.
        assert.deepEqual(
          await reserveMarketingLlmCall(client, { payload: payload(1), deadlineAt: deadline() }, { ...OPEN, pins: [] }),
          { status: "refused", code: "model_not_pinned" },
        );
        for (let i = 0; i < 3; i += 1) await client.$queryRawUnsafe("SELECT pg_sleep(4)::text");
      },
      { timeout: 30_000, maxWait: 30_000 },
    ),
    (error: unknown) => /transaction timeout|terminat|Server has closed|connection/i.test(String((error as Error)?.message ?? error)),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 11_500, `the transaction was stopped by its 10 s timer, not after ${elapsed} ms`);
  assert.ok(elapsed >= 9_000, `and not before it: ${elapsed} ms`);
});
