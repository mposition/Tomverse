import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Session } from "next-auth";

import {
  AUTO_SYSTEM_ACTOR,
  autoHumanActor,
  commitAutoGrant,
  commitAutoHaltFromReadback,
  commitAutoPromotion,
  commitAutoResume,
  grantAutoPromotion,
  recordAutoOutcomeUnknown,
  runAutoPromotionTick,
  tickAutoPromotion,
} from "@/lib/amux/autoPromotionService";
import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_SYSTEM_ACTOR_ROW_ID,
  autoGraduationAccepted,
  parseAutoConsumeRequest,
  parseAutoGrantRequest,
} from "@/lib/amux/autoPromotionCore";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { boardPromotionItemBindingsDigest, type BoardPromotionItem } from "@/lib/amux/boardPromotionCore";
import { prisma } from "@/lib/prisma";

// Orchestration policy versions 8, 9 and 15 (docs/policy/development-agent-orchestration.md).
// The public switch stays off here: the tests call the transaction bodies
// directly, which the policy allows and which does not stand in for the
// route's switch check.

const actorUserId = `amux-auto-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "auto@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/board-auto-promotion");
const cardIds: string[] = [];
const snapshotIds: string[] = [];
const grantIds: string[] = [];
const unknownIds: string[] = [];
const haltIds: string[] = [];
const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const DAY_MS = 24 * 60 * 60 * 1000;

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
let previousSwitch: string | undefined;

const counts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
});

const ledger = async () => ({
  consumptions: await prisma.amuxRecommendationAutoConsumption.count(),
  costEntries: await prisma.amuxRecommendationAutoCostEntry.count(),
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

const itemFor = (
  card: { id: string; sourceDigest: string; revision: number },
  overrides: Partial<BoardPromotionItem> = {},
): BoardPromotionItem => ({
  cardId: card.id,
  classification: { complexity: 3, files_expected: 1, risk: 1, task_kind: "bugfix" },
  executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
  expectedRevision: card.revision,
  kind: "bug",
  priority: "p2",
  sourceDigest: card.sourceDigest,
  ...overrides,
});

const grantFor = async (item: BoardPromotionItem, amountCents: number) => {
  const grantId = randomUUID();
  const parsed = parseAutoGrantRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 15,
    grantId,
    cardId: item.cardId,
    amountCents,
    item,
  }));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  if (!parsed.ok) throw new Error("grant request refused");
  grantIds.push(grantId);
  const granted = await commitAutoGrant(session, request, parsed.request, parsed.requestDigest);
  assert.equal(granted.status, "active");
  assert.equal(granted.replayed, false);
  return grantId;
};

/** A grant row written directly, as a legacy or already-due grant would be. */
const seedGrantRow = async (cardId: string, input: { grantedAt: Date; expiresAt: Date }) => {
  const id = randomUUID();
  grantIds.push(id);
  await prisma.amuxRecommendationAutoGrant.create({
    data: {
      id,
      workItemId: cardId,
      status: "active",
      actorUserId,
      authorizationAuditLogId: randomUUID(),
      requestDigest: "ab".repeat(32),
      grantedAt: input.grantedAt,
      expiresAt: input.expiresAt,
    },
  });
  return id;
};

const refusedWith = (code: string) => (error: unknown) => error instanceof BoardImportError && error.code === code;

const graduationNow = async () =>
  autoGraduationAccepted(
    await prisma.amuxRecommendationDecision.findMany({
      where: { decision: "approve", status: "consumed" },
      select: { createdAt: true },
    }),
  );

const systemMarker = (metadata: unknown) =>
  metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).systemActor
    : undefined;

// Shared across the ordered tests below.
let cardA: Awaited<ReturnType<typeof seedCard>>;
let itemA: BoardPromotionItem;
let grantA = "";
let tickConsumptionId = "";
let openHaltId = "";

before(async () => {
  previousSwitch = process.env[AUTO_PROMOTION_APPLY_ENV];
  delete process.env[AUTO_PROMOTION_APPLY_ENV];
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
});

after(async () => {
  const consumptionRows = await prisma.amuxRecommendationAutoConsumption.findMany({
    where: { workItemId: { in: cardIds } },
    select: { id: true, snapshotId: true },
  });
  const systemSnapshotIds = consumptionRows.map((row) => row.snapshotId).filter((id) => !snapshotIds.includes(id));
  await prisma.amuxRecommendationAutoUnknown.deleteMany({
    where: {
      OR: [
        { id: { in: [...unknownIds, ...consumptionRows.map((row) => row.id)] } },
        { grantId: { in: grantIds } },
      ],
    },
  });
  await prisma.amuxRecommendationAutoCostEntry.deleteMany({
    where: { consumption: { workItemId: { in: cardIds } } },
  });
  await prisma.amuxRecommendationAutoConsumption.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationAutoGrant.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationDecision.deleteMany({ where: { workItemId: { in: cardIds } } });
  await prisma.amuxRecommendationSnapshotItem.deleteMany({ where: { workItemId: { in: cardIds } } });
  const allSnapshots = [...snapshotIds, ...systemSnapshotIds];
  if (allSnapshots.length > 0) {
    await prisma.amuxRecommendationSnapshot.deleteMany({ where: { id: { in: allSnapshots } } });
  }
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: cardIds } }, data: { archivedAt: new Date() } });
  }
  await prisma.amuxRecommendationAutoHalt.deleteMany({
    where: { OR: [{ id: { in: haltIds } }, { actorUserId }] },
  });
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
  if (previousSwitch === undefined) delete process.env[AUTO_PROMOTION_APPLY_ENV];
  else process.env[AUTO_PROMOTION_APPLY_ENV] = previousSwitch;
  await prisma.$disconnect();
});

test("an unset switch refuses before a transaction, and a grant binds its item without moving the card", async () => {
  const grantsBefore = await prisma.amuxRecommendationAutoGrant.count();
  await assert.rejects(() => grantAutoPromotion({ session, request, raw: "{}" }), refusedWith("apply_disabled"));
  assert.deepEqual(await tickAutoPromotion(), { promoted: false, reason: "apply_disabled", expired: 0 });
  assert.equal(await prisma.amuxRecommendationAutoGrant.count(), grantsBefore);

  cardA = await seedCard("A");
  itemA = itemFor(cardA);
  grantA = await grantFor(itemA, 125);
  const row = await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: grantA } });
  assert.equal(row?.status, "active");
  assert.equal(row?.amountCents, 125);
  assert.equal(row?.itemBindingsDigest, boardPromotionItemBindingsDigest([itemA]));
  assert.deepEqual(row?.itemBindings, [itemA]);
  assert.equal(row && row.expiresAt.getTime() - row.grantedAt.getTime(), 7 * DAY_MS);
  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.auto_grant.prepared", targetId: grantA },
    select: { actorUserId: true, metadata: true },
  });
  assert.equal(audit?.actorUserId, actorUserId);
  assert.equal((audit?.metadata as Record<string, unknown>).amountCents, 125);
  const card = await prisma.amuxWorkItem.findUnique({ where: { id: cardA.id }, select: { status: true, revision: true } });
  assert.deepEqual(card, { status: "backlog", revision: cardA.revision });

  // A grant for a stale revision is refused rather than stored.
  const stale = parseAutoGrantRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 15,
    grantId: randomUUID(),
    cardId: cardA.id,
    amountCents: 125,
    item: { ...itemA, expectedRevision: cardA.revision + 1 },
  }));
  assert.equal(stale.ok, true);
  if (stale.ok) {
    await assert.rejects(
      () => commitAutoGrant(session, request, stale.request, stale.requestDigest),
      refusedWith("conflict"),
    );
  }
});

test("a due grant is expired on a consume attempt and by the tick, and the tick refuses below graduation", async () => {
  assert.equal((await graduationNow()).ok, false, "precondition: fewer than 20 decisions spanning 14 days");
  const before = await ledger();

  // The owner's consume attempt expires a due grant, commits that, and refuses.
  const cardE = await seedCard("E");
  const dueForOwner = await seedGrantRow(cardE.id, {
    grantedAt: new Date(Date.now() - 8 * DAY_MS),
    expiresAt: new Date(Date.now() - DAY_MS),
  });
  const ownerAttempt = parseAutoConsumeRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 15,
    grantId: dueForOwner,
    consumptionId: randomUUID(),
    snapshotId: randomUUID(),
    workerId: null,
  }));
  assert.equal(ownerAttempt.ok, true);
  if (!ownerAttempt.ok) return;
  await assert.rejects(
    () => commitAutoPromotion(session, request, ownerAttempt.request, ownerAttempt.requestDigest),
    refusedWith("grant_missing"),
  );
  assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: dueForOwner } }))?.status, "expired");
  const ownerExpiry = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.auto_grant.expired", targetId: dueForOwner },
    select: { actorUserId: true },
  });
  assert.equal(ownerExpiry?.actorUserId, actorUserId);

  // The tick expires a due grant as the system actor.
  const cardC = await seedCard("C");
  const dueForTick = await seedGrantRow(cardC.id, {
    grantedAt: new Date(Date.now() - 8 * DAY_MS),
    expiresAt: new Date(Date.now() - DAY_MS),
  });
  const result = await runAutoPromotionTick();
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "graduation_unmet");
  assert.ok(result.expired >= 1);
  assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: dueForTick } }))?.status, "expired");
  const tickExpiry = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.auto_grant.expired", targetId: dueForTick },
    select: { actorUserId: true, metadata: true },
  });
  assert.equal(tickExpiry?.actorUserId, null);
  assert.equal(systemMarker(tickExpiry?.metadata), "amux-auto-promoter");

  // The bound grant is untouched and nothing was consumed or charged.
  assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: grantA } }))?.status, "active");
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: cardA.id }, select: { status: true } }))?.status, "backlog");
  assert.deepEqual(await ledger(), before);
});

test("the owner consume uses the bound item and amount and writes exactly one cost entry", async () => {
  const lifecycleBefore = await counts();
  const cardH = await seedCard("H");
  const itemH = itemFor(cardH);
  const grantH = await grantFor(itemH, 200);
  const v8 = (overrides: Record<string, unknown> = {}) => ({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId: grantH,
    consumptionId: randomUUID(),
    snapshotId: randomUUID(),
    workerId: null,
    amountCents: 200,
    item: itemH,
    ...overrides,
  });
  const early = parseAutoConsumeRequest(JSON.stringify(v8()));
  assert.equal(early.ok, true);
  if (!early.ok) return;
  await assert.rejects(
    () => commitAutoPromotion(session, request, early.request, early.requestDigest),
    refusedWith("graduation_unmet"),
  );
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: cardH.id }, select: { status: true } }))?.status, "backlog");

  // Twenty consumed human decisions spanning fourteen days.
  const start = new Date(Date.now() - 14 * DAY_MS);
  let promoteSnapshot = "";
  for (let index = 0; index < 20; index += 1) {
    const snapshotId = randomUUID();
    snapshotIds.push(snapshotId);
    promoteSnapshot = snapshotId;
    const createdAt = new Date(start.getTime() + Math.min(index, 14) * DAY_MS);
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
        workItemId: cardH.id,
        decision: "approve",
        status: "consumed",
        actorUserId,
        authorizationAuditLogId: randomUUID(),
        requestDigest: "ef".repeat(32),
        createdAt,
      },
    });
  }
  assert.equal((await graduationNow()).ok, true);
  await prisma.amuxRecommendationSnapshotItem.create({
    data: {
      snapshotId: promoteSnapshot,
      workItemId: cardH.id,
      ordinal: 0,
      expectedRevision: cardH.revision,
      sourceDigest: cardH.sourceDigest,
      executionBriefDigest: null,
      scoreTotal: 1,
      disposition: "included",
    },
  });

  // A version 8 request has to repeat the bound amount and the bound item.
  for (const [overrides, code] of [
    [{ amountCents: 199 }, "grant_amount_mismatch"],
    [{ item: { ...itemH, priority: "p0" } }, "grant_item_mismatch"],
  ] as const) {
    const parsed = parseAutoConsumeRequest(JSON.stringify(v8({ ...overrides, snapshotId: promoteSnapshot })));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    await assert.rejects(
      () => commitAutoPromotion(session, request, parsed.request, parsed.requestDigest),
      refusedWith(code),
    );
  }

  const ledgerBefore = await ledger();
  const bound = parseAutoConsumeRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 15,
    grantId: grantH,
    consumptionId: randomUUID(),
    snapshotId: promoteSnapshot,
    workerId: null,
  }));
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  const consumed = await commitAutoPromotion(session, request, bound.request, bound.requestDigest);
  assert.equal(consumed.status, "consumed");
  assert.equal(consumed.replayed, false);
  const card = await prisma.amuxWorkItem.findUnique({
    where: { id: cardH.id },
    select: { status: true, owner: true, revision: true },
  });
  assert.deepEqual(card, { status: "todo", owner: null, revision: cardH.revision + 1 });
  assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: grantH } }))?.status, "consumed");
  const consumption = await prisma.amuxRecommendationAutoConsumption.findUnique({
    where: { id: bound.request.consumptionId },
    select: { actorUserId: true, grantId: true, snapshotId: true },
  });
  assert.deepEqual(consumption, { actorUserId, grantId: grantH, snapshotId: promoteSnapshot });
  const costs = await prisma.amuxRecommendationAutoCostEntry.findMany({
    where: { consumptionId: bound.request.consumptionId },
    select: { amountCents: true, recordedAt: true },
  });
  assert.equal(costs.length, 1);
  assert.equal(costs[0].amountCents, 200);
  assert.ok(costs[0].recordedAt instanceof Date);
  const ledgerAfter = await ledger();
  assert.deepEqual(ledgerAfter, {
    consumptions: ledgerBefore.consumptions + 1,
    costEntries: ledgerBefore.costEntries + 1,
  });
  assert.deepEqual(await counts(), lifecycleBefore);

  // The same consumption id is a read-back, not a second consume.
  const replay = await commitAutoPromotion(session, request, bound.request, bound.requestDigest);
  assert.equal(replay.replayed, true);
  assert.deepEqual(await ledger(), ledgerAfter);
});

test("with graduation met the tick promotes exactly one card from its bound grant", async () => {
  const lifecycleBefore = await counts();
  const ledgerBefore = await ledger();
  const result = await runAutoPromotionTick();
  assert.equal(result.promoted, true, result.reason);
  assert.equal(typeof result.consumption_id, "string");
  tickConsumptionId = result.consumption_id ?? "";

  const consumption = await prisma.amuxRecommendationAutoConsumption.findUnique({
    where: { id: tickConsumptionId },
    select: {
      grantId: true,
      workItemId: true,
      snapshotId: true,
      status: true,
      actorUserId: true,
      authorizationAuditLogId: true,
    },
  });
  assert.equal(consumption?.grantId, grantA);
  assert.equal(consumption?.workItemId, cardA.id);
  assert.equal(consumption?.status, "consumed");
  assert.equal(consumption?.actorUserId, AUTO_SYSTEM_ACTOR_ROW_ID);

  const costs = await prisma.amuxRecommendationAutoCostEntry.findMany({
    where: { consumptionId: tickConsumptionId },
    select: { amountCents: true },
  });
  assert.deepEqual(costs, [{ amountCents: 125 }]);
  assert.deepEqual(await ledger(), {
    consumptions: ledgerBefore.consumptions + 1,
    costEntries: ledgerBefore.costEntries + 1,
  });
  assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: grantA } }))?.status, "consumed");

  const card = await prisma.amuxWorkItem.findUnique({
    where: { id: cardA.id },
    select: { status: true, owner: true, claimedAt: true, revision: true, priority: true, kind: true },
  });
  assert.deepEqual(card, {
    status: "todo",
    owner: null,
    claimedAt: null,
    revision: cardA.revision + 1,
    priority: itemA.priority,
    kind: itemA.kind,
  });
  assert.deepEqual(await counts(), lifecycleBefore);

  // The system snapshot is real, one row, and bound to the same audit entry.
  const snapshot = await prisma.amuxRecommendationSnapshot.findUnique({
    where: { id: consumption?.snapshotId ?? "" },
    select: { actorUserId: true, rowCount: true, includedCount: true, policyVersion: true, authorizationAuditLogId: true },
  });
  assert.deepEqual(snapshot, {
    actorUserId: AUTO_SYSTEM_ACTOR_ROW_ID,
    rowCount: 1,
    includedCount: 1,
    policyVersion: 15,
    authorizationAuditLogId: consumption?.authorizationAuditLogId,
  });
  const snapshotItems = await prisma.amuxRecommendationSnapshotItem.findMany({
    where: { snapshotId: consumption?.snapshotId ?? "" },
    select: { workItemId: true, disposition: true, expectedRevision: true },
  });
  assert.deepEqual(snapshotItems, [{ workItemId: cardA.id, disposition: "included", expectedRevision: cardA.revision }]);

  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.auto_promotion.consumed", targetId: tickConsumptionId },
    select: { actorUserId: true, metadata: true, entryHash: true },
  });
  assert.equal(audit?.actorUserId, null);
  assert.equal(systemMarker(audit?.metadata), "amux-auto-promoter");
  assert.equal((audit?.metadata as Record<string, unknown>).amountCents, 125);
  assert.match(audit?.entryHash ?? "", /^[a-f0-9]{64}$/);
});

test("a second tick with no bound grant promotes nothing, and a legacy grant is never consumed", async () => {
  const cardD = await seedCard("D");
  await seedGrantRow(cardD.id, {
    grantedAt: new Date(Date.now() - DAY_MS),
    expiresAt: new Date(Date.now() + 6 * DAY_MS),
  });
  const ledgerBefore = await ledger();
  const result = await runAutoPromotionTick();
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "no_grant");
  assert.equal(result.consumption_id, undefined);
  assert.deepEqual(await ledger(), ledgerBefore);
  assert.equal((await prisma.amuxWorkItem.findUnique({ where: { id: cardD.id }, select: { status: true } }))?.status, "backlog");
});

test("a grant refused for its own card does not hold the next grant, and later execution is not a lifecycle write", async () => {
  // E is granted first, then its card moves, so its bound revision no longer
  // matches: a refusal that belongs to E alone.
  const cardE = await seedCard("J");
  const grantE = await grantFor(itemFor(cardE), 50);
  await prisma.amuxWorkItem.update({ where: { id: cardE.id }, data: { revision: { increment: 1 } } });
  const cardF = await seedCard("K");
  const grantF = await grantFor(itemFor(cardF), 60);
  let attemptId: string | null = null;
  try {
    const result = await runAutoPromotionTick();
    assert.equal(result.promoted, true, result.reason);
    const consumption = await prisma.amuxRecommendationAutoConsumption.findUnique({
      where: { id: result.consumption_id ?? "" },
      select: { grantId: true, workItemId: true },
    });
    assert.equal(consumption?.grantId, grantF);
    assert.equal(consumption?.workItemId, cardF.id);
    assert.equal((await prisma.amuxRecommendationAutoGrant.findUnique({ where: { id: grantE } }))?.status, "active");

    // A later claim and execution start on the promoted card (policy version
    // 15) writes an attempt after the consume; it is not a violation.
    attemptId = randomUUID();
    const later = new Date();
    await prisma.amuxExecutionAttempt.create({
      data: {
        id: attemptId,
        taskId: cardF.id,
        worker: "auto-lifecycle-worker",
        workerInstanceId: randomUUID(),
        workerGeneration: 1,
        taskRevision: cardF.revision + 1,
        attemptNumber: 1,
        heartbeatAt: later,
        leaseExpiresAt: null,
        startedAt: later,
        endedAt: later,
        outcome: "failed",
        toStatus: "todo",
        endedBy: "auto-lifecycle-worker",
        reason: "execution_failed",
      },
    });
    const readback = await commitAutoHaltFromReadback({ actor: AUTO_SYSTEM_ACTOR, haltId: randomUUID() });
    assert.equal(readback.halted, false);
  } finally {
    if (attemptId) await prisma.amuxExecutionAttempt.deleteMany({ where: { id: attemptId } });
    // Leave no active grant behind for the ticks that follow.
    await prisma.amuxRecommendationAutoGrant.updateMany({
      where: { id: grantE, status: "active" },
      data: { status: "expired" },
    });
  }
});

test("two lost outcomes within 15 minutes open a halt, and a halted tick refuses", async () => {
  // First: the consume had committed, so the read-back finds the row.
  const first = await recordAutoOutcomeUnknown({
    actor: AUTO_SYSTEM_ACTOR,
    consumptionId: tickConsumptionId,
    grantId: grantA,
    haltId: randomUUID(),
  });
  assert.equal(first.recorded, true);
  assert.equal(first.consumptionFound, true);
  assert.equal(first.halted, false);
  const flagged = await prisma.amuxRecommendationAutoConsumption.findUnique({
    where: { id: tickConsumptionId },
    select: { status: true, outcomeUnknownAt: true },
  });
  assert.equal(flagged?.status, "consumed");
  assert.ok(flagged?.outcomeUnknownAt instanceof Date);
  const firstRow = await prisma.amuxRecommendationAutoUnknown.findUnique({ where: { id: tickConsumptionId } });
  assert.equal(firstRow?.grantId, grantA);
  assert.equal(firstRow?.consumptionFound, true);

  // Second: nothing committed and no grant had been chosen yet.
  const lostId = randomUUID();
  unknownIds.push(lostId);
  openHaltId = randomUUID();
  haltIds.push(openHaltId);
  const second = await recordAutoOutcomeUnknown({
    actor: AUTO_SYSTEM_ACTOR,
    consumptionId: lostId,
    grantId: null,
    haltId: openHaltId,
  });
  assert.equal(second.recorded, true);
  assert.equal(second.consumptionFound, false);
  assert.equal(second.halted, true);
  assert.equal(second.haltId, openHaltId);
  const halt = await prisma.amuxRecommendationAutoHalt.findUnique({
    where: { id: openHaltId },
    select: { reason: true, violationCode: true, actorUserId: true, clearedAt: true },
  });
  assert.deepEqual(halt, {
    reason: "outcome_unknown_burst",
    violationCode: null,
    actorUserId: AUTO_SYSTEM_ACTOR_ROW_ID,
    clearedAt: null,
  });

  // The same lost outcome again is one event, not a third.
  const again = await recordAutoOutcomeUnknown({ actor: AUTO_SYSTEM_ACTOR, consumptionId: lostId, grantId: null });
  assert.equal(again.recorded, false);
  assert.equal(await prisma.amuxRecommendationAutoUnknown.count({ where: { id: lostId } }), 1);
  const replay = await commitAutoHaltFromReadback({ actor: autoHumanActor(session, request), haltId: randomUUID() });
  assert.deepEqual(replay, { haltId: openHaltId, halted: true, replayed: true });

  const halted = await runAutoPromotionTick();
  assert.equal(halted.promoted, false);
  assert.equal(halted.reason, "auto_halted");
});

test("the owner resumes the halt, and the next tick is no longer halted", async () => {
  await assert.rejects(() => commitAutoResume(session, request, randomUUID()), refusedWith("not_found"));
  const resumed = await commitAutoResume(session, request, openHaltId);
  assert.deepEqual(resumed, { haltId: openHaltId, cleared: true, replayed: false });
  const halt = await prisma.amuxRecommendationAutoHalt.findUnique({
    where: { id: openHaltId },
    select: { clearedAt: true },
  });
  assert.ok(halt?.clearedAt instanceof Date);
  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.auto_promotion.resumed", targetId: openHaltId },
    select: { actorUserId: true },
  });
  assert.equal(audit?.actorUserId, actorUserId);
  assert.deepEqual(await commitAutoResume(session, request, openHaltId), {
    haltId: openHaltId,
    cleared: true,
    replayed: true,
  });
  const next = await runAutoPromotionTick();
  assert.equal(next.promoted, false);
  assert.equal(next.reason, "no_grant");
});
