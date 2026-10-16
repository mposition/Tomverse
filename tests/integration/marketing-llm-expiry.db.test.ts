import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import {
  MARKETING_LLM_ADAPTER_VERSION,
  marketingLlmAdapterConfigDigest,
  marketingLlmCloseDigest,
  marketingLlmConfigSnapshot,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import {
  MARKETING_LLM_ACTIONS,
  dispatchMarketingLlmCall,
  expireMarketingLlmCalls,
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
const verifiedAt = Math.floor(Date.now() / day) * day - day;
const PIN: MarketingLlmPricePin = {
  model: "fixture-model-2026-10-01",
  tokenizerFamily: "o200k",
  projectId: "proj_fixture",
  region: "us",
  tiers: ["default"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: new Date(verifiedAt).toISOString(),
  expiresAt: new Date(verifiedAt + 90 * day).toISOString(),
  source: "https://example.invalid/pricing",
};
const OPEN: MarketingLlmBudgetEnvironment = { killSwitchOn: false, monthlyCapRaw: "1", pins: [PIN] };
const ADAPTER = marketingLlmAdapterConfigDigest(
  marketingLlmConfigSnapshot({ pin: PIN, adapterVersion: MARKETING_LLM_ADAPTER_VERSION }),
);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deadline = () => new Date(Date.now() + 60_000);
const tx = <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);

const reserve = async (n: number) => {
  const outcome = await tx((client) =>
    reserveMarketingLlmCall(
      client,
      {
        payload: { requestKey: uuid(n), generatorRunId: "run-1", purpose: "draft", model: PIN.model, adapterProfile: "text-only-v1" },
        deadlineAt: deadline(),
      },
      OPEN,
    ),
  );
  assert.equal(outcome.status, "ok");
  return outcome.status === "ok" ? outcome.value.callId : "";
};
const dispatch = (callId: string, n: number) =>
  tx((client) =>
    dispatchMarketingLlmCall(
      client,
      { callId, requestKey: uuid(n), dispatchIntentId: uuid(10_000 + n), adapterConfigDigest: ADAPTER, deadlineAt: deadline() },
      OPEN,
    ),
  );

// Time is the database's, so a stale row is made by moving its own clock
// columns back with the guard briefly off -- the one thing no writer can do.
const backdate = async (id: string, column: "createdAt" | "dispatchedAt", interval: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingLlmCall" DISABLE TRIGGER "MarketingLlmCall_update_guard"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "MarketingLlmCall" SET "${column}" = "${column}" - $2::interval WHERE "id" = $1`,
      id,
      interval,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingLlmCall" ENABLE TRIGGER "MarketingLlmCall_update_guard"`);
  }
};
const row = (id: string) => prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } });

test("stale reservations are released and stale dispatches kept as unknown, each with the expire close", async () => {
  const fresh = await reserve(1);
  const staleReserved = await reserve(2);
  const staleDispatched = await reserve(3);
  const freshDispatched = await reserve(4);
  await dispatch(staleDispatched, 3);
  await dispatch(freshDispatched, 4);
  await backdate(staleReserved, "createdAt", "15 minutes 1 second");
  await backdate(staleDispatched, "dispatchedAt", "61 minutes");

  const result = await expireMarketingLlmCalls(prisma, { killSwitchOn: false });
  assert.deepEqual(result, { skipped: null, examined: 2, released: 1, unknownRetained: 1, untouched: 0 });

  const released = await row(staleReserved);
  assert.equal(released.state, "released");
  assert.equal(released.closeReason, "reservation_expired");
  assert.equal(
    released.closeDigest,
    marketingLlmCloseDigest({
      callId: staleReserved,
      requestKey: uuid(2),
      action: "expire",
      terminalState: "released",
      reason: "reservation_expired",
    }),
  );
  const unknown = await row(staleDispatched);
  assert.equal(unknown.state, "unknown_retained");
  assert.equal(unknown.closeReason, "dispatch_expired");
  assert.equal(unknown.observationId, null);
  assert.equal(
    unknown.closeDigest,
    marketingLlmCloseDigest({
      callId: staleDispatched,
      requestKey: uuid(3),
      action: "expire",
      terminalState: "unknown_retained",
      reason: "dispatch_expired",
      dispatchIntentId: uuid(10_003),
    }),
  );
  const audits = await prisma.adminAuditLog.findMany({ where: { targetId: { in: [staleReserved, staleDispatched] } } });
  assert.deepEqual(
    audits.map((audit) => audit.action).sort(),
    [
      MARKETING_LLM_ACTIONS.dispatched,
      MARKETING_LLM_ACTIONS.released,
      MARKETING_LLM_ACTIONS.reserved,
      MARKETING_LLM_ACTIONS.reserved,
      MARKETING_LLM_ACTIONS.unknownRetained,
    ].sort(),
  );
  assert.equal((await row(fresh)).state, "reserved");
  assert.equal((await row(freshDispatched)).state, "dispatched");

  // A generator report arriving after the expiry is a conflict, not a close.
  const late = await tx((client) =>
    settleMarketingLlmCall(
      client,
      {
        callId: staleDispatched,
        dispatchIntentId: uuid(10_003),
        observation: {
          observationId: uuid(20_003),
          reportedModel: PIN.model,
          reportedServiceTier: "default",
          reportedInputTokens: 10,
          reportedOutputTokens: 10,
        },
        deadlineAt: deadline(),
      },
      OPEN,
    ),
  );
  assert.deepEqual(late, { status: "conflict" });

  // A rerun finds nothing left to close.
  assert.deepEqual(await expireMarketingLlmCalls(prisma, { killSwitchOn: false }), {
    skipped: null,
    examined: 0,
    released: 0,
    unknownRetained: 0,
    untouched: 0,
  });
});

test("the sweep does nothing while the kill switch is on or unreadable, and honours its batch limit", async () => {
  const ids = [await reserve(1), await reserve(2), await reserve(3)];
  for (const id of ids) await backdate(id, "createdAt", "20 minutes");
  for (const killSwitchOn of [true, null]) {
    const skipped = await expireMarketingLlmCalls(prisma, { killSwitchOn });
    assert.equal(skipped.skipped, "kill_switch");
    assert.equal(await prisma.marketingLlmCall.count({ where: { state: "reserved" } }), 3);
  }
  assert.equal((await expireMarketingLlmCalls(prisma, { killSwitchOn: false, limit: 2 })).released, 2);
  assert.equal(await prisma.marketingLlmCall.count({ where: { state: "reserved" } }), 1);
});

test("a row a generator request is holding is skipped, not waited on", async () => {
  const id = await reserve(1);
  await backdate(id, "createdAt", "20 minutes");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (client) => {
      await client.$queryRawUnsafe(`SELECT "id" FROM "MarketingLlmCall" WHERE "id" = $1 FOR UPDATE`, id);
      locked();
      await held;
    },
    { timeout: 30_000 },
  );
  await isLocked;
  try {
    const result = await expireMarketingLlmCalls(prisma, { killSwitchOn: false });
    assert.deepEqual(result, { skipped: null, examined: 1, released: 0, unknownRetained: 0, untouched: 1 });
  } finally {
    release();
    await holder;
  }
  assert.equal((await expireMarketingLlmCalls(prisma, { killSwitchOn: false })).released, 1);
});
