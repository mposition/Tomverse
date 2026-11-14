import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Session } from "next-auth";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";

// The AMUX owner queue through the Decision Maker (owner decision 2026-11-13),
// on PostgreSQL with every migration trigger on: a stopped v22 Task is filed
// once per escalation, its answer is applied as the system through the
// statement-bounded transactions, a review pull request's approval is only
// recorded, and a Task that moved cancels instead. No TEST_DATABASE_URL: not
// executed.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-dm-owner-settlement-audit-key-2026";
// The owner of the operating scope a remake's idea is committed under.
const SCOPE_OWNER_ID = "synthetic-dm-remake-owner";
const SCOPE_OWNER_EMAIL = "amux-dm-remake-owner@example.test";
Object.assign(process.env, { ADMIN_USER_IDS: SCOPE_OWNER_ID, ADMIN_EMAILS: SCOPE_OWNER_EMAIL,
  ADMIN_OWNER_EMAILS: SCOPE_OWNER_EMAIL });
Object.assign(process.env, { NODE_ENV: "test" });

const services = async () => ({
  ...(await import("@/lib/amux/dmOwnerSettlementService")),
  ...(await import("@/lib/amux/dmOwnerSettlementCore")),
  ...(await import("@/lib/amux/dbBoundary")),
  ...(await import("@/lib/amux/decisionMakerSwitchStore")),
  ...(await import("@/lib/amux/v22OwnerQuestionDmService")),
});

const HEAD = "c".repeat(40);
const BASE = "b".repeat(40);
const DIFF = "d".repeat(64);

const operator = () => ({ user: { id: `dm-operator-${randomUUID()}`, email: "operator@example.test" },
  expires: "2099-01-01T00:00:00.000Z" }) as Session;

type Stopped = { taskId: string; attemptId: string; escalationId: string; settlementId: string };

/** The fixture's Task, stopped as the settlement walks it, with its escalation open and the DM's kill switch off. */
async function stoppedTask(tx: LifecycleTx, input: {
  status?: "blocked" | "review"; reason?: string;
  taskRole?: string; afterSettlement?: (tx: LifecycleTx, taskId: string) => Promise<unknown>;
} = {}): Promise<Stopped> {
  const status = input.status ?? "blocked";
  const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
    taskRole: input.taskRole ?? "implement", settlementStatus: status,
    settlementReason: input.reason ?? "review_server_rejected_twice" }) as { taskId: string; priorAttemptId: string };
  const escalationId = randomUUID();
  await tx.$executeRaw`INSERT INTO "AmuxHumanEscalation"
    ("id", "taskId", "specialty", "reason", "status", "openedBy", "openedTaskRevision", "updatedAt")
    VALUES (${escalationId}, ${seed.taskId}, 'execution-recovery', ${input.reason ?? "review_server_rejected_twice"},
      'open', 'system:amux-v22-settlement', 4, CURRENT_TIMESTAMP)`;
  await input.afterSettlement?.(tx, seed.taskId);
  const { recordDecisionMakerSwitchByOperator, amuxDmOwnerSettlementId } = await services();
  await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "off" });
  await fixtureCommitted(tx);
  return { taskId: seed.taskId, attemptId: seed.priorAttemptId, escalationId,
    settlementId: amuxDmOwnerSettlementId(escalationId) };
}

async function sync(enabled = true) {
  const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES, readAmuxDmOwnerSettlementSyncRows } = await services();
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
    (tx) => readAmuxDmOwnerSettlementSyncRows(tx, { enabled }));
}

async function apply(settlementId: string, answer: Parameters<
  Awaited<ReturnType<typeof services>>["applyAmuxDmOwnerSettlementDecision"]>[1]["answer"]) {
  const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES, applyAmuxDmOwnerSettlementDecision } = await services();
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementDecision(tx, { settlementId, answer, source: "dm",
      requestId: `req-${randomUUID().slice(0, 8)}`, now: context.dbNow }));
}

type Filing = { ideaId: string } | { refused: string } | { unknown: true } | { guarded: string };
type Guard = { check: (tx: LifecycleTx) => Promise<true | string>;
  committed?: (tx: LifecycleTx, ideaId: string) => Promise<void> };

/** The idea intake, replaced by a fixed answer: what it is asked, and what the
 * settlement was when it was asked. It never reaches a commit. */
function fakeIntake(tx: LifecycleTx, settlementId: string, answer: Filing, readBack: { ideaId: string } | null = null) {
  const seen = { filed: [] as Array<{ requestId: string; ideaText: string; state: unknown; archived: boolean }>,
    readBack: [] as string[] };
  return { seen, deps: {
    fileIdea: async (input: { requestId: string; ideaText: string; guard: Guard }) => {
      const row = await settlementRow(tx, settlementId);
      const [task] = await tx.$queryRaw<Array<{ archived: boolean }>>`
        SELECT "archivedAt" IS NOT NULL AS "archived" FROM "AmuxWorkItem" WHERE "id" = ${row!.taskId as string}`;
      seen.filed.push({ requestId: input.requestId, ideaText: input.ideaText, state: row?.state,
        archived: task!.archived });
      return answer;
    },
    readBack: async (requestId: string) => { seen.readBack.push(requestId); return readBack; },
  } };
}

/**
 * The idea intake as it commits: the asynchronous preparation is what this
 * skips (pinning and the key store reach outside the database), then `race`
 * runs -- the moment after preparation and before the commit transaction --
 * then the real commit body (commitAmuxIdeaSessionIntake) with the guard the
 * remake passes, on the operating scope the lifecycle seeded. A refusal is
 * thrown before the body writes anything.
 */
