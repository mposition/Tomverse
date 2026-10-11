import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { commitAnalysisBudgetSetting, readAnalysisBudgetSnapshot } from "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { assessAmuxIdeaAnalysisBudget } from "@/lib/amux/ideaAnalysisBudgetCore";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const target = testUrl ? new URL(testUrl) : null;
if (!target || !["postgres:", "postgresql:"].includes(target.protocol) ||
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(target.pathname) || target.search || target.hash ||
  process.env.DATABASE_URL !== testUrl || (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl))
  throw new Error("REFUSE: monthly budget tests require a dedicated loopback test database");

const actorUserId = `synthetic-monthly-owner-${randomUUID()}`;
const email = "amux-v4-budget-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = email;
process.env.ADMIN_OWNER_EMAILS = email;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-v4-frontier-catalog-audit-key-2026";
const session = { user: { id: actorUserId, email, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/analysis-budget-settings", { method: "POST" });
const identity = { namespace: "agent/amux-intake", monthStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) };
const input = (changes = {}) => ({ session, request, id: randomUUID(), expectedPreviousVersion: 0,
  monthlyUsd: "1000", ownerConfirmed: true as const, ...changes });
class Rollback extends Error {}
async function rollback(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  await assert.rejects(prisma.$transaction(async (tx) => { await work(tx); throw new Rollback(); },
    { timeout: 15_000 }), Rollback);
}

before(async () => {
  assert.equal(await prisma.amuxIdeaAnalysisBudgetSetting.count(), 0, "use a fresh DB, not an existing operator setting");
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({ where: { namespace_monthStart: identity },
    create: { ...identity, limitMicroUsd: BigInt(50_000_000), spentMicroUsd: BigInt(42_240_000), reservedMicroUsd: BigInt(5_000_000) },
    update: { spentMicroUsd: BigInt(42_240_000), reservedMicroUsd: BigInt(5_000_000) } });
});
after(async () => { await prisma.$disconnect(); });

test("owner saves USD 1000 atomically with canonical audit while preserving spent and reserved", async () => {
  await rollback(async (tx) => {
    const before = await readAnalysisBudgetSnapshot(tx);
    const saved = await commitAnalysisBudgetSetting(tx, input());
    const after = await readAnalysisBudgetSnapshot(tx);
    assert.equal(saved.version, 1);
    assert.equal(after.limitMicroUsd, "1000000000");
    assert.equal(after.spentMicroUsd, before.spentMicroUsd);
    assert.equal(after.reservedMicroUsd, before.reservedMicroUsd);
    assert.equal(after.remainingMicroUsd, "952760000");
    const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: saved.auditId } });
    assert.equal(audit.action, "amux.idea.analysis_budget.updated");
    assert.equal(audit.actorUserId, actorUserId);
    assert.ok(audit.entryHash);
    assert.equal(audit.targetId, saved.id);
    const decision = assessAmuxIdeaAnalysisBudget({ namespace: identity.namespace, mode: "subscription_cli",
      provider: "anthropic", modelId: "synthetic-frontier", pricingVersion: "synthetic-v1",
      asOfIso: new Date().toISOString(), windowStartsAtIso: identity.monthStart.toISOString(),
      pricingVerifiedAt: identity.monthStart.toISOString(), pricingExpiresAt: "2027-01-01T00:00:00.000Z",
      worstTierVerified: true, tokenCapsEnforceable: true, billableToolsDisabled: true,
      inputTokensCap: 1_000_000, outputTokensCap: 128_000, inputMicroUsdPerMillion: 8_000_000,
      outputMicroUsdPerMillion: 20_000_000, consumedMicroUsd: after.spentMicroUsd,
      reservedMicroUsd: after.reservedMicroUsd, monthlyLimitMicroUsd: after.limitMicroUsd, usageState: "known" });
    assert.equal(decision.decision, "reservation_candidate");
  });
  assert.equal(await prisma.amuxIdeaAnalysisBudgetSetting.count(), 0);
});

