import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import {
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SCANNER_VERSION,
  BoardImportError,
} from "@/lib/amux/boardImportCore";
import { applyAmuxReconciliation, commitAmuxReconciliation } from "@/lib/amux/boardReconciliation";
import { planAmuxReconciliation } from "@/lib/amux/boardReconciliationCore";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for one accept and one reject.
// The public route cannot call this commit while the code latch is false.
// No local DATABASE_URL means this file was not executed, not that it passed.

const actorUserId = `amux-reconciliation-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "reconciliation@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/reconciliation");
const cardIds: string[] = [];
const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const acceptKey = `RA${suffix}`;
const rejectKey = `RR${suffix}`;

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX reconciliation DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const schemaName = url.searchParams.get("schema");
  const dedicatedSchema = schemaName === "tomverse_amux_test";
  const canonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!dedicatedSchema && !canonicalCiDatabase) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: AMUX reconciliation DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

after(async () => {
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: cardIds } },
      data: { archivedAt: new Date() },
    });
  }
  await prisma.$disconnect();
});

const hex = (char: string) => char.repeat(64);
const version = (char: string) => char.repeat(40);

const untouchedCounts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
  costs: await prisma.amuxCostLedgerEntry.count(),
  creditLots: await prisma.creditLot.count(),
  creditLedger: await prisma.creditLedgerEntry.count(),
  todos: await prisma.amuxWorkItem.count({ where: { status: "todo" } }),
});

const seedCard = async (sourceKey: string, detailChar: string) => {
  const detailDigest = hex(detailChar);
  const sourceVersion = version("a");
  const now = new Date();
  const card = await prisma.amuxWorkItem.create({
    data: {
      title: `card ${sourceKey}`,
      status: "backlog",
      kind: "unknown",
      priority: "p3",
      sourceSystem: "tomverse_private_workboard",
      sourceKey,
      sourceVersion,
      sourceDigest: detailDigest,
      sourceSnapshot: {
        detailDigest,
        sectionCode: "investment",
        sourceKey,
        manifestDigest: hex("d"),
        policyVersion: 2,
      },
    },
    select: { id: true },
  });
  const revisionId = `r0_${card.id}`;
  await prisma.$executeRaw`
    INSERT INTO "AmuxWorkItemSourceRevision" (
      "id", "workItemId", "parentRevisionId", "sourceVersion", "detailDigest",
      "sectionCode", "reconciliationRunId", "state", "observedAt", "decidedAt"
    ) VALUES (
      ${revisionId}, ${card.id}, ${null}, ${sourceVersion}, ${detailDigest},
      ${"investment"}, ${null}, ${"accepted"}, ${now}, ${now}
    )
  `;
  await prisma.$executeRaw`
    UPDATE "AmuxWorkItem"
    SET "acceptedSourceRevisionId" = ${revisionId}
    WHERE "id" = ${card.id}
  `;
  cardIds.push(card.id);
  return { id: card.id, revisionId, detailDigest, sourceVersion };
};

const bodyFor = (acceptDigest: string, rejectDigest: string) =>
  JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    sourceCommit: version("c"),
    manifestDigest: hex("d"),
    scannerRulesetDigest: BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
    plannerVersion: "amux-board-planner-v2",
    validatorVersion: "amux-board-validator-v1",
    sectionCount: 4,
    stored: {
      boardDigest: hex("1"),
      items: [
        {
          sourceKey: acceptKey,
          sectionCode: "investment",
          detailDigest: acceptDigest,
          sourceVersion: version("a"),
        },
        {
          sourceKey: rejectKey,
          sectionCode: "investment",
          detailDigest: rejectDigest,
          sourceVersion: version("a"),
        },
      ],
    },
    observed: {
      boardDigest: hex("2"),
      items: [
        {
          sourceKey: acceptKey,
          sectionCode: "investment",
          detailDigest: hex("f"),
          sourceVersion: version("b"),
        },
        {
          sourceKey: rejectKey,
          sectionCode: "investment",
          detailDigest: hex("e"),
          sourceVersion: version("b"),
        },
      ],
    },
    decisions: [
      { sourceKey: acceptKey, decision: "accept_new_source_revision" },
      { sourceKey: rejectKey, decision: "reject" },
    ],
  });

test("accept moves only the pointer and reject keeps the stored revision", async () => {
  const accept = await seedCard(acceptKey, "a");
  const reject = await seedCard(rejectKey, "b");
  const planned = planAmuxReconciliation(bodyFor(accept.detailDigest, reject.detailDigest));
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const runsBefore = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM "AmuxReconciliationRun"
  `;
  await assert.rejects(
    () => applyAmuxReconciliation({ session, request, plan: planned }),
    (error: unknown) => error instanceof BoardImportError && error.code === "apply_disabled",
  );
  const runsAfterRefusal = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM "AmuxReconciliationRun"
  `;
  assert.equal(Number(runsAfterRefusal[0]?.count), Number(runsBefore[0]?.count));
  const before = await untouchedCounts();
  const result = await prisma.$transaction((tx) =>
    commitAmuxReconciliation(tx, {
      session,
      request,
      plan: planned,
      runId: randomUUID(),
    }),
  );
  assert.equal(result.outcome, "consumed");
  assert.equal(result.acceptCount, 1);
  assert.equal(result.rejectCount, 1);
  const after = await untouchedCounts();
  assert.deepEqual(after, before);

  const cards = await prisma.$queryRaw<
    Array<{
      id: string;
      status: string;
      kind: string;
      priority: string;
      owner: string | null;
      claimedAt: Date | null;
      sourceDigest: string | null;
      sourceVersion: string | null;
      acceptedSourceRevisionId: string | null;
    }>
  >`
    SELECT "id", "status", "kind", "priority", "owner", "claimedAt",
           "sourceDigest", "sourceVersion", "acceptedSourceRevisionId"
    FROM "AmuxWorkItem"
    WHERE "id" IN (${accept.id}, ${reject.id})
  `;
  const acceptCard = cards.find((row) => row.id === accept.id);
  const rejectCard = cards.find((row) => row.id === reject.id);
  assert.equal(acceptCard?.status, "backlog");
  assert.equal(acceptCard?.kind, "unknown");
  assert.equal(acceptCard?.priority, "p3");
  assert.equal(acceptCard?.owner, null);
  assert.equal(acceptCard?.claimedAt, null);
  assert.equal(acceptCard?.sourceDigest, accept.detailDigest);
  assert.equal(acceptCard?.sourceVersion, accept.sourceVersion);
  assert.notEqual(acceptCard?.acceptedSourceRevisionId, accept.revisionId);
  assert.equal(rejectCard?.acceptedSourceRevisionId, reject.revisionId);
  assert.equal(rejectCard?.sourceDigest, reject.detailDigest);
  assert.equal(rejectCard?.status, "backlog");
  assert.equal(rejectCard?.owner, null);

  const revisions = await prisma.$queryRaw<
    Array<{ id: string; workItemId: string; parentRevisionId: string | null; state: string; detailDigest: string }>
  >`
    SELECT "id", "workItemId", "parentRevisionId", "state", "detailDigest"
    FROM "AmuxWorkItemSourceRevision"
    WHERE "reconciliationRunId" = ${result.runId}
    ORDER BY "state"
  `;
  assert.equal(revisions.length, 2);
  const accepted = revisions.find((row) => row.state === "accepted");
  const rejected = revisions.find((row) => row.state === "rejected");
  assert.equal(accepted?.workItemId, accept.id);
  assert.equal(accepted?.parentRevisionId, accept.revisionId);
  assert.equal(accepted?.detailDigest, hex("f"));
  assert.equal(acceptCard?.acceptedSourceRevisionId, accepted?.id);
  assert.equal(rejected?.workItemId, reject.id);
  assert.equal(rejected?.parentRevisionId, reject.revisionId);
  assert.equal(rejected?.detailDigest, hex("e"));

  const run = await prisma.$queryRaw<Array<{ status: string; approvalAuditLogId: string | null }>>`
    SELECT "status", "approvalAuditLogId" FROM "AmuxReconciliationRun" WHERE "id" = ${result.runId}
  `;
  assert.equal(run[0]?.status, "consumed");
  assert.equal(run[0]?.approvalAuditLogId, result.auditId);
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: result.auditId } });
  const metadata = JSON.stringify(audit?.metadata ?? {});
  assert.equal(metadata.includes(acceptKey), false);
  assert.equal(metadata.includes(rejectKey), false);
  assert.equal(metadata.includes("title"), false);
});