function committingIntake(tx: LifecycleTx, race: () => Promise<unknown> = async () => {}) {
  const seen = { filed: 0, readBack: [] as string[] };
  return { seen, deps: {
    fileIdea: async (input: { requestId: string; ideaText: string; guard: Guard }) => {
      seen.filed += 1;
      const { amuxDmOwnerSettlementRemakeSubmission } = await import("@/lib/amux/dmOwnerSettlementRemake");
      const { commitAmuxIdeaSessionIntake, AmuxIdeaSessionGuardRefused } =
        await import("@/lib/amux/ideaSessionSubmissionService");
      const { readAmuxOperatingScopeAuthority } = await import("@/lib/amux/ideaOperatingScopeStore");
      const { prisma } = await import("@/lib/prisma");
      const inspected = amuxDmOwnerSettlementRemakeSubmission(input.requestId, input.ideaText);
      assert.ok(inspected.ok, "the remake's idea passes the intake's input check");
      const authority = await prisma.$transaction((inner) => readAmuxOperatingScopeAuthority(inner));
      assert.ok(authority);
      await race();
      const ideaId = randomUUID();
      try {
        // The body runs on the lifecycle's own transaction, not a savepoint: the
        // intake's trigger requires its audit row to carry the commit's own xid.
        const committed = await commitAmuxIdeaSessionIntake(tx, {
          inspected, expectedAuthority: authority, ideaId, keys: keysFor(ideaId),
          // What pinning the one repository the remake names would have given.
          pinnedCommitShas: ["a".repeat(40)],
          guard: input.guard });
        return { ideaId: committed.ideaId };
      } catch (error) {
        if (error instanceof AmuxIdeaSessionGuardRefused) return { guarded: error.reason };
        throw error;
      }
    },
    readBack: async (requestId: string) => { seen.readBack.push(requestId); return null; },
  } };
}

const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1, masterKey, digestKeyId: "synthetic-dm-remake-digest", digestKey,
});
const scopeOwner = () => ({ user: { id: SCOPE_OWNER_ID, email: SCOPE_OWNER_EMAIL,
  authenticatedAt: new Date().toISOString() }, expires: new Date(Date.now() + 3_600_000).toISOString() }) as Session;

/** An operating scope the intake commits under, with an approved model of its
 * own: seeded in the lifecycle over whatever scope the database holds, and
 * rolled back with it. */
async function operatingScope(tx: LifecycleTx) {
  const { readAmuxOperatingScopeAuthority, commitAmuxOperatingScope } = await import("@/lib/amux/ideaOperatingScopeStore");
  const current = await readAmuxOperatingScopeAuthority(tx);
  const { commitFrontierCatalogDecision } = await import("@/lib/amux/ideaFrontierCatalogWrite");
  const { inspectFrontierCatalogWrite } = await import("@/lib/amux/ideaFrontierCatalogWriteCore");
  const modelId = `synthetic-remake-model-${randomUUID()}`;
  const request = new Request("https://tomverse.test/internal/amux/dm-remake", { method: "POST" });
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1, action: "approve",
    approvalId: randomUUID(), provider: "openai", modelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  if (!frontier.ok) throw new Error(`synthetic Frontier input rejected: ${frontier.code}`);
  await commitFrontierCatalogDecision(tx, { session: scopeOwner(), request, decision: frontier.request });
  await commitAmuxOperatingScope(tx, { session: scopeOwner(), request, id: randomUUID(),
    expectedPreviousVersion: current?.version ?? 0, ownerConfirmed: true,
    scope: { repositories: ["mposition/Tomverse"], model: { provider: "openai", modelId, reasoningEffort: "high" } } });
}

/** Ideas and analysis reservations filed under one request id. */
async function filedUnder(tx: LifecycleTx, requestId: string) {
  const [row] = await tx.$queryRaw<Array<{ ideas: number; reservations: number; ideaId: string | null }>>`
    SELECT count(DISTINCT i."id")::int AS "ideas", count(r."id")::int AS "reservations", max(i."id") AS "ideaId"
    FROM "AmuxIdeaSubmission" i
    LEFT JOIN "AmuxIdeaSessionAnalysisReservation" r ON r."ideaId" = i."id"
    WHERE i."requestId" = ${requestId}::uuid`;
  return row!;
}

async function settle(settlementId: string, answer: Parameters<
  Awaited<ReturnType<typeof services>>["applyAmuxDmOwnerSettlementDecision"]>[1]["answer"],
  deps: { fileIdea: (input: { requestId: string; ideaText: string; guard: Guard }) => Promise<Filing>;
    readBack: (requestId: string) => Promise<{ ideaId: string } | null> },
  source: "dm" | "dm_confirmed" = "dm_confirmed") {
  const { settleAmuxDmOwnerSettlementAnswer } = await import("@/lib/amux/dmOwnerSettlementRemake");
  return settleAmuxDmOwnerSettlementAnswer({ settlementId, answer, source,
    requestId: `req-${randomUUID().slice(0, 8)}` }, deps as never);
}

const settlementRow = async (tx: LifecycleTx, id: string) => (await tx.$queryRaw<Array<Record<string, unknown>>>`
  SELECT * FROM "AmuxDmOwnerSettlement" WHERE "id" = ${id}`)[0];
const taskRow = (tx: LifecycleTx, id: string) => tx.amuxWorkItem.findUniqueOrThrow({ where: { id },
  select: { status: true, revision: true, archivedAt: true, v4TerminalAt: true, owner: true } });
const escalationRow = (tx: LifecycleTx, id: string) => tx.amuxHumanEscalation.findUniqueOrThrow({
  where: { id }, select: { status: true, resolvedById: true, resolvedByEmail: true, resolutionOutcome: true } });
const appliedAudit = (tx: LifecycleTx, taskId: string) => tx.adminAuditLog.findFirst({
  where: { targetId: taskId, action: "amux.dm_owner_settlement.applied" },
  orderBy: { createdAt: "desc" }, select: { actorUserId: true, entryHash: true, metadata: true } });

