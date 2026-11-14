import assert from "node:assert/strict";
import { after, test } from "node:test";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// AMUX process audit bundle 2 (AMUXFLOW/B2), on PostgreSQL with every trigger
// on: a todo Task whose attempt budget is spent (AMUX-GENFILE-002, 162 h on
// no screen) moves to blocked with an open escalation, so the owner queue and
// the Decision Maker's settlement see it; a second sweep does nothing.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-stalled-card-sweep-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });

after(async () => { await closeLifecycleHarness(); });

async function spentTodoCard(tx: LifecycleTx) {
  const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx),
    { taskRole: "implement", settlementReason: "review_server_accepted" }) as {
    taskId: string; priorAttemptId: string };
  // The fixture leaves the card after one settled run; the budget is spent
  // as production's was: five attempts, the card back in todo, unassigned.
  await withoutTriggers(tx, async () => {
    await tx.$executeRaw`UPDATE "AmuxExecutionAttempt" SET "attemptNumber" = 5
      WHERE "id" = ${seed.priorAttemptId}`;
    await tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'todo', "owner" = NULL,
      "v22AssignmentId" = NULL WHERE "id" = ${seed.taskId}`;
    await tx.$executeRaw`UPDATE "AmuxHumanEscalation" SET "status" = 'resolved'
      WHERE "taskId" = ${seed.taskId} AND "status" IN ('open', 'acknowledged')`;
  });
  await fixtureCommitted(tx);
  return seed.taskId;
}

test("a todo Task with its budget spent joins the owner queue once, with its reason", async () => {
  await lifecycle(async (tx) => {
    const taskId = await spentTodoCard(tx);
    const { readAmuxStalledCards, sweepAmuxStalledCards, AMUX_STALLED_CARD_SWEEP_ENV } =
      await import("@/lib/amux/stalledCardSweep");
    assert.deepEqual(await sweepAmuxStalledCards(), [], "off by default");
    const found = await readAmuxStalledCards(tx, 20);
    assert.ok(found.some((row) => row.id === taskId && row.reason === "attempt_budget_exhausted"));

    process.env[AMUX_STALLED_CARD_SWEEP_ENV] = "enabled";
    try {
      const moved = await sweepAmuxStalledCards(20);
      assert.ok(moved.includes(taskId), JSON.stringify(moved));
      const card = await tx.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId },
        select: { status: true, owner: true } });
      assert.equal(card.status, "blocked");
      const escalation = await tx.amuxHumanEscalation.findFirstOrThrow({
        where: { taskId, status: "open" }, select: { reason: true, openedBy: true } });
      assert.deepEqual(escalation, { reason: "attempt_budget_exhausted",
        openedBy: "system:amux-stalled-card-sweep" });
      const audit = await tx.adminAuditLog.findFirstOrThrow({
        where: { action: "amux.v22.stalled_card.blocked", targetId: taskId } });
      assert.equal((audit.metadata as { reason?: string }).reason, "attempt_budget_exhausted");
      assert.ok(!(await sweepAmuxStalledCards(20)).includes(taskId), "a card in the queue is left alone");
    } finally {
      delete process.env[AMUX_STALLED_CARD_SWEEP_ENV];
    }
  });
});
