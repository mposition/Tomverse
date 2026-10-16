import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import type { MarketingLlmPricePin } from "@/lib/marketingLlmBudgetCore";
import {
  MARKETING_LLM_HOLD_ACTIONS,
  purgeExpiredMarketingLlmCalls,
  releaseMarketingLlmCall,
  reserveMarketingLlmCall,
  setMarketingLlmCallLegalHold,
  type MarketingLlmBudgetEnvironment,
} from "@/lib/marketingLlmBudgetStore";
import { runMarketingRetention } from "@/lib/marketingRetention";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

// Legal hold and retention for the LLM cost ledger (S3c3c), against a real
// audit chain: a hold is a person's decision proven by a human audit row, and
// retention deletes only what the delete trigger lets go.

const AUDIT_SECRET = "marketing-llm-hold-db-secret-0001";
let previousAuditKey: string | undefined;
before(() => {
  previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
});
const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingLlmCall", "AdminAuditLog" RESTART IDENTITY CASCADE`);
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
  if (previousAuditKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousAuditKey;
});

const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

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
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deadline = () => new Date(Date.now() + 60_000);
const tx = <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn);

const releasedCall = async (n: number) => {
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
  const callId = outcome.status === "ok" ? outcome.value.callId : "";
  await tx((client) => releaseMarketingLlmCall(client, { callId, deadlineAt: deadline() }, OPEN));
  return callId;
};

const humanAudit = (action: string, targetId: string, previous: string | null, client?: Prisma.TransactionClient) =>
  writeAdminAuditLog({
    session: operator,
    request: new Request("https://tomverse.app/api/admin/marketing/llm-calls/x/legal-hold"),
    action,
    targetType: "MarketingLlmCall",
    targetId,
    summary: "Legal hold decision.",
    metadata: { actorHadMarketingWrite: true, previousHoldAuditLogId: previous ?? "none" },
    ...(client ? { tx: client } : {}),
  });

const currentDecision = async (callId: string) =>
  (await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id: callId } })).legalHoldAuditLogId;

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

/** A decision made from a page that showed `seen` (default: the current one). */
const hold = async (callId: string, value: boolean, seen?: string | null) => {
  const expected = seen === undefined ? await currentDecision(callId) : seen;
  return tx(async (client) => {
    const auditLogId = await humanAudit(
      value ? MARKETING_LLM_HOLD_ACTIONS.set : MARKETING_LLM_HOLD_ACTIONS.released,
      callId,
      expected,
      client,
    );
    await setMarketingLlmCallLegalHold(client, { callId, hold: value, auditLogId, expectedHoldAuditLogId: expected });
    return auditLogId;
  });
};

const age = async (id: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingLlmCall" DISABLE TRIGGER "MarketingLlmCall_update_guard"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "MarketingLlmCall" SET "retentionUntil" = "retentionUntil" - INTERVAL '25 months' WHERE "id" = $1`,
      id,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingLlmCall" ENABLE TRIGGER "MarketingLlmCall_update_guard"`);
  }
};

test("a legal hold is set and released only on a person's audit row for exactly that decision", async () => {
  const id = await releasedCall(1);
  await hold(id, true);
  assert.equal((await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } })).legalHold, true);
  // Setting it again is a conflict: the page was stale.
  await assert.rejects(hold(id, true), code("legal_hold_conflict"));
  // An audit row for the other decision is not evidence of this one.
  await assert.rejects(
    tx(async (client) => {
      const expected = await currentDecision(id);
      const auditLogId = await humanAudit(MARKETING_LLM_HOLD_ACTIONS.set, id, expected, client);
      await setMarketingLlmCallLegalHold(client, { callId: id, hold: false, auditLogId, expectedHoldAuditLogId: expected });
    }),
    code("audit_evidence_action_mismatch"),
  );
  // Nor is one about another call.
  const other = await releasedCall(2);
  await assert.rejects(
    tx(async (client) => {
      const expected = await currentDecision(id);
      const auditLogId = await humanAudit(MARKETING_LLM_HOLD_ACTIONS.released, other, expected, client);
      await setMarketingLlmCallLegalHold(client, { callId: id, hold: false, auditLogId, expectedHoldAuditLogId: expected });
    }),
    code("audit_evidence_target_mismatch"),
  );
  const firstHold = await currentDecision(id);
  const release = await hold(id, false);
  assert.equal((await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } })).legalHold, false);

  // Held again. The earlier release, presented again, is refused and does not
  // lift it: its predecessor is no longer the row's decision.
  await hold(id, true);
  await assert.rejects(
    tx((client) =>
      setMarketingLlmCallLegalHold(client, { callId: id, hold: false, auditLogId: release, expectedHoldAuditLogId: firstHold }),
    ),
  );
  assert.equal((await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } })).legalHold, true);
  // ... and a release made from a page that still showed the first hold is a
  // conflict, even with a fresh audit row of its own.
  await assert.rejects(hold(id, false, firstHold), code("legal_hold_conflict"));
  assert.equal((await prisma.marketingLlmCall.findUniqueOrThrow({ where: { id } })).legalHold, true);

  // The database holds the pairing on its own: the flag cannot move without
  // the decision, nor the decision without the flag.
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingLlmCall" SET "legalHold" = false WHERE "id" = $1`, id),
    /update_invalid/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingLlmCall" SET "legalHoldAuditLogId" = $2 WHERE "id" = $1`, id, release),
    /update_invalid|unique|duplicate/,
  );
});

test("retention deletes closed calls past 24 months, never a held or open one, with an audit row each", async () => {
  const due = await releasedCall(1);
  const held = await releasedCall(2);
  const young = await releasedCall(3);
  await hold(held, true);
  await age(due);
  await age(held);

  const { purged } = await tx((client) => purgeExpiredMarketingLlmCalls(client));
  assert.equal(purged, 1);
  assert.equal(await prisma.marketingLlmCall.count({ where: { id: due } }), 0);
  assert.equal(await prisma.marketingLlmCall.count({ where: { id: { in: [held, young] } } }), 2);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: due, action: "marketing_retention.row_purged" } });
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "marketing-retention");

  // Released from hold, the aged row goes on the next run, through the
  // retention step that runs every table.
  await hold(held, false);
  const counts = await runMarketingRetention(prisma);
  assert.equal(counts.MarketingLlmCall, 1);
  assert.equal(await prisma.marketingLlmCall.count({ where: { id: held } }), 0);
  assert.equal(await prisma.marketingLlmCall.count({ where: { id: young } }), 1);
});