/** A card under the same feature as the fixture Task, its v4 columns copied, never run. */
async function addSibling(tx: LifecycleTx, taskId: string, id: string, status: "backlog" | "blocked") {
  await tx.$executeRaw`INSERT INTO "AmuxWorkItem" ("id", "title", "status", "revision", "sourceSystem",
    "sourceKey", "sourceVersion", "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
    "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion", "v4TitleDigest", "v4TitleDigestKeyId",
    "v4BodyCiphertext", "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest", "v4BodyDigestKeyId",
    "v4BriefCiphertext", "v4BriefKeyId", "v4BriefKeyVersion", "v4BriefDigest", "v4BriefDigestKeyId",
    "v4SourceApprovalId", "taskRole", "executionGrade", "updatedAt")
    SELECT ${id}, "title", ${status}, 0, "sourceSystem", ${id.toUpperCase()}, "sourceVersion", "sourceDigest",
      "sourceSnapshot", "cardType", "parentFeatureNodeId",
      "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion", "v4TitleDigest", "v4TitleDigestKeyId",
      "v4BodyCiphertext", "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest", "v4BodyDigestKeyId",
      "v4BriefCiphertext", "v4BriefKeyId", "v4BriefKeyVersion", "v4BriefDigest", "v4BriefDigestKeyId",
      "v4SourceApprovalId", "taskRole", "executionGrade", CURRENT_TIMESTAMP
    FROM "AmuxWorkItem" WHERE "id" = ${taskId}`;
}

/** Four cards beside the fixture Task: one waiting on it, one waiting on that, one started, one unrelated. */
const remakeSiblings = (ids: { waiting: string; chained: string; started: string; unrelated: string }) =>
  async (inner: LifecycleTx, taskId: string) => {
    await withoutTriggers(inner, async () => {
      for (const [id, status] of [[ids.waiting, "backlog"], [ids.chained, "backlog"], [ids.started, "blocked"],
        [ids.unrelated, "backlog"]] as const) await addSibling(inner, taskId, id, status);
      await inner.$executeRaw`INSERT INTO "AmuxWorkDependency" ("taskId", "dependencyId") VALUES
        (${ids.waiting}, ${taskId}), (${ids.chained}, ${ids.waiting}), (${ids.started}, ${taskId})`;
    });
  };

after(async () => { await closeLifecycleHarness(); });

