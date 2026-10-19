import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { BoardImportError } from "../../lib/amux/boardImportCore.ts";
import { AMUX_V22_GRADUATION_EXCEPTION_ENV,
  AMUX_V22_GRADUATION_EXCEPTION_ID } from
  "../../lib/amux/v22AutoPromotionCore.ts";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-12T00:00:00Z");
type Card = { id: string; sourceSystem: string; cardType: string;
  status: string; archivedAt: Date | null; owner: string | null;
  claimedAt: Date | null; v22ReceiptId: string | null; revision: number };
const taskA = "task-a-1234";
const taskB = "task-b-1234";
const scoreA = "11111111-1111-4111-8111-111111111111";
const scoreB = "22222222-2222-4222-8222-222222222222";
const requestA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cards = new Map<string, Card>();
const receipts = new Map<string, Record<string, unknown>>();
const unknowns = new Map<string, Record<string, unknown>>();
const audits = new Map<string, Record<string, unknown>>();
const world = { candidates: [] as Array<{ id: string; taskId: string;
  scoreTotal: number }>, controlActive: true, humanAudits: 0,
  systemAudits: 0, updates: [] as string[], loseAfterCommit: false,
  loseBeforeCommit: false, costExceeded: false, lifecycleWrite: false,
  halts: [] as Array<Record<string, unknown>> };

const reset = () => {
  cards.clear(); receipts.clear(); unknowns.clear(); audits.clear();
  for (const id of [taskA, taskB]) cards.set(id, { id,
    sourceSystem: "admin-idea-v4", cardType: "task", status: "backlog",
    archivedAt: null, owner: null, claimedAt: null, v22ReceiptId: null,
    revision: 4 });
  world.candidates = [
    { id: scoreA, taskId: taskA, scoreTotal: 90 },
    { id: scoreB, taskId: taskB, scoreTotal: 80 },
  ];
  world.controlActive = true; world.humanAudits = 0;
  world.systemAudits = 0; world.updates = [];
  world.loseAfterCommit = false; world.loseBeforeCommit = false;
  world.costExceeded = false; world.lifecycleWrite = false; world.halts = [];
  audits.set("activation-audit", { action: "amux.v22.auto_promotion.activated",
    actorUserId: "owner-1", targetType: "AmuxV22PromotionControl",
    targetId: "queue", entryHash: "activation-hash", metadata: {
      graduationExceptionId: AMUX_V22_GRADUATION_EXCEPTION_ID,
      graduationExceptionPolicyVersion: 30,
    } });
  audits.set("score-audit", { action: "amux.v4.portfolio.score.confirm",
    targetId: scoreA, entryHash: "score-hash" });
  audits.set("score-b-audit", { action: "amux.v4.portfolio.score.confirm",
    targetId: scoreB, entryHash: "score-b-hash" });
};
reset();

const scoreFor = (taskId: string) => ({
  id: taskId === taskA ? scoreA : scoreB,
  taskId, taskRevision: 4, sourceApprovalId: `source-${taskId}`,
  scoreVersion: "amux-v4-portfolio-v1", scoreTotal: taskId === taskA ? 90 : 80,
  activeStaleAt: new Date(now.getTime() + 60_000),
  baselineStaleAt: new Date(now.getTime() + 60_000),
  approvalAuditLogId: taskId === taskA ? "score-audit" : "score-b-audit",
  initiativeAssessmentId: "assessment-initiative",
  epicAssessmentId: "assessment-epic",
  featureAssessmentId: "assessment-feature",
  storyAssessmentId: null,
  taskAssessmentId: `assessment-${taskId}`,
  initiativeAssessment: { nodeId: "initiative" },
  epicAssessment: { nodeId: "epic" },
  featureAssessment: { nodeId: "feature" },
  storyAssessment: null,
  taskAssessment: { cardId: taskId },
});