test("a ceiling below committed costs, stale version, and malformed money produce no audit or setting", async () => {
  for (const [change, code] of [[{ monthlyUsd: "47" }, "below_committed_cost"],
    [{ expectedPreviousVersion: 9 }, "revision_changed"], [{ monthlyUsd: "1e3" }, "invalid_budget"]] as const) {
    const count = await prisma.adminAuditLog.count();
    await assert.rejects(prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, input(change))),
      (error: unknown) => error instanceof Error && error.message === code);
    assert.equal(await prisma.adminAuditLog.count(), count);
    assert.equal(await prisma.amuxIdeaAnalysisBudgetSetting.count(), 0);
  }
});

test("non-owner and stale authentication cannot save the setting", async () => {
  const other = { ...session, user: { ...session.user, id: "synthetic-other", email: "other@example.test" } };
  await assert.rejects(prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, input({ session: other }))), /forbidden/);
  const stale = { ...session, user: { ...session.user, authenticatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() } };
  await assert.rejects(prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, input({ session: stale }))), /recent|authentication|reauth/i);
});

test("the same request ID cannot append a duplicate and a stale second save cannot overwrite the first", async () => {
  await rollback(async (tx) => {
    const first = input();
    await commitAnalysisBudgetSetting(tx, first);
    await assert.rejects(commitAnalysisBudgetSetting(tx, first), /request_already_seen/);
    await assert.rejects(commitAnalysisBudgetSetting(tx, input()), /revision_changed/);
    assert.equal(await tx.amuxIdeaAnalysisBudgetSetting.count(), 1);
  });
});

test("DB rejects an unaudited ceiling change and an unaudited setting insert", async () => {
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.update({ where: { namespace_monthStart: identity },
    data: { limitMicroUsd: BigInt(1_000_000_000) } }), /current owner approval/);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetSetting.create({ data: { id: randomUUID(), version: 1,
    limitMicroUsd: BigInt(1_000_000_000), effectiveMonth: identity.monthStart,
    approvedByUserId: actorUserId, approvalAuditLogId: randomUUID() } }), /approval evidence mismatch/);
});

test("DB refuses mutation of an approved setting and preserves the total budget invariant", async () => {
  for (const operation of ["update", "delete"] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const saved = await commitAnalysisBudgetSetting(tx, input());
      if (operation === "update") await tx.amuxIdeaAnalysisBudgetSetting.update({ where: { id: saved.id }, data: { limitMicroUsd: BigInt(2_000_000_000) } });
      else await tx.amuxIdeaAnalysisBudgetSetting.delete({ where: { id: saved.id } });
    }), /append only/);
  }
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.update({ where: { namespace_monthStart: identity },
    data: { reservedMicroUsd: BigInt(50_000_000) } }), /total_check/);
});

test("closed months are unchanged and future months inherit the approved amount", async () => {
  await rollback(async (tx) => {
    const past = new Date(Date.UTC(identity.monthStart.getUTCFullYear(), identity.monthStart.getUTCMonth() - 1, 1));
    const future = new Date(Date.UTC(identity.monthStart.getUTCFullYear(), identity.monthStart.getUTCMonth() + 1, 1));
    await tx.amuxIdeaAnalysisBudgetWindow.create({ data: { namespace: identity.namespace, monthStart: past,
      limitMicroUsd: BigInt(50_000_000), spentMicroUsd: BigInt(100_000) } });
    await commitAnalysisBudgetSetting(tx, input());
    assert.equal((await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace: identity.namespace, monthStart: past } },
    })).limitMicroUsd, BigInt(50_000_000));
    await tx.amuxIdeaAnalysisBudgetWindow.create({ data: { namespace: identity.namespace, monthStart: future,
      limitMicroUsd: BigInt(1_000_000_000) } });
    assert.equal((await tx.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
      where: { namespace_monthStart: { namespace: identity.namespace, monthStart: future } },
    })).limitMicroUsd, BigInt(1_000_000_000));
  });
});