test("a stopped Task is filed once per escalation, only while the switch is on, and its unreadable evidence goes to the person", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    const off = await sync(false);
    assert.deepEqual(off.pending, [], "off files nothing");
    assert.equal(await settlementRow(tx, card.settlementId), undefined);

    const on = await sync(true);
    const mine = on.pending.filter((row) => row.settlementId === card.settlementId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.kind, "stopped");
    assert.equal(mine[0]!.reason, "review_server_rejected_twice");
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.escalationId, card.escalationId);
    assert.equal(row?.attemptId, card.attemptId);
    assert.equal(row?.taskStatus, "blocked");
    await sync(true);
    const count = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS "n" FROM "AmuxDmOwnerSettlement" WHERE "taskId" = ${card.taskId}`;
    assert.equal(count[0]!.n, 1, "one settlement per escalation");

    // The fixture's sealed body is synthetic bytes under no real key.
    const { openAmuxDmOwnerSettlementCards, recordAmuxDmOwnerSettlementsUnfilable, withAmuxDbBoundary,
      AMUX_DB_BOUNDARIES } = await services();
    const opened = await openAmuxDmOwnerSettlementCards({ ...on, pending: mine });
    assert.deepEqual(opened, { cards: [], unfilable: [card.settlementId] });
    assert.deepEqual(await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementHandoff,
      (inner, context) => recordAmuxDmOwnerSettlementsUnfilable(inner,
        { settlementIds: opened.unfilable, now: context.dbNow })), { recorded: 1 });
    assert.equal((await settlementRow(tx, card.settlementId))?.handoffReason, "evidence_unavailable");
    assert.ok(!(await sync(true)).pending.some((entry) => entry.settlementId === card.settlementId));
    assert.deepEqual(await apply(card.settlementId, { decision: "retry" }), { applied: false, outcome: "handed_off" },
      "handed to the person, no later DM answer decides it");
  });
});

test("retry runs the Task again as the system, its escalation resolved and one chained audit; the card is never a session's", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES, recordDmQuestionLocalCard, recordDmQuestionLocalCardClosed,
      isAmuxV22QuestionCard } = await services();
    const localCard = `OS-${randomUUID().slice(0, 8)}`;
    assert.deepEqual(await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
      (inner) => recordDmQuestionLocalCard(inner, { questionId: card.settlementId, cardId: localCard })),
      { recorded: true });
    assert.equal(await isAmuxV22QuestionCard(tx, localCard), true, "its answer never reaches a session");

    assert.deepEqual(await apply(card.settlementId, { decision: "retry" }), { applied: true, outcome: "todo" });
    const task = await taskRow(tx, card.taskId);
    assert.equal(task.status, "todo");
    assert.equal(task.revision, 5);
    assert.equal(task.owner, null);
    assert.deepEqual(await escalationRow(tx, card.escalationId), { status: "resolved",
      resolvedById: "system:amux-dm-owner-settlement", resolvedByEmail: null, resolutionOutcome: "retry" });
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.state, "applied");
    assert.equal(row?.decision, "retry");
    assert.equal(row?.answerSource, "dm");
    const audit = await appliedAudit(tx, card.taskId);
    assert.ok(audit?.entryHash, "the hash-chained audit row");
    assert.equal(audit?.actorUserId, null, "a system actor, not a person");
    assert.equal((audit?.metadata as Record<string, unknown>).toStatus, "todo");
    assert.deepEqual(await apply(card.settlementId, { decision: "retry" }), { applied: false, outcome: null },
      "a second answer finds it applied");

    const rows = await sync(true);
    assert.ok(rows.closing.some((entry) => entry.questionId === card.settlementId), "its card is closed by the relay");
    assert.deepEqual(await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionWrite,
      (inner, context) => recordDmQuestionLocalCardClosed(inner, { questionId: card.settlementId,
        cardId: localCard, now: context.dbNow })), { recorded: true });
  });
});

test("complete finishes the Task terminal on the database clock; close archives it with its status kept", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    assert.deepEqual(await apply(card.settlementId, { decision: "complete" }), { applied: true, outcome: "done" });
    const task = await taskRow(tx, card.taskId);
    assert.equal(task.status, "done");
    assert.ok(task.v4TerminalAt, "dependents wait on this timestamp");
    assert.equal((await escalationRow(tx, card.escalationId)).resolutionOutcome, "approve");
  });
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx, { status: "review", reason: "human_review_required" });
    await sync(true);
    assert.deepEqual(await apply(card.settlementId, { decision: "close" }), { applied: true, outcome: "closed" });
    const task = await taskRow(tx, card.taskId);
    assert.equal(task.status, "review", "a close keeps the status");
    assert.ok(task.archivedAt);
    assert.equal((await escalationRow(tx, card.escalationId)).status, "resolved");
  });
});

const REMAKE = { decision: "remake" as const, ideaText: "One card: add the router failure name and wire it." };

test("a confirmed remake is claimed first; its idea and reservation are written once, under the guard, and named on the claim; then its cards close", async () => {
  await lifecycle(async (tx) => {
    const ids = { waiting: randomUUID(), chained: randomUUID(), started: randomUUID(), unrelated: randomUUID() };
    const card = await stoppedTask(tx, { afterSettlement: remakeSiblings(ids) });
    await operatingScope(tx);
    const rows = await sync(true);
    const siblings = rows.siblings.filter((row) => row.forTaskId === card.taskId);
    assert.equal(siblings.length, 4, "the cards under the same parent come with its card");
    assert.deepEqual(siblings.filter((row) => row.waitsOnThis).map((row) => row.id).sort(),
      [ids.waiting, ids.started].sort());

    let atCommit: Record<string, unknown> | undefined;
    const intake = committingIntake(tx, async () => { atCommit = await settlementRow(tx, card.settlementId); });
    assert.deepEqual(await settle(card.settlementId, REMAKE, intake.deps), { applied: true, outcome: "remade" });
    assert.equal(atCommit?.state, "claimed", "the idea is committed only after the claim committed");
    const row = await settlementRow(tx, card.settlementId);
    const filed = await filedUnder(tx, row!.remakeRequestId as string);
    assert.deepEqual({ ideas: filed.ideas, reservations: filed.reservations }, { ideas: 1, reservations: 1 });
    assert.equal(row?.remakeIdeaId, filed.ideaId, "the intake's own commit named the idea on the claim");
    assert.equal(row?.state, "applied");
    assert.equal(row?.answerSource, "dm_confirmed");
    for (const id of [card.taskId, ids.waiting, ids.chained])
      assert.ok((await taskRow(tx, id)).archivedAt, `${id} is closed`);
    for (const id of [ids.started, ids.unrelated])
      assert.equal((await taskRow(tx, id)).archivedAt, null, `${id} is left: started, or not waiting on it`);
    const claimed = await tx.adminAuditLog.findFirst({ where: { targetId: card.taskId,
      action: "amux.dm_owner_settlement.remake_claimed" }, select: { entryHash: true } });
    assert.ok(claimed?.entryHash, "the claim is in the hash chain");
    const audit = await appliedAudit(tx, card.taskId);
    assert.deepEqual((audit?.metadata as { closedTaskIds: string[] }).closedTaskIds,
      [card.taskId, ids.waiting, ids.chained].sort());
  });
});

test("whatever changes between the intake's preparation and its commit, the guard in the commit writes no idea and no reservation", async () => {
  const races: Array<[string, (tx: LifecycleTx, card: Stopped) => Promise<unknown>, string, string]> = [
    ["the person resolves the escalation", (tx, card) => tx.$executeRaw`
      UPDATE "AmuxHumanEscalation" SET "status" = 'resolved', "resolvedById" = 'person',
        "resolution" = 'Handled it myself.', "resolutionOutcome" = 'block',
        "resolvedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${card.escalationId}`,
      "cancelled", "escalation_resolved"],
    ["a new run ends back in the same status", (tx, card) => withoutTriggers(tx, async () => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE dm_next_attempt ON COMMIT DROP AS
        SELECT * FROM "AmuxExecutionAttempt" WHERE "id" = '${card.attemptId}'`);
      await tx.$executeRaw`UPDATE dm_next_attempt SET "id" = ${randomUUID()}, "attemptNumber" = "attemptNumber" + 1,
        "taskRevision" = "taskRevision" + 1, "startedAt" = "startedAt" + INTERVAL '1 minute',
        "endedAt" = "endedAt" + INTERVAL '2 minutes', "v22AssignmentId" = NULL`;
      await tx.$executeRawUnsafe(`INSERT INTO "AmuxExecutionAttempt" SELECT * FROM dm_next_attempt`);
      await tx.$executeRawUnsafe("DROP TABLE dm_next_attempt");
    }), "cancelled", "task_moved"],
    ["a delivery is queued", (tx, card) => withoutTriggers(tx, () => tx.$executeRaw`
      UPDATE "AmuxWorkDelivery" SET "status" = 'queued', "receiptId" = NULL, "leasedAt" = NULL,
        "leaseExpiresAt" = NULL, "acknowledgedAt" = NULL WHERE "attemptId" = ${card.attemptId}`),
      "cancelled", "task_moved"],
    ["the kill switch goes on", async (tx) => {
      const { recordDecisionMakerSwitchByOperator } = await services();
      await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    }, "handed_off", "remake_held"],
    ["the claim is cancelled", (tx, card) => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'cancelled', "cancelReason" = 'task_moved'
      WHERE "id" = ${card.settlementId}`, "unchanged", "task_moved"],
  ];
  for (const [label, race, outcome, reason] of races) {
    await lifecycle(async (tx) => {
      const card = await stoppedTask(tx);
      await operatingScope(tx);
      await sync(true);
      const intake = committingIntake(tx, () => race(tx, card));
      const result = await settle(card.settlementId, REMAKE, intake.deps);
      assert.equal(intake.seen.filed, 1, `${label}: the intake prepared once`);
      const row = await settlementRow(tx, card.settlementId);
      const filed = await filedUnder(tx, row!.remakeRequestId as string);
      assert.deepEqual({ ideas: filed.ideas, reservations: filed.reservations }, { ideas: 0, reservations: 0 },
        `${label}: no idea and no reservation`);
      assert.equal(row?.remakeIdeaId, null, label);
      assert.deepEqual(intake.seen.readBack, [], `${label}: a refusal is not an unknown outcome`);
      assert.equal((await taskRow(tx, card.taskId)).archivedAt, null, `${label}: no card closed`);
      if (outcome === "cancelled") {
        assert.deepEqual(result, { applied: true, outcome: "cancelled" }, label);
        assert.equal(row?.state, "cancelled", label);
        assert.equal(row?.cancelReason, reason, label);
      } else if (outcome === "handed_off") {
        assert.deepEqual(result, { applied: false, outcome: "handed_off" }, label);
        assert.equal(row?.state, "claimed", label);
        assert.equal(row?.handoffReason, reason, label);
      } else {
        assert.deepEqual(result, { applied: true, outcome: "remake_claimed",
          remakeRequestId: row!.remakeRequestId }, `${label}: the claim was the answer; nothing more`);
        assert.equal(row?.state, "cancelled", label);
      }
    });
  }
});

