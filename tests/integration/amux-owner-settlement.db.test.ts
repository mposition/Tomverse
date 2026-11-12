import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { closeAmuxLegacyCardWithin, completeAmuxStoppedCardWithin } from "@/lib/amux/legacyCardOwnerService";
import { prisma } from "@/lib/prisma";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// The owner settles any stopped v22 Task (owner decision 2026-11-12) against
// PostgreSQL with every migration trigger installed. Rollback-only: the seed
// walks one Task through its real transitions (todo -> doing -> settled), the
// settlement runs inside the same transaction, and the deferred constraint
// triggers are forced before the rollback so a row production would refuse at
// commit is refused here.

const testRaw = process.env.TEST_DATABASE_URL?.trim();
if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
  throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
}
const url = new URL(testRaw);
if (!(url.searchParams.get("schema") === "tomverse_amux_test" ||
  (decodeURIComponent(url.pathname.replace(/^\/+/, "")) === "tomverse_test" &&
    ["127.0.0.1", "localhost"].includes(url.hostname)))) {
  throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
}

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-owner-settlement-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });
const OWNER_ID = `owner-settlement-${randomUUID()}`;
const OWNER_EMAIL = "amux-owner-settlement@example.test";

const owner = () => ({
  user: { id: OWNER_ID, email: OWNER_EMAIL, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
}) as Session;
const request = () => new Request("https://tomverse.test/api/admin/amux/legacy-card", {
  method: "POST", headers: { "user-agent": "synthetic-owner-settlement" } });

type Tx = Prisma.TransactionClient;

function queryAdapter(tx: Tx) {
  return { query: async (sql: string, params: unknown[] = []) => {
    if (/^\s*SELECT\s+pg_advisory_xact_lock\b/i.test(sql)) {
      const rowCount = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      const rows = await tx.$queryRawUnsafe<unknown[]>(sql, ...params);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  } };
}

async function inRollback(work: (tx: Tx, seed: (input?: Record<string, unknown>) => Promise<{
  taskId: string; priorAttemptId: string }>) => Promise<void>) {
  const rollback = new Error("synthetic owner settlement rollback");
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    await work(tx, (input = {}) => seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), input));
    // What the commit would check.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  }, { timeout: 60_000 }), (error) => error === rollback);
}

async function openEscalation(tx: Tx, taskId: string, reason: string) {
  const id = randomUUID();
  await tx.$executeRaw`INSERT INTO "AmuxHumanEscalation"
    ("id", "taskId", "reason", "status", "openedBy", "openedTaskRevision", "updatedAt")
    VALUES (${id}, ${taskId}, ${reason}, 'open', 'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`;
  return id;
}

const card = (tx: Tx, taskId: string) => tx.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId },
  select: { status: true, revision: true, archivedAt: true, v4TerminalAt: true, owner: true } });

test("the owner completes a v22 Task stopped in review as done, whatever stopped it", async () => {
  await inRollback(async (tx, seed) => {
    // An implement run that reached review with no pull request and unknown usage:
    // nothing the review decision offers completes it.
    const { taskId, priorAttemptId } = await seed({ taskRole: "implement", settlementReason: "reported_result" });
    const escalationId = await openEscalation(tx, taskId, "human_review_required");

    const result = await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 4, reason: "PR merged by the owner; the work is on develop." });
    assert.equal(result.outcome, "completed");

    const after = await card(tx, taskId);
    assert.equal(after.status, "done");
    assert.equal(after.revision, 5);
    assert.equal(after.archivedAt, null);
    assert.ok(after.v4TerminalAt);
    const escalation = await tx.amuxHumanEscalation.findUniqueOrThrow({ where: { id: escalationId } });
    assert.equal(escalation.status, "resolved");
    assert.equal(escalation.resolutionOutcome, "approve");
    assert.match(escalation.resolution ?? "", /^Completed by the owner: PR merged/);
    // The run's unknown usage no longer holds its worker.
    const acceptance = await tx.amuxV22AttemptUsageAcceptance.findUnique({ where: { attemptId: priorAttemptId } });
    assert.equal(acceptance?.source, "owner_accept");
    const audit = await tx.adminAuditLog.findFirstOrThrow({
      where: { action: "amux.owner_settlement.completed", targetId: taskId } });
    assert.equal(audit.actorUserId, OWNER_ID);
    assert.equal((audit.metadata as { reason: string }).reason, "PR merged by the owner; the work is on develop.");
    assert.ok(audit.entryHash);
  });
});

test("the owner completes a blocked Task whose run expired with an unknown outcome", async () => {
  await inRollback(async (tx, seed) => {
    const { taskId } = await seed({ taskRole: "implement", settlementStatus: "blocked",
      settlementOutcome: "expired", settlementReason: "outcome_unknown" });
    await openEscalation(tx, taskId, "execution_lease_expired");
    const result = await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 4, reason: "Verified by hand." });
    assert.equal(result.outcome, "completed");
    assert.equal((await card(tx, taskId)).status, "done");
  });
});

test("a completion is refused on a stale revision and on a card that is not stopped", async () => {
  await inRollback(async (tx, seed) => {
    const { taskId } = await seed({ taskRole: "implement" });
    assert.deepEqual(await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 3, reason: "stale" }), { outcome: "refused", reason: "changed" });
    assert.equal((await card(tx, taskId)).status, "review");
    // Once done it is no longer a stopped card: a second completion finds nothing to settle.
    assert.equal((await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 4, reason: "first" })).outcome, "completed");
    assert.deepEqual(await completeAmuxStoppedCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 5, reason: "second" }), { outcome: "refused", reason: "not_legacy" });
  });
});

test("the owner closes a stopped v22 Task: archived, status kept, usage accepted", async () => {
  await inRollback(async (tx, seed) => {
    const { taskId, priorAttemptId } = await seed({ taskRole: "implement", settlementStatus: "blocked",
      settlementOutcome: "expired", settlementReason: "outcome_unknown" });
    const escalationId = await openEscalation(tx, taskId, "execution_lease_expired");
    const result = await closeAmuxLegacyCardWithin(tx, { session: owner(), request: request(),
      taskId, revision: 4, ideaId: "idea-synthetic-remake" });
    assert.equal(result.outcome, "closed");
    const after = await card(tx, taskId);
    assert.equal(after.status, "blocked");
    assert.equal(after.revision, 5);
    assert.ok(after.archivedAt);
    const escalation = await tx.amuxHumanEscalation.findUniqueOrThrow({ where: { id: escalationId } });
    assert.equal(escalation.resolutionOutcome, "block");
    assert.match(escalation.resolution ?? "", /stopped v22 Task; recreated as AMUX idea idea-synthetic-remake/);
    assert.ok(await tx.amuxV22AttemptUsageAcceptance.findUnique({ where: { attemptId: priorAttemptId } }));
    const audit = await tx.adminAuditLog.findFirstOrThrow({
      where: { action: "amux.legacy_card.closed", targetId: taskId } });
    assert.equal((audit.metadata as { kind: string }).kind, "stopped_task");
  });
});

test.after(async () => { await prisma.$disconnect(); });