const dbDelegates = {
  amuxV22PromotionReceipt: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const receipt = receipts.get(where.id);
      if (!receipt) return null;
      const card = cards.get(receipt.workItemId as string)!;
      return { ...receipt, workItem: { v22ReceiptId: card.v22ReceiptId } };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      receipts.set(data.id as string, data); return data;
    },
  },
  amuxV22PromotionUnknown: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      unknowns.get(where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      unknowns.set(data.id as string, data); return data;
    },
    count: async () => unknowns.size,
  },
  amuxV22PromotionControl: { findUnique: async () => ({ id: "queue",
    active: world.controlActive, activatedAt: new Date(now.getTime() - 1_000),
    approvedByUserId: "owner-1", authorizationAuditLogId: "activation-audit" }) },
  adminAuditLog: { findUnique: async ({ where }: { where: { id: string } }) =>
    audits.get(where.id) ?? null },
  amuxRecommendationAutoHalt: {
    findFirst: async () => world.halts.length ?
      { id: world.halts.at(-1)?.id as string } : null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      world.halts.push(data); return data;
    },
  },
  amuxRecommendationDecision: { findMany: async () => [] },
  amuxRecommendationAutoCostEntry: { findMany: async () =>
    world.costExceeded ? [{ amountCents: 1_501, recordedAt: now }] : [] },
  amuxRecommendationAutoUnknown: { findMany: async () => [] },
  amuxRecommendationAutoConsumption: { findMany: async () => [] },
  appSetting: { findUnique: async () => ({ value: JSON.stringify({
    version: 1, state: "normal", transition_id: null,
    changed_at: now.toISOString(), reason: "synthetic normal", ticket: "S0",
  }) }) },
  amuxRecommendationCapacity: { findUnique: async () => ({
    id: "queue", active: true, wipLimit: 9 }) },
  amuxWorkerRuntime: { count: async () => 3 },
  amuxExecutionAttempt: { count: async () => world.lifecycleWrite ? 1 : 0 },
  amuxWorkDelivery: { count: async () => 0 },
  amuxRouteDecision: { count: async () => 0 },
  amuxPortfolioScoreSnapshot: { findUnique: async ({ where }:
    { where: { id: string } }) => scoreFor(where.id === scoreA ? taskA : taskB) },
  amuxPortfolioAssessment: { findFirst: async ({ where }:
    { where: { nodeId?: string; cardId?: string } }) => ({ id:
      where.nodeId ? `assessment-${where.nodeId}` : `assessment-${where.cardId}` }) },
  amuxWorkItem: {
    count: async () => [...cards.values()].filter((card) =>
      card.status === "todo" || card.status === "doing").length,
    findUnique: async ({ where }: { where: { id: string } }) =>
      cards.get(where.id) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>;
      data: Record<string, unknown> }) => {
      const card = cards.get(where.id as string);
      if (!card || card.status !== where.status || card.revision !== where.revision ||
          card.v22ReceiptId !== where.v22ReceiptId) return { count: 0 };
      card.status = data.status as string;
      card.v22ReceiptId = data.v22ReceiptId as string;
      card.revision += 1; world.updates.push(card.id);
      return { count: 1 };
    },
  },
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("");
    if (sql.includes("clock_timestamp")) return [{ now }];
    if (sql.includes("WITH newest")) return world.candidates.filter((candidate) =>
      cards.get(candidate.taskId)?.status === "backlog" &&
      ![...unknowns.values()].some((row) =>
        row.workItemId === candidate.taskId));
    if (sql.includes('FROM "AmuxWorkItem"')) return [{ id: taskA }];
    return [];
  },
};

type MockDb = typeof dbDelegates & {
  $transaction: <T>(fn: (tx: MockDb) => T | Promise<T>) => Promise<T>;
};

const db: MockDb = {
  ...dbDelegates,
  $transaction: async <T>(fn: (tx: MockDb) => T | Promise<T>) => fn(db),
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true, getAdminRole: () => "owner",
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => undefined,
  writeAdminAuditLog: async () => "unused-admin-audit",
} });
mock.module(mod("lib/amux/autoPromotionService.ts"), { namedExports: {
  OWNER_TRANSACTION_LIMITS: {}, TICK_TRANSACTION_LIMITS: {},
  withAutoTransaction: async (_id: unknown, _limits: unknown,
    fn: (tx: MockDb, at: Date, receipt: () => void) => unknown) => {
    if (world.loseBeforeCommit) {
      world.loseBeforeCommit = false;
      throw new BoardImportError("outcome_unknown", 409);
    }
    const result = await fn(db, now, () => undefined);
    if (world.loseAfterCommit) {
      world.loseAfterCommit = false;
      throw new BoardImportError("outcome_unknown", 409);
    }
    return result;
  },
} });
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), { namedExports: {
  findOpenAmuxOrchestratorHalt: async () => null,
} });
// The services read the assignment catalog (orchestration policy version 35,
// section 3); while R2c is off it is the v22 variable, stood in for here.
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxAssignmentCatalogs: async () => ({ workers: [], v22: [1, 2, 3].map((index) => ({
    worker_name: `worker-${index}`, archived: false, paused: false,
    isolated: false, blocked: false,
  })) }),
} });
mock.module(mod("lib/amux/v4TaskReadyService.ts"), { namedExports: {
  loadAmuxV4TaskReadyContext: async () => ({}),
  evaluateAmuxV4TaskReadyInTransaction: async (_tx: unknown, taskId: string) => ({
    ready: true, taskRevision: cards.get(taskId)!.revision,
    sourceApprovalId: `source-${taskId}`,
    sourceApprovalDigest: `digest-${taskId}`,
    briefDigest: `brief-${taskId}`, parentFeatureNodeId: "feature",
    parentStoryCardId: null,
  }),
} });
mock.module(mod("lib/amux/v22AutoPromotionAudit.ts"), { namedExports: {
  writeV22AutoPromotionAudit: async (_tx: unknown, entry: Record<string, unknown>) => {
    const id = `system-audit-${++world.systemAudits}`;
    audits.set(id, { ...entry, entryHash: `hash-${id}` });
    return id;
  },
} });

let servicePromise: Promise<typeof import(
  "../../lib/amux/v22AutoPromotionService.ts")> | null = null;
