import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { POST } from "@/app/api/internal/marketing-llm-budget/route";
import {
  MARKETING_LLM_ADAPTER_VERSION,
  marketingLlmAdapterConfigDigest,
  marketingLlmBudgetSignature,
  marketingLlmConfigSnapshot,
  type MarketingLlmPricePin,
} from "@/lib/marketingLlmBudgetCore";
import { handleMarketingLlmBudgetRequest, MARKETING_LLM_BUDGET_MAX_BODY_BYTES } from "@/lib/marketingLlmBudgetRequest";
import type { MarketingLlmBudgetEnvironment } from "@/lib/marketingLlmBudgetStore";
import { MARKETING_GENERATOR_SECRET_ENV } from "@/lib/marketingGeneratorAuth";
import { prisma } from "@/lib/prisma";
import { clearMarketingLlmSettings, setMarketingLlmSettings } from "./marketingLlmSettingsFixture";
import { resetTestFixture } from "./resetTestFixture";

const SECRET = "g".repeat(48);
const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingLlmCall", "AdminAuditLog" RESTART IDENTITY CASCADE`);
beforeEach(async () => {
  await reset();
  await setMarketingLlmSettings(prisma, PIN.model, "1");
});
after(async () => {
  await reset();
  await clearMarketingLlmSettings(prisma);
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
const BUDGET: MarketingLlmBudgetEnvironment = { killSwitchOn: false, pins: [PIN] };
const ENV = { [MARKETING_GENERATOR_SECRET_ENV]: SECRET };

const deadlineAt = () => new Date(Date.now() + 60_000).toISOString();
const sign = (body: Record<string, unknown>, secret = SECRET) => {
  const { action, deadlineAt: deadline, ...fields } = body as { action: string; deadlineAt: string };
  return { ...body, signature: marketingLlmBudgetSignature(secret, { action, deadlineAt: deadline, fields }) };
};
const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  new Request("http://localhost/api/internal/marketing-llm-budget", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const handle = (request: Request, budget = BUDGET) =>
  handleMarketingLlmBudgetRequest(request, { prisma, env: ENV, budget });

const reserveBody = () =>
  sign({
    action: "reserve",
    deadlineAt: deadlineAt(),
    requestKey: "00000000-0000-4000-8000-000000000001",
    generatorRunId: "run-1",
    purpose: "draft",
    model: PIN.model,
    adapterProfile: "text-only-v1",
  });

test("a signed reserve, dispatch and settle run end to end, each in its own transaction", async () => {
  const reserved = await handle(post(reserveBody()));
  assert.equal(reserved.status, 200);
  assert.equal(reserved.body.status, "ok");
  const callId = reserved.body.callId as string;
  const adapterConfigDigest = marketingLlmAdapterConfigDigest(
    marketingLlmConfigSnapshot({ pin: PIN, adapterVersion: MARKETING_LLM_ADAPTER_VERSION }),
  );
  const dispatched = await handle(
    post(
      sign({
        action: "dispatch",
        deadlineAt: deadlineAt(),
        callId,
        requestKey: "00000000-0000-4000-8000-000000000001",
        dispatchIntentId: "00000000-0000-4000-8000-0000000000d1",
        adapterConfigDigest,
      }),
    ),
  );
  assert.deepEqual(dispatched.body.firstConsumption, true);
  const settled = await handle(
    post(
      sign({
        action: "settle",
        deadlineAt: deadlineAt(),
        callId,
        dispatchIntentId: "00000000-0000-4000-8000-0000000000d1",
        observationId: "00000000-0000-4000-8000-0000000000b1",
        reportedModel: PIN.model,
        reportedServiceTier: "default",
        reportedInputTokens: 900,
        reportedOutputTokens: 120,
      }),
    ),
  );
  assert.deepEqual(settled, { status: 200, body: { status: "ok", replay: false, callId, state: "settled", reason: "settled" } });
  // A different close for the same call is a conflict.
  const released = await handle(post(sign({ action: "release", deadlineAt: deadlineAt(), callId })));
  assert.deepEqual(released, { status: 409, body: { status: "conflict" } });
});

test("unauthenticated, oversized, malformed and badly signed requests write nothing", async () => {
  assert.equal((await handle(post(reserveBody(), {}))).status, 401);
  assert.equal((await handle(post(reserveBody(), { authorization: `Bearer ${"x".repeat(48)}` }))).status, 401);
  assert.equal((await handle(post("x".repeat(MARKETING_LLM_BUDGET_MAX_BODY_BYTES + 1)))).status, 413);
  assert.deepEqual(await handle(post("{not json")), { status: 400, body: { code: "invalid_request" } });
  assert.deepEqual(await handle(post({ ...reserveBody(), extra: 1 })), { status: 400, body: { code: "invalid_request" } });
  assert.deepEqual(await handle(post(sign({ ...reserveBody(), signature: undefined }, "h".repeat(48)))), {
    status: 401,
    body: { code: "signature_invalid" },
  });
  // The deadline is signed: moving it later invalidates the request.
  const body = reserveBody();
  assert.deepEqual(await handle(post({ ...body, deadlineAt: new Date(Date.now() + 120_000).toISOString() })), {
    status: 401,
    body: { code: "signature_invalid" },
  });
  // A missing secret refuses everything rather than accepting anything.
  assert.equal(
    (await handleMarketingLlmBudgetRequest(post(reserveBody()), { prisma, env: {}, budget: BUDGET })).status,
    401,
  );
  assert.equal(await prisma.marketingLlmCall.count(), 0);
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("the route as built pins no model, so every reservation is refused", async () => {
  const previous = process.env[MARKETING_GENERATOR_SECRET_ENV];
  process.env[MARKETING_GENERATOR_SECRET_ENV] = SECRET;
  // A model selected and a cap set in the Admin Console; the build pins none.
  await setMarketingLlmSettings(prisma, PIN.model, "100");
  try {
    const response = await POST(post(reserveBody()));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "refused", code: "model_not_pinned" });
  } finally {
    if (previous === undefined) delete process.env[MARKETING_GENERATOR_SECRET_ENV];
    else process.env[MARKETING_GENERATOR_SECRET_ENV] = previous;
  }
  assert.equal(await prisma.marketingLlmCall.count(), 0);
});

test("a failure inside the transaction answers 503 and reports an incident without the request", async () => {
  const reports: Array<Record<string, unknown>> = [];
  const failing = {
    $transaction: async () => {
      throw new Error("connection lost");
    },
  } as unknown as typeof prisma;
  const response = await handleMarketingLlmBudgetRequest(post(reserveBody()), {
    prisma: failing,
    env: ENV,
    budget: BUDGET,
    report: async (incident) => {
      reports.push(incident as unknown as Record<string, unknown>);
      return undefined as never;
    },
  });
  assert.deepEqual(response, { status: 503, body: { code: "ledger_unavailable" } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, "MARKETING_LLM_BUDGET_LEDGER_UNAVAILABLE");
  assert.deepEqual(reports[0].context, { component: "marketing-llm-budget", action: "reserve" });
  assert.ok(!JSON.stringify(reports[0].context).includes("run-1"), "no request field is reported");
});