test("a person who answered first, or the kill switch at the answer, means nothing is claimed or filed", async () => {
  // The person resolved the card's escalation before the answer was applied.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    await tx.$executeRaw`UPDATE "AmuxHumanEscalation" SET "status" = 'resolved', "resolvedById" = 'person',
      "resolution" = 'Handled it myself.', "resolutionOutcome" = 'block',
      "resolvedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${card.escalationId}`;
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() });
    assert.deepEqual(await settle(card.settlementId, REMAKE, intake.deps), { applied: true, outcome: "cancelled" });
    assert.equal(intake.seen.filed.length, 0);
  });
  // The approver's claim of the request is refused (a person judged it first,
  // or it is not there): nothing is applied and nothing is filed.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() });
    const { applyAmuxDmAutoApplyCandidate } = await import("@/lib/amux/dmAutoApplyService");
    assert.deepEqual(await applyAmuxDmAutoApplyCandidate({ kind: "owner_settlement",
      requestId: "req-judged", cardId: `OS-${randomUUID().slice(0, 8)}`, questionRevision: 1,
      settlementId: card.settlementId, answer: REMAKE }, intake.deps as never),
      { requestId: "req-judged", kind: "owner_settlement", applied: false });
    assert.equal(intake.seen.filed.length, 0);
    assert.equal((await settlementRow(tx, card.settlementId))?.state, "open");
  });
  // The kill switch is on when the answer comes: nothing is claimed.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const { recordDecisionMakerSwitchByOperator } = await services();
    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() });
    assert.deepEqual(await settle(card.settlementId, REMAKE, intake.deps), { applied: false, outcome: null });
    assert.equal(intake.seen.filed.length, 0);
    assert.equal((await settlementRow(tx, card.settlementId))?.state, "open");
  });
});

test("an idea the intake refuses, or whose outcome nobody knows and cannot be read back, goes to the person; it is never filed twice", async () => {
  const cases: Array<[Filing, { ideaId: string } | null, string]> = [
    [{ refused: "idea_refused" }, null, "remake_refused"], [{ unknown: true }, null, "remake_unknown"]];
  for (const [filing, readBack, reason] of cases) {
    await lifecycle(async (tx) => {
      const card = await stoppedTask(tx);
      await sync(true);
      const intake = fakeIntake(tx, card.settlementId, filing, readBack);
      assert.deepEqual(await settle(card.settlementId, REMAKE, intake.deps), { applied: false, outcome: "handed_off" });
      assert.equal(intake.seen.filed.length, 1, "filed once");
      assert.equal(intake.seen.filed[0]!.state, "claimed", "only after the claim");
      const row = await settlementRow(tx, card.settlementId);
      assert.equal(row?.state, "claimed");
      assert.equal(row?.handoffReason, reason);
      assert.equal((await taskRow(tx, card.taskId)).archivedAt, null, "no idea, no close");
      if ("unknown" in filing)
        assert.deepEqual(intake.seen.readBack, [row!.remakeRequestId], "read back once, by its request id");
    });
  }
  // An unknown outcome that reads back committed is the idea: the cards close.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const ideaId = randomUUID();
    const intake = fakeIntake(tx, card.settlementId, { unknown: true }, { ideaId });
    assert.deepEqual(await settle(card.settlementId, REMAKE, intake.deps), { applied: true, outcome: "remade" });
    assert.equal(intake.seen.filed.length, 1);
    assert.equal((await settlementRow(tx, card.settlementId))?.remakeIdeaId, ideaId);
  });
});