const loadService = () => servicePromise ??=
  import(mod("lib/amux/v22AutoPromotionService.ts"));
const session = { user: { id: "owner-1" } };
const request = new Request("https://tomverse.test/admin/amux-execution");
const move = async (taskId = taskA, requestId = requestA,
  expectedRevision = 4) => (await loadService()).requestV22ExecutionMove({
    session, request, taskId,
    expectedRevision, requestId,
    writeHumanIntent: async () => `human-audit-${++world.humanAudits}` });

test("a targeted move never admits a lower-priority or unrelated card", async () => {
  reset();
  await assert.rejects(move(taskB, requestA), { code: "scheduler_priority" });
  assert.deepEqual(world.updates, []);
  assert.equal(receipts.size, 0);
  assert.equal(cards.get(taskA)?.status, "backlog");
  assert.equal(cards.get(taskB)?.status, "backlog");
});

test("one exact request writes one canonical receipt and both audit intents", async () => {
  reset();
  const result = await move();
  assert.deepEqual(result, { promoted: true, state: "promoted", taskId: taskA,
    requestId: requestA, receiptId: requestA,
    destination: "amux_unassigned_todo", fromRevision: 4, revision: 5,
    replayed: false });
  assert.deepEqual(world.updates, [taskA]);
  assert.equal(world.humanAudits, 1);
  assert.equal(world.systemAudits, 1);
  const systemMetadata = audits.get("system-audit-1")?.metadata as
    Record<string, unknown>;
  assert.equal(systemMetadata.requestId, requestA);
  assert.equal(systemMetadata.humanIntentAuditId, "human-audit-1");
  assert.equal(receipts.get(requestA)?.workItemId, taskA);
  assert.equal(cards.get(taskA)?.v22ReceiptId, requestA);
  const replay = await move();
  assert.equal(replay.replayed, true);
  assert.deepEqual(world.updates, [taskA]);
  assert.equal(world.humanAudits, 1);
  assert.equal(world.systemAudits, 1);
  await assert.rejects(move(taskB, requestA), { code: "request_conflict" });
});

test("stale revisions and closed activation fail before a lifecycle write", async () => {
  reset(); cards.get(taskA)!.revision = 5;
  await assert.rejects(move(), { code: "stale_revision" });
  assert.deepEqual(world.updates, []);
  reset(); world.controlActive = false;
  await assert.rejects(move(), { code: "v22_not_activated" });
  assert.deepEqual(world.updates, []);
  assert.equal(receipts.size, 0);
  world.controlActive = true;
  assert.equal((await move(taskA, requestB)).state, "promoted");
});

test("critical halts bind owner intent to the system audit without moving the card",
  async () => {
    for (const violationCode of ["cost_exceeded", "lifecycle_write"] as const) {
      reset();
      world.costExceeded = violationCode === "cost_exceeded";
      world.lifecycleWrite = violationCode === "lifecycle_write";
      const result = await move() as { promoted: boolean; reason: string };
      assert.equal(result.promoted, false);
      assert.equal(result.reason, "auto_halted");
      assert.deepEqual(world.updates, []);
      assert.equal(cards.get(taskA)?.status, "backlog");
      assert.equal(receipts.size, 0);
      assert.equal(world.humanAudits, 1);
      assert.equal(world.systemAudits, 1);
      assert.equal(world.halts.length, 1);
      const metadata = audits.get("system-audit-1")?.metadata as
        Record<string, unknown>;
      assert.equal(metadata.violationCode, violationCode);
      assert.equal(metadata.requestId, requestA);
      assert.equal(metadata.humanIntentAuditId, "human-audit-1");
    }
  });

test("a lost success is read back and an unknown request is never rerun", async () => {
  const service = await loadService();
  reset(); world.loseAfterCommit = true;
  const recovered = await move();
  assert.equal(recovered.state, "promoted");
  assert.equal(recovered.replayed, true);
  assert.deepEqual(world.updates, [taskA]);
  assert.equal((await service.readV22ExecutionMove(taskA, requestA)).state,
    "promoted");

  reset(); world.loseBeforeCommit = true;
  await assert.rejects(move(), { code: "outcome_unknown" });
  assert.equal(unknowns.get(requestA)?.workItemId, taskA);
  assert.deepEqual(world.updates, []);
  await assert.rejects(move(), { code: "outcome_unknown" });
  assert.deepEqual(world.updates, []);
  await assert.rejects(move(taskA, requestB), { code: "scheduler_priority" });
  assert.deepEqual(world.updates, []);
  assert.equal(unknowns.size, 1);
  assert.equal((await service.readV22ExecutionMove(taskA, requestA)).state,
    "outcome_unknown");
});

const previousException = process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV];
process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV] =
  AMUX_V22_GRADUATION_EXCEPTION_ID;
process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE = "enabled";
process.env.TOMVERSE_AMUX_BOARD_AUTO_PROMOTE = "disabled";
process.on("exit", () => {
  if (previousException === undefined) {
    delete process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV];
  } else {
    process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV] = previousException;
  }
});
