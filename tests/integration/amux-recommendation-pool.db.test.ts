import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { BoardImportError } from "@/lib/amux/boardImportCore";
import {
  commitRecommendationDecision,
  commitRecommendationSnapshot,
  prepareRecommendation,
} from "@/lib/amux/recommendationPoolService";
import { markRecommendationOutcomeUnknown } from "@/lib/amux/recommendationPoolService";
import { prisma } from "@/lib/prisma";

const actorUserId = `amux-recommendation-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "recommendation@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/board-recommendation");
const cardIds: string[] = [];
const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX recommendation DB tests require DATABASE_URL=TEST_DATABASE_URL");
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
    throw new Error("REFUSE: AMUX recommendation DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

const dbNow = async (tx: { $queryRaw: typeof prisma.$queryRaw }) => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  const parsed = now instanceof Date ? now : new Date(now ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new Error("database clock missing");
  return parsed;
};

const INCIDENT_KEY = "amux.incidentMode";
const normalIncident = JSON.stringify({
  version: 1,
  state: "normal",
  transition_id: null,
  changed_at: "2026-09-24T00:00:00.000Z",
  reason: "recommendation pool database test",
  ticket: "AMUX-H-TEST",
});
let previousIncident: string | null | undefined;
let previousCapacity: { active: boolean; wipLimit: number | null } | null | undefined;

const counts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
  todos: await prisma.amuxWorkItem.count({ where: { status: "todo", archivedAt: null } }),
});

const seedCard = async (label: string) => {
  const sourceDigest = `${label.charCodeAt(0).toString(16).padStart(2, "0")}`.repeat(32).slice(0, 64);
  const sourceKey = `R${label}${suffix}`.slice(0, 64);
  const now = new Date();
  const card = await prisma.amuxWorkItem.create({
    data: {
      title: `recommendation ${label}`,
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
    select: { id: true },
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
  return { id: card.id, sourceDigest };
};

after(async () => {
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: cardIds } },
      data: { archivedAt: new Date() },
    });
  }
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

test("recommendation decisions honour capacity, rollback, and a closed latch", async () => {
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
  const before = await counts();
  const first = await seedCard("A");
  const second = await seedCard("B");
  const third = await seedCard("C");
  const fourth = await seedCard("D");
  await prisma.amuxRecommendationCapacity.deleteMany({ where: { id: "queue" } });

  await assert.rejects(
    prepareRecommendation({
      session,
      request,
      raw: JSON.stringify({ canonicalizationVersion: "amux-json-v1", policyVersion: 7 }),
    }),
    (error: unknown) => error instanceof BoardImportError && error.code === "apply_disabled",
  );
  assert.equal(await prisma.amuxRecommendationSnapshot.count({ where: { actorUserId } }), 0);

  const unconfiguredId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    await commitRecommendationSnapshot(tx, { session, request, snapshotId: unconfiguredId, now });
  });
  const unconfigured = await prisma.amuxRecommendationSnapshotItem.findMany({
    where: { snapshotId: unconfiguredId, workItemId: { in: [first.id, second.id] } },
  });
  assert.equal(unconfigured.length, 2);
  assert.ok(unconfigured.every((row) => row.disposition === "excluded" && row.exclusionCode === "capacity_unconfigured"));
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: first.id } }))?.status, "backlog");

  const occupied = await prisma.amuxWorkItem.count({
    where: { archivedAt: null, status: { in: ["todo", "doing"] } },
  });
  await prisma.amuxRecommendationCapacity.create({
    data: { id: "queue", active: true, wipLimit: 10_000, updatedAt: new Date() },
  });
  const openId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    await commitRecommendationSnapshot(tx, { session, request, snapshotId: openId, now });
  });
  const included = await prisma.amuxRecommendationSnapshotItem.findMany({
    where: { snapshotId: openId, workItemId: { in: cardIds }, disposition: "included" },
  });
  assert.equal(included.length, 4);

  const approveBody = (card: { id: string; sourceDigest: string }, decisionId: string, snapshotId: string) => ({
    canonicalizationVersion: "amux-json-v1" as const,
    policyVersion: 7 as const,
    snapshotId,
    decisionId,
    decision: "approve" as const,
    item: {
      cardId: card.id,
      classification: { complexity: 3, files_expected: 2, risk: 1, task_kind: "bugfix" as const },
      executionBrief: "Keep the recommendation card on the backlog until this decision.",
      expectedRevision: 0,
      kind: "bug" as const,
      priority: "p3" as const,
      sourceDigest: card.sourceDigest,
    },
  });

  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const decision = approveBody(first, randomUUID(), openId);
      await commitRecommendationDecision(tx, {
        session,
        request,
        decision,
        requestDigest: `rollback-${decision.decisionId}`,
        now,
      });
      throw new Error("rollback");
    }),
    (error: unknown) => error instanceof Error && error.message === "rollback",
  );
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: first.id } }))?.status, "backlog");

  const consumedId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const decision = approveBody(first, consumedId, openId);
    const parsed = await commitRecommendationDecision(tx, {
      session,
      request,
      decision,
      requestDigest: `consumed-${consumedId}`,
      now,
    });
    assert.equal(parsed.status, "consumed");
  });
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: first.id } }))?.status, "todo");
  const audit = await prisma.amuxRecommendationDecision.findUnique({
    where: { id: consumedId },
    select: { authorizationAuditLogId: true },
  });
  const auditRow = await prisma.adminAuditLog.findUnique({
    where: { id: audit?.authorizationAuditLogId ?? "" },
    select: { action: true, metadata: true },
  });
  assert.equal(auditRow?.action, "amux.recommendation.consumed");
  const metadata = auditRow?.metadata;
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata));
  for (const key of Object.keys(metadata as Record<string, unknown>)) {
    assert.equal(["decisionId", "digest", "includedCount", "occupied", "snapshotId", "wipLimit"].includes(key), true);
    assert.equal(key === "sourceKey" || key === "title", false);
  }

  const full = await prisma.amuxWorkItem.count({
    where: { archivedAt: null, status: { in: ["todo", "doing"] } },
  });
  await prisma.amuxRecommendationCapacity.update({
    where: { id: "queue" },
    data: { wipLimit: full },
  });
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const decision = approveBody(second, randomUUID(), openId);
      await commitRecommendationDecision(tx, {
        session,
        request,
        decision,
        requestDigest: `full-${decision.decisionId}`,
        now,
      });
    }),
    (error: unknown) => error instanceof BoardImportError && error.code === "capacity_full",
  );
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: second.id } }))?.status, "backlog");

  const holdSnapshot = randomUUID();
  await prisma.amuxRecommendationCapacity.update({
    where: { id: "queue" },
    data: { wipLimit: 10_000 },
  });
  const raceSnapshot = randomUUID();
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    await commitRecommendationSnapshot(tx, { session, request, snapshotId: holdSnapshot, now });
  });
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    await commitRecommendationSnapshot(tx, { session, request, snapshotId: raceSnapshot, now });
  });
  const raceIncluded = await prisma.amuxRecommendationSnapshotItem.findMany({
    where: { snapshotId: raceSnapshot, workItemId: { in: [third.id, fourth.id] }, disposition: "included" },
  });
  assert.equal(raceIncluded.length, 2);
  const reviewAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000).toISOString();
  const holdId = randomUUID();
  await prisma.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const decision = {
      canonicalizationVersion: "amux-json-v1" as const,
      policyVersion: 7 as const,
      snapshotId: holdSnapshot,
      decisionId: holdId,
      decision: "hold" as const,
      cardId: second.id,
      reasonCode: "not_now" as const,
      reviewAfter,
    };
    const held = await commitRecommendationDecision(tx, {
      session,
      request,
      decision,
      requestDigest: `hold-${holdId}`,
      now,
    });
    assert.equal(held.status, "held");
  });
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: second.id } }))?.status, "backlog");

  const marked = await markRecommendationOutcomeUnknown({ session, request, snapshotId: holdSnapshot });
  assert.equal(marked.marked, true);
  assert.equal(
    (await prisma.amuxRecommendationSnapshot.findUnique({ where: { id: holdSnapshot } }))?.status,
    "outcome_unknown",
  );

  const occupiedBeforeRace = await prisma.amuxWorkItem.count({
    where: { archivedAt: null, status: { in: ["todo", "doing"] } },
  });
  await prisma.amuxRecommendationCapacity.update({
    where: { id: "queue" },
    data: { wipLimit: occupiedBeforeRace + 1 },
  });
  const race = await Promise.allSettled([
    prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const decision = approveBody(third, randomUUID(), raceSnapshot);
      return commitRecommendationDecision(tx, {
        session,
        request,
        decision,
        requestDigest: `race-${decision.decisionId}`,
        now,
      });
    }),
    prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const decision = approveBody(fourth, randomUUID(), raceSnapshot);
      return commitRecommendationDecision(tx, {
        session,
        request,
        decision,
        requestDigest: `race-${decision.decisionId}`,
        now,
      });
    }),
  ]);
  const succeeded = race.filter((result) => result.status === "fulfilled");
  assert.equal(succeeded.length, 1);
  const todoCards = await prisma.amuxWorkItem.count({
    where: { id: { in: [third.id, fourth.id] }, status: "todo" },
  });
  assert.equal(todoCards, 1);

  const afterCounts = await counts();
  assert.equal(afterCounts.attempts, before.attempts);
  assert.equal(afterCounts.deliveries, before.deliveries);
  assert.equal(afterCounts.routes, before.routes);
  assert.equal(afterCounts.todos, before.todos + 2);
  assert.equal(occupied >= 0, true);
});