test("a claim an earlier tick left unfinished is finished from what it names, cancelled when its Task moved, or handed over; nothing is filed", async () => {
  const stale = (tx: LifecycleTx, card: Stopped) => tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "decidedAt" = "decidedAt" - INTERVAL '3 minutes' WHERE "id" = ${card.settlementId}`;
  const resume = async (deps: unknown) =>
    (await import("@/lib/amux/dmOwnerSettlementRemake")).resumeAmuxDmOwnerSettlementRemake(deps as never);
  // The intake's commit named its idea, then the close was lost: the close runs.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    assert.equal((await apply(card.settlementId, REMAKE)).outcome, "remake_claimed");
    const ideaId = randomUUID();
    await tx.$executeRaw`UPDATE "AmuxDmOwnerSettlement" SET "remakeIdeaId" = ${ideaId} WHERE "id" = ${card.settlementId}`;
    await stale(tx, card);
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() });
    assert.deepEqual(await resume(intake.deps), { applied: true, outcome: "remade" });
    assert.equal(intake.seen.filed.length, 0);
    assert.deepEqual(intake.seen.readBack, []);
    assert.equal((await settlementRow(tx, card.settlementId))?.remakeIdeaId, ideaId);
    assert.ok((await taskRow(tx, card.taskId)).archivedAt);
  });
  // No idea named and the Task moved (a queued delivery): cancelled, nothing read back.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    assert.equal((await apply(card.settlementId, REMAKE)).outcome, "remake_claimed");
    await withoutTriggers(tx, () => tx.$executeRaw`
      UPDATE "AmuxWorkDelivery" SET "status" = 'queued', "receiptId" = NULL, "leasedAt" = NULL,
        "leaseExpiresAt" = NULL, "acknowledgedAt" = NULL WHERE "attemptId" = ${card.attemptId}`);
    await stale(tx, card);
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() }, { ideaId: randomUUID() });
    assert.deepEqual(await resume(intake.deps), { applied: true, outcome: "cancelled" });
    assert.equal(intake.seen.filed.length, 0);
    assert.deepEqual(intake.seen.readBack, []);
    assert.equal((await settlementRow(tx, card.settlementId))?.cancelReason, "task_moved");
  });
  // No idea named, the Task unmoved, and none reads back: the person decides.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    assert.equal((await apply(card.settlementId, REMAKE)).outcome, "remake_claimed");
    await stale(tx, card);
    const intake = fakeIntake(tx, card.settlementId, { ideaId: randomUUID() }, null);
    assert.deepEqual(await resume(intake.deps), { applied: false, outcome: "handed_off" });
    assert.equal(intake.seen.filed.length, 0, "never filed again");
    assert.equal((await settlementRow(tx, card.settlementId))?.handoffReason, "remake_unknown");
  });
  // The sync's sweep judges the same way: a claim with a queued delivery is cancelled there too.
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    assert.equal((await apply(card.settlementId, REMAKE)).outcome, "remake_claimed");
    await withoutTriggers(tx, () => tx.$executeRaw`
      UPDATE "AmuxWorkDelivery" SET "status" = 'queued', "receiptId" = NULL, "leasedAt" = NULL,
        "leaseExpiresAt" = NULL, "acknowledgedAt" = NULL WHERE "attemptId" = ${card.attemptId}`);
    await sync(true);
    assert.equal((await settlementRow(tx, card.settlementId))?.cancelReason, "task_moved");
  });
});

test("a review pull request's approval is recorded with its verified head and diff; the Task and its escalation stay", async () => {
  await lifecycle(async (tx) => {
    const runId = String(820_000_000 + Math.floor(Math.random() * 90_000_000));
    const bindingId = randomUUID();
    const prNumber = 910_000 + Math.floor(Math.random() * 80_000);
    const patch = "diff --git a/lib/x.ts b/lib/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const card = await stoppedTask(tx, { status: "review", reason: "human_review_required",
      afterSettlement: async (inner, taskId) => {
        const [attempt] = await inner.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "AmuxExecutionAttempt" WHERE "taskId" = ${taskId}`;
        await withoutTriggers(inner, async () => {
          await inner.$executeRaw`INSERT INTO "EngineeringAgentRun"
            ("id", "amuxAttemptId", "cardId", "cardKind", "baseSha", "status", "outcome", "halt", "modeAtStart",
             "startedAt", "endedAt", "leaseExpiresAt")
            VALUES (${runId}, ${attempt!.id}, ${taskId}, 'task', ${BASE}, 'finished', 't2_draft',
              'none', 't1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
          await inner.$executeRaw`INSERT INTO "EngineeringAgentWorkItem"
            ("id", "kind", "state", "causeKey", "runId", "patchBody", "patchDigest", "baseSha", "expectedTreeId",
             "updatedAt", "closedAt")
            VALUES (${randomUUID()}, 'publish', 'published', ${`publish_review:${runId}`}, ${runId}, ${patch},
              ${createHash("sha256").update(patch, "utf8").digest("hex")}, ${BASE}, ${"f".repeat(40)},
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
          await inner.$executeRaw`INSERT INTO "EngineeringAgentBinding"
            ("id", "runId", "prNumber", "headSha", "verifiedHeadSha", "ref", "snapshot", "currentPrNumber", "updatedAt")
            VALUES (${bindingId}, ${runId}, ${prNumber}, ${HEAD}, ${HEAD}, ${`agent/engineering/${runId}`},
              ${JSON.stringify({ baseSha: BASE, diffDigest: DIFF, treeId: "f".repeat(40),
                invalidatedReviewIds: [] })}::jsonb, ${prNumber}, CURRENT_TIMESTAMP)`;
        });
      } });
    const rows = await sync(true);
    const mine = rows.pending.find((row) => row.settlementId === card.settlementId);
    assert.equal(mine?.kind, "t2_pr");
    assert.equal(mine?.bindingId, bindingId);
    assert.deepEqual(rows.pulls.find((row) => row.bindingId === bindingId),
      { bindingId, prNumber, patchBody: patch }, "the pull request's patch is the card's evidence");
    assert.deepEqual(await apply(card.settlementId, { decision: "complete" }), { applied: false, outcome: "handed_off" },
      "a pull request is never just marked done");
  });
  await lifecycle(async (tx) => {
    const runId = String(830_000_000 + Math.floor(Math.random() * 90_000_000));
    const bindingId = randomUUID();
    const patch = "diff --git a/lib/y.ts b/lib/y.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const card = await stoppedTask(tx, { status: "review", reason: "human_review_required",
      afterSettlement: async (inner, taskId) => {
        const [attempt] = await inner.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "AmuxExecutionAttempt" WHERE "taskId" = ${taskId}`;
        await withoutTriggers(inner, async () => {
          await inner.$executeRaw`INSERT INTO "EngineeringAgentRun"
            ("id", "amuxAttemptId", "cardId", "cardKind", "baseSha", "status", "outcome", "halt", "modeAtStart",
             "startedAt", "endedAt", "leaseExpiresAt")
            VALUES (${runId}, ${attempt!.id}, ${taskId}, 'task', ${BASE}, 'finished', 't2_draft',
              'none', 't1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
          await inner.$executeRaw`INSERT INTO "EngineeringAgentWorkItem"
            ("id", "kind", "state", "causeKey", "runId", "patchBody", "patchDigest", "baseSha", "expectedTreeId",
             "updatedAt", "closedAt")
            VALUES (${randomUUID()}, 'publish', 'published', ${`publish_review:${runId}`}, ${runId}, ${patch},
              ${createHash("sha256").update(patch, "utf8").digest("hex")}, ${BASE}, ${"f".repeat(40)},
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
          await inner.$executeRaw`INSERT INTO "EngineeringAgentBinding"
            ("id", "runId", "prNumber", "headSha", "verifiedHeadSha", "ref", "snapshot", "currentPrNumber", "updatedAt")
            VALUES (${bindingId}, ${runId}, 920001, ${HEAD}, ${HEAD}, ${`agent/engineering/${runId}`},
              ${JSON.stringify({ baseSha: BASE, diffDigest: DIFF, treeId: "f".repeat(40),
                invalidatedReviewIds: [] })}::jsonb, 920001, CURRENT_TIMESTAMP)`;
        });
      } });
    await sync(true);
    assert.deepEqual(await apply(card.settlementId, { decision: "approve" }), { applied: true, outcome: "approved" });
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.state, "applied");
    assert.equal(row?.bindingId, bindingId);
    assert.equal(row?.approvedHeadSha, HEAD);
    assert.equal(row?.approvedDiffDigest, DIFF);
    assert.ok(row?.decidedAt && row?.requestId);
    const task = await taskRow(tx, card.taskId);
    assert.equal(task.status, "review", "the Task waits for the next stage");
    assert.equal(task.revision, 4);
    assert.equal((await escalationRow(tx, card.escalationId)).status, "open");
    const audit = await appliedAudit(tx, card.taskId);
    assert.equal((audit?.metadata as Record<string, unknown>).approvedHeadSha, HEAD);
    const again = await sync(true);
    assert.ok(!again.pending.some((entry) => entry.taskId === card.taskId), "the escalation is not filed again");
  });
});

test("a Task that moved, a resolved escalation or a spent budget never takes the Decision Maker's answer", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    await withoutTriggers(tx, () => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'todo' WHERE "id" = ${card.taskId}`);
    assert.deepEqual(await apply(card.settlementId, { decision: "close" }), { applied: true, outcome: "cancelled" });
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.state, "cancelled");
    assert.equal(row?.cancelReason, "task_moved");
    assert.equal((await taskRow(tx, card.taskId)).archivedAt, null);
  });
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    await tx.$executeRaw`UPDATE "AmuxHumanEscalation" SET "status" = 'resolved', "resolvedById" = 'person',
      "resolution" = 'Handled it myself.', "resolutionOutcome" = 'block',
      "resolvedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${card.escalationId}`;
    await sync(true);
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.state, "cancelled", "the sync cancels it: the person answered first");
    assert.equal(row?.cancelReason, "escalation_resolved");
  });
  await lifecycle(async (tx) => {
    // The fixture's Task allows two ordered attempts; its one run is placed as the budget's last.
    const card = await stoppedTask(tx, { afterSettlement: (inner, taskId) => withoutTriggers(inner,
      () => inner.$executeRaw`UPDATE "AmuxExecutionAttempt" SET "attemptNumber" = 5 WHERE "taskId" = ${taskId}`) });
    await sync(true);
    assert.deepEqual(await apply(card.settlementId, { decision: "retry" }), { applied: false, outcome: "handed_off" });
    assert.equal((await settlementRow(tx, card.settlementId))?.handoffReason, "attempt_budget_spent");
    assert.equal((await taskRow(tx, card.taskId)).status, "blocked");
  });
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const { recordDecisionMakerSwitchByOperator } = await services();
    await recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value: "on" });
    assert.deepEqual(await apply(card.settlementId, { decision: "close" }), { applied: false, outcome: null },
      "the kill switch holds it");
    assert.equal((await settlementRow(tx, card.settlementId))?.state, "open");
  });
});

