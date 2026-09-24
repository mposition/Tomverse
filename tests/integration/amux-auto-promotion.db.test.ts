import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { grantAutoPromotion, commitAutoGrant, commitAutoPromotion, commitAutoHaltFromReadback } from "@/lib/amux/autoPromotionService";
import { parseAutoConsumeRequest } from "@/lib/amux/autoPromotionCore";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { prisma } from "@/lib/prisma";

const actorUserId = `amux-auto-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "auto@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/board-auto-promotion");
const cardIds: string[] = [];
const snapshotIds: string[] = [];
const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX auto-promotion DB tests require DATABASE_URL=TEST_DATABASE_URL");
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
    throw new Error("REFUSE: AMUX auto-promotion DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

const INCIDENT_KEY = "amux.incidentMode";
const normalIncident = JSON.stringify({
  version: 1,
  state: "normal",
  transition_id: null,
  changed_at: "2026-09-25T00:00:00.000Z",
  reason: "auto promotion database test",
  ticket: "AMUX-I-TEST",
});
let previousIncident: string | null | undefined;
let previousCapacity: { active: boolean; wipLimit: number | null } | null | undefined;

const counts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
});

const seedCard = async (label: string) => {
  const sourceDigest = `${label.charCodeAt(0).toString(16).padStart(2, "0")}`.repeat(32).slice(0, 64);
  const sourceKey = `A${label}${suffix}`.slice(0, 64);
  const now = new Date();
  const card = await prisma.amuxWorkItem.create({
    data: {
      title: `auto ${label}`,
      status: "backlog",
      kind: "blocker",
      priority: "p0",
      pinned: true,
      drag: 8,
      createdAt: new Date("1970-01-02T00:00:00.000Z"),
      sourceSystem: "tomverse_private_workboard",
      sourceKey,
      sourceVersion: "a".repeat(40),
      sourceDigest,
      sourceSnapshot: {
        detailDigest: sourceDigest,
        sectionCode: "investment",
        sourceKey,
        manifestDigest: "d".repeat(64),
        policyVersion: 2,
      },
    },
    select: { id: true, revision: true },
  });
  const revisionId = `r0_${card.id}`;
  await prisma.$executeRaw`
    INSERT INTO "AmuxWorkItemSourceRevision" (
      "id", "workItemId", "parentRevisionId", "sourceVersion", "detailDigest",
      "sectionCode", "reconciliationRunId", "state", "observedAt", "decidedAt"
    ) VALUES (
      ${revisionId}, ${card.id}, ${null}, ${"a".repeat(40)}, ${sourceDigest},
      ${"investment"}, ${null}, ${"accepted"}, ${now}, ${now}
    )
  `;
  await prisma.$executeRaw`
    UPDATE "AmuxWorkItem"
    SET "acceptedSourceRevisionId" = ${revisionId}
    WHERE "id" = ${card.id}
  `;
  cardIds.push(card.id);
  return { id: card.id, sourceDigest, revision: card.revision };
};

after(async () => {
  await prisma.amuxRecommendationAutoCostEntry.deleteMany({
    where: { consumption: { workItemId: { in: cardIds } } },
  });
  await prisma.amuxRecommendationAutoConsumption.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationAutoGrant.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationDecision.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationSnapshotItem.deleteMany({ where: { workItemId: { in: cardIds } } });
  if (snapshotIds.length > 0) {
    await prisma.amuxRecommendationSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
  }
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: cardIds } }, data: { archivedAt: new Date() } });
  }
  await prisma.amuxRecommendationAutoHalt.deleteMany({ where: { actorUserId } });
  if (previousCapacity === null) {
    await prisma.amuxRecommendationCapacity.deleteMany({ where: { id: "queue" } });
  } else if (previousCapacity) {
    await prisma.amuxRecommendationCapacity.update({
      where: { id: "queue" },
      data: { active: previousCapacity.active, wipLimit: previousCapacity.wipLimit },
    });
  }
  if (previousIncident === null) {
    await prisma.appSetting.deleteMany({ where: { key: INCIDENT_KEY } });
  } else if (typeof previousIncident === "string") {
    await prisma.appSetting.update({ where: { key: INCIDENT_KEY }, data: { value: previousIncident } });
  }
  await prisma.$disconnect();
});

test("the closed auto latch writes nothing and a grant leaves the card in backlog", async () => {
  const storedIncident = await prisma.appSetting.findUnique({ where: { key: INCIDENT_KEY }, select: { value: true } });
  previousIncident = storedIncident?.value ?? null;
  await prisma.appSetting.upsert({
    where: { key: INCIDENT_KEY },
    create: { key: INCIDENT_KEY, value: normalIncident },
    update: { value: normalIncident },
  });
  const storedCapacity = await prisma.amuxRecommendationCapacity.findUnique({
    where: { id: "queue" },
    select: { active: true, wipLimit: true },
  });
  previousCapacity = storedCapacity ?? null;
  await prisma.amuxRecommendationCapacity.upsert({
    where: { id: "queue" },
    create: { id: "queue", active: true, wipLimit: 10000 },
    update: { active: true, wipLimit: 10000 },
  });
  const before = await counts();
  const grantsBefore = await prisma.amuxRecommendationAutoGrant.count();
  await assert.rejects(
    () => grantAutoPromotion({ session, request, raw: "{}" }),
    (error: unknown) => error instanceof BoardImportError && error.code === "apply_disabled",
  );
  assert.equal(await prisma.amuxRecommendationAutoGrant.count(), grantsBefore);

  const card = await seedCard("A");
  const grantId = randomUUID();
  await commitAutoGrant(session, request, { grantId, cardId: card.id }, "ab".repeat(32));
  const granted = await prisma.amuxWorkItem.findUnique({ where: { id: card.id }, select: { status: true } });
  assert.equal(granted?.status, "backlog");

  const consumeBody = {
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId,
    consumptionId: randomUUID(),
    snapshotId: randomUUID(),
    workerId: null,
    amountCents: 0,
    item: {
      cardId: card.id,
      classification: { complexity: 3, files_expected: 1, risk: 1, task_kind: "bugfix" },
      executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
      expectedRevision: card.revision,
      kind: "bug",
      priority: "p2",
      sourceDigest: card.sourceDigest,
    },
  };
  const early = parseAutoConsumeRequest(JSON.stringify(consumeBody));
  assert.equal(early.ok, true);
  if (!early.ok) return;
  await assert.rejects(
    () => commitAutoPromotion(session, request, early.request, early.requestDigest),
    (error: unknown) => error instanceof BoardImportError && error.code === "graduation_unmet",
  );
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: card.id }, select: { status: true } }))?.status, "backlog");

  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let promoteSnapshot = "";
  for (let index = 0; index < 20; index += 1) {
    const snapshotId = randomUUID();
    snapshotIds.push(snapshotId);
    promoteSnapshot = snapshotId;
    const createdAt = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    await prisma.amuxRecommendationSnapshot.create({
      data: {
        id: snapshotId,
        status: "prepared",
        actorUserId,
        authorizationAuditLogId: randomUUID(),
        scoringVersion: "amux-global-priority-v2",
        capacityConfigured: true,
        capacityLimit: 10000,
        capacityOccupied: 0,
        workerCapacity: "closed",
        classificationCapacity: "closed",
        itemBindingsDigest: "cd".repeat(32),
        rowCount: 1,
        includedCount: 1,
        policyVersion: 7,
        preparedAt: createdAt,
        expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000),
      },
    });
    await prisma.amuxRecommendationDecision.create({
      data: {
        id: randomUUID(),
        snapshotId,
        workItemId: card.id,
        decision: "approve",
        status: "consumed",
        actorUserId,
        authorizationAuditLogId: randomUUID(),
        requestDigest: "ef".repeat(32),
        createdAt,
      },
    });
  }
  await prisma.amuxRecommendationSnapshotItem.create({
    data: {
      snapshotId: promoteSnapshot,
      workItemId: card.id,
      ordinal: 0,
      expectedRevision: card.revision,
      sourceDigest: card.sourceDigest,
      executionBriefDigest: null,
      scoreTotal: 1,
      disposition: "included",
    },
  });
  const readyBody = { ...consumeBody, snapshotId: promoteSnapshot, consumptionId: randomUUID() };
  const ready = parseAutoConsumeRequest(JSON.stringify(readyBody));
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const consumed = await commitAutoPromotion(session, request, ready.request, ready.requestDigest);
  assert.equal(consumed.status, "consumed");
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: card.id }, select: { status: true } }))?.status, "todo");
  assert.equal(await prisma.amuxRecommendationAutoCostEntry.count({ where: { consumptionId: ready.request.consumptionId } }), 0);
  const after = await counts();
  assert.deepEqual(after, before);

  await prisma.amuxRecommendationAutoConsumption.update({
    where: { id: ready.request.consumptionId },
    data: { outcomeUnknownAt: new Date(Date.now() - 60_000) },
  });
  const oneUnknown = await commitAutoHaltFromReadback({
    session,
    request,
    haltId: randomUUID(),
  });
  assert.equal(oneUnknown.halted, false);

  const other = await seedCard("B");
  const otherGrant = randomUUID();
  await commitAutoGrant(session, request, { grantId: otherGrant, cardId: other.id }, "cd".repeat(32));
  await prisma.amuxRecommendationAutoConsumption.create({
    data: {
      id: randomUUID(),
      grantId: otherGrant,
      workItemId: other.id,
      snapshotId: promoteSnapshot,
      status: "outcome_unknown",
      actorUserId,
      authorizationAuditLogId: randomUUID(),
      requestDigest: "ab".repeat(32),
      outcomeUnknownAt: new Date(Date.now() - 120_000),
    },
  });
  const twoUnknown = await commitAutoHaltFromReadback({
    session,
    request,
    haltId: randomUUID(),
  });
  assert.equal(twoUnknown.halted, true);
  const halt = await prisma.amuxRecommendationAutoHalt.findFirst({
    where: { clearedAt: null, actorUserId },
    select: { reason: true, violationCode: true },
  });
  assert.equal(halt?.reason, "outcome_unknown_burst");
  assert.equal(halt?.violationCode, null);
  const second = parseAutoConsumeRequest(JSON.stringify({ ...readyBody, consumptionId: randomUUID() }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await assert.rejects(
    () => commitAutoPromotion(session, request, second.request, second.requestDigest),
    (error: unknown) => error instanceof BoardImportError && error.code === "auto_halted",
  );
});
