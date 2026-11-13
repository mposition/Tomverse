import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Session } from "next-auth";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// The AMUX owner queue through the Decision Maker (owner decision 2026-11-13),
// on PostgreSQL with every migration trigger on: a stopped v22 Task is filed
// once per escalation, its answer is applied as the system through the
// statement-bounded transactions, a review pull request's approval is only
// recorded, and a Task that moved cancels instead. No TEST_DATABASE_URL: not
// executed.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-dm-owner-settlement-audit-key-2026";
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
  Awaited<ReturnType<typeof services>>["applyAmuxDmOwnerSettlementDecision"]>[1]["answer"],
  remake?: { ideaId: string } | { refused: string }) {
  const { withAmuxDbBoundary, AMUX_DB_BOUNDARIES, applyAmuxDmOwnerSettlementDecision } = await services();
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementDecision(tx, { settlementId, answer, source: "dm",
      requestId: `req-${randomUUID().slice(0, 8)}`, now: context.dbNow, remake }));
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

test("remake closes the card and the unstarted cards waiting on it, and names the idea filed for them", async () => {
  await lifecycle(async (tx) => {
    const ids = { waiting: randomUUID(), chained: randomUUID(), started: randomUUID(), unrelated: randomUUID() };
    const card = await stoppedTask(tx, { afterSettlement: remakeSiblings(ids) });
    const rows = await sync(true);
    const siblings = rows.siblings.filter((row) => row.forTaskId === card.taskId);
    assert.equal(siblings.length, 4, "the cards under the same parent come with its card");
    assert.deepEqual(siblings.filter((row) => row.waitsOnThis).map((row) => row.id).sort(),
      [ids.waiting, ids.started].sort());

    const refused = await apply(card.settlementId, { decision: "remake", ideaText: "One card" }, { refused: "intake_disabled" });
    assert.deepEqual(refused, { applied: false, outcome: "handed_off" }, "no idea, no close");
    assert.equal((await taskRow(tx, card.taskId)).archivedAt, null);
  });
  await lifecycle(async (tx) => {
    const ids = { waiting: randomUUID(), chained: randomUUID(), started: randomUUID(), unrelated: randomUUID() };
    const card = await stoppedTask(tx, { afterSettlement: remakeSiblings(ids) });
    await sync(true);
    const ideaId = randomUUID();
    assert.deepEqual(await apply(card.settlementId, { decision: "remake", ideaText: "One card" }, { ideaId }),
      { applied: true, outcome: "remade" });
    for (const id of [card.taskId, ids.waiting, ids.chained])
      assert.ok((await taskRow(tx, id)).archivedAt, `${id} is closed`);
    for (const id of [ids.started, ids.unrelated])
      assert.equal((await taskRow(tx, id)).archivedAt, null, `${id} is left: started, or not waiting on it`);
    const row = await settlementRow(tx, card.settlementId);
    assert.equal(row?.decision, "remake");
    assert.equal(row?.remakeIdeaId, ideaId);
    const audit = await appliedAudit(tx, card.taskId);
    assert.deepEqual((audit?.metadata as { closedTaskIds: string[] }).closedTaskIds,
      [card.taskId, ids.waiting, ids.chained].sort());
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
    assert.equal(await refusedBy("AmuxDmOwnerSettlement_state_check", () => tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'applied', "decision" = 'remake', "answerSource" = 'dm',
        "requestId" = 'r', "decidedAt" = now() WHERE "id" = ${card.settlementId}`), true,
      "a remake names its idea");
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