test("the table refuses what the lifecycle does not allow", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    await sync(true);
    const refusedBy = async (constraint: string, sql: () => Promise<unknown>) => {
      await tx.$executeRawUnsafe("SAVEPOINT refused_check");
      try { await sql(); await tx.$executeRawUnsafe("RELEASE SAVEPOINT refused_check"); return false; }
      catch (error) {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refused_check");
        return (error as Error).message.includes(constraint);
      }
    };
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_state_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'applied', "decision" = 'approve', "answerSource" = 'dm',
        "requestId" = 'r', "decidedAt" = now() WHERE "id" = ${card.settlementId}`), true,
      "a stopped Task is never approved, and an approval names its head");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_shape_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'applied', "decision" = 'remake', "answerSource" = 'dm',
        "requestId" = 'r', "decidedAt" = now() WHERE "id" = ${card.settlementId}`), true,
      "a remake names its claim's idea request id");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_state_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'applied', "decision" = 'remake', "answerSource" = 'dm',
        "requestId" = 'r', "remakeRequestId" = ${"00000000-0000-4000-8000-000000000002"},
        "decidedAt" = now() WHERE "id" = ${card.settlementId}`), true,
      "an applied remake names its idea");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_state_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'claimed', "decision" = 'remake',
        "requestId" = 'r', "remakeRequestId" = ${"00000000-0000-4000-8000-000000000002"},
        "decidedAt" = now() WHERE "id" = ${card.settlementId}`), true,
      "a claim names who decided it");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_shape_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "remakeIdeaId" = 'idea-1' WHERE "id" = ${card.settlementId}`), true,
      "an idea is named only under its claim's request id");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_shape_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "kind" = 't2_pr' WHERE "id" = ${card.settlementId}`), true,
      "a pull request settlement names its binding");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_shape_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "id" = ${randomUUID()} WHERE "id" = ${card.settlementId}`), true,
      "a version 4 id is not a settlement's");
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_escalationId_key", () => tx.$executeRaw`
      INSERT INTO "AmuxDmOwnerSettlement" ("id", "taskId", "escalationId", "kind", "taskStatus", "updatedAt")
      VALUES (${"00000000-0000-8000-8000-000000000001"}, ${card.taskId}, ${card.escalationId}, 'stopped',
        'blocked', now())`), true, "one per escalation");
  });
});

test("the owner asks for one card from the owner queue while the switch is off; the tick files only that one; an unreadable one is sent again", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    const { requestAmuxOwnerQueueDm } = await import("@/lib/amux/ownerQueueDmRequestService");
    const { AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION } = await import("@/lib/amux/ownerQueueDmRequestCore");
    const { readAmuxDmOwnerSettlementRequestedAmong, readAmuxOwnerQueueDmAskedAmong } =
      await import("@/lib/amux/dmOwnerSettlementRead");
    const press = (over: Partial<Parameters<typeof requestAmuxOwnerQueueDm>[0]> = {}) => requestAmuxOwnerQueueDm({
      session: operator(), request: new Request("https://tomverse.app/api/admin/amux/owner-queue/dm-request"),
      taskId: card.taskId, source: "settlement", action: "request", sourceId: card.escalationId, ...over });
    assert.deepEqual((await sync(false)).pending, [], "off files nothing on its own");

    // A Task that is not the escalation's, and a review resend with nothing to resend, change nothing.
    assert.deepEqual(await press({ taskId: "not-the-escalations-task" }), { outcome: "refused", reason: "not_eligible" });
    assert.deepEqual(await press({ source: "result_review", action: "resend", sourceId: "no-such-review" }),
      { outcome: "refused", reason: "not_resendable" });
    assert.equal(await settlementRow(tx, card.settlementId), undefined);

    assert.deepEqual(await press(), { outcome: "done", settlementId: card.settlementId });
    const audits = await tx.$queryRaw<Array<{ action: string; actorEmail: string | null; entryHash: string | null }>>`
      SELECT "action", "actorEmail", "entryHash" FROM "AdminAuditLog" WHERE "targetId" = ${card.settlementId}`;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION);
    assert.equal(audits[0]!.actorEmail, "operator@example.test");
    assert.ok(audits[0]!.entryHash, "the person's press is on the hash chain");
    assert.deepEqual(await press(), { outcome: "refused", reason: "not_eligible" }, "one settlement per escalation");
    assert.deepEqual([...await readAmuxDmOwnerSettlementRequestedAmong(tx, [card.settlementId])], [card.settlementId]);
    // The DM approver reads the same entry and leaves the answer to the owner.
    assert.deepEqual([...await readAmuxOwnerQueueDmAskedAmong(tx,
      { settlementIds: [card.settlementId, "other"], reviewIds: [card.settlementId] })], [card.settlementId]);

    const off = await sync(false);
    assert.deepEqual(off.pending.map((row) => row.settlementId), [card.settlementId], "only the one asked for");

    // Its evidence cannot be read (synthetic bytes): handed to the person, then sent again by the owner.
    const { openAmuxDmOwnerSettlementCards, recordAmuxDmOwnerSettlementsUnfilable, withAmuxDbBoundary,
      AMUX_DB_BOUNDARIES } = await services();
    const opened = await openAmuxDmOwnerSettlementCards(off);
    assert.deepEqual(opened.unfilable, [card.settlementId]);
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementHandoff,
      (inner, context) => recordAmuxDmOwnerSettlementsUnfilable(inner,
        { settlementIds: opened.unfilable, now: context.dbNow }));
    assert.deepEqual((await sync(false)).pending, []);
    assert.deepEqual(await press({ action: "resend", sourceId: card.settlementId }),
      { outcome: "done", settlementId: card.settlementId });
    const resent = await settlementRow(tx, card.settlementId);
    assert.equal(resent?.handoffReason, null);
    assert.equal(resent?.handoffAt, null);
    assert.deepEqual((await sync(false)).pending.map((row) => row.settlementId), [card.settlementId]);
    assert.deepEqual(await press({ action: "resend", sourceId: card.settlementId }),
      { outcome: "refused", reason: "not_resendable" }, "nothing left to send again");
  });
});

test("the owner queue names, per card, where the Decision Maker stands and what the owner may press", async () => {
  await lifecycle(async (tx) => {
    const card = await stoppedTask(tx);
    const saved = { routing: process.env.TOMVERSE_AMUX_DM_ROUTING, settlement: process.env.TOMVERSE_AMUX_DM_OWNER_SETTLEMENT };
    process.env.TOMVERSE_AMUX_DM_ROUTING = "enabled";
    delete process.env.TOMVERSE_AMUX_DM_OWNER_SETTLEMENT;
    try {
      const { readAmuxOwnerQueueDmStatus } = await import("@/lib/amux/ownerQueueDmStatusRead");
      const { recordAmuxDmRelaySync } = await import("@/lib/amux/dmRelayHeartbeat");
      const { AMUX_DM_RELAY_LAST_SYNC_KEY } = await import("@/lib/amux/dmRelayHeartbeatCore");
      const before = await readAmuxOwnerQueueDmStatus([{ taskId: card.taskId, escalationId: card.escalationId }]);
      assert.deepEqual(before.byTask.get(card.taskId), { source: "settlement", state: "switch_off", reason: "settlement",
        requestId: null, action: "request", sourceId: card.escalationId });
      await recordAmuxDmRelaySync();
      await recordAmuxDmRelaySync();
      const rows = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS "n" FROM "AppSetting" WHERE "key" = ${AMUX_DM_RELAY_LAST_SYNC_KEY}`;
      assert.equal(rows[0]!.n, 1);
      const after = await readAmuxOwnerQueueDmStatus([{ taskId: card.taskId, escalationId: card.escalationId }]);
      assert.equal(after.relay.state, "live");
      const { requestAmuxOwnerQueueDm } = await import("@/lib/amux/ownerQueueDmRequestService");
      await requestAmuxOwnerQueueDm({ session: operator(), request: new Request("https://tomverse.app/x"),
        taskId: card.taskId, source: "settlement", action: "request", sourceId: card.escalationId });
      const requested = await readAmuxOwnerQueueDmStatus([{ taskId: card.taskId, escalationId: card.escalationId }]);
      assert.deepEqual([requested.byTask.get(card.taskId)?.state, requested.byTask.get(card.taskId)?.action],
        ["waiting_relay", null]);
      // Its card filed, and no DM request for it yet: the ledger read runs and finds none.
      await tx.$executeRaw`UPDATE "AmuxDmOwnerSettlement" SET "localCardId" = ${"OS-" + card.taskId.slice(0, 8)}
        WHERE "id" = ${card.settlementId}`;
      const filed = await readAmuxOwnerQueueDmStatus([{ taskId: card.taskId, escalationId: card.escalationId }]);
      assert.deepEqual([filed.byTask.get(card.taskId)?.state, filed.byTask.get(card.taskId)?.requestId],
        ["card_filed", null]);
    } finally {
      for (const [name, value] of [["TOMVERSE_AMUX_DM_ROUTING", saved.routing],
        ["TOMVERSE_AMUX_DM_OWNER_SETTLEMENT", saved.settlement]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
