import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, fixtureCommitted, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Owner decision 2026-11-15, on PostgreSQL with every migration trigger on:
// a worker whose CLI exits right after start, again and again (both Cursor
// workers, 2026-11-15, AMUX-SCHEDJOBS-003 spent five attempts in twenty
// minutes). The card keeps its attempts, the next claim prefers the other
// worker, the failing worker is quarantined, and it comes back once its usage
// is read again. Why the card waits, and what the box says about the worker's
// sign-in, are stored for Admin.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-infra-failure-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });

const services = async () => ({
  ...(await import("@/lib/amux/infraFailureStore")),
  ...(await import("@/lib/amux/workerHealthStore")),
  ...(await import("@/lib/amux/cardWaitReasonStore")),
  ...(await import("@/lib/amux/v22WorkerUsageGate")),
  ...(await import("@/lib/amux/executionBudgetCore")),
  ...(await import("@/lib/amux/v22WorkerClaimCore")),
});

after(async () => { await closeLifecycleHarness(); });

/**
 * A second card the seed's workers ran (the seed's own card is the FIRST
 * Task, which the database allows two attempts at most), with one ended run
 * on worker-one whose result was the card's own.
 */
async function secondCard(tx: LifecycleTx, seedTaskId: string) {
  const taskId = randomUUID();
  const [instance] = await tx.$queryRaw<Array<{ instanceId: string }>>`
    SELECT "instanceId" FROM "AmuxWorkerRuntime" WHERE "workerName" = 'worker-one'`;
  await withoutTriggers(tx, async () => {
    // A copy of the seed's card under its own identity, so every shape check holds.
    await tx.$executeRaw`INSERT INTO "AmuxWorkItem"
      SELECT (jsonb_populate_record(NULL::"AmuxWorkItem", to_jsonb(w) || jsonb_build_object(
        'id', ${taskId}::text, 'sourceKey', ${`INFRA-${taskId.slice(0, 8).toUpperCase()}`}::text,
        'displayKey', NULL, 'status', 'blocked', 'owner', NULL, 'claimedAt', NULL,
        'v22AssignmentId', NULL, 'v22ReceiptId', NULL))).*
      FROM "AmuxWorkItem" w WHERE w."id" = ${seedTaskId}`;
    await tx.$executeRaw`INSERT INTO "AmuxExecutionAttempt"
      ("id", "taskId", "worker", "workerInstanceId", "workerGeneration", "taskRevision",
       "attemptNumber", "reservedCostMicrousd", "heartbeatAt", "startedAt", "endedAt",
       "outcome", "toStatus", "endedBy", "reason", "updatedAt")
      VALUES (${randomUUID()}, ${taskId}, 'worker-one', ${instance!.instanceId}, 1, 3, 1, 1000, now(),
        now() - interval '30 minutes', now() - interval '20 minutes',
        'failed', 'todo', 'worker-one', 'reported_result', now())`;
  });
  return taskId;
}

/** Ended runs of the card on worker-two that never did its work. */
async function earlyExits(tx: LifecycleTx, taskId: string, minutesAgo: number[]) {
  const [instance] = await tx.$queryRaw<Array<{ instanceId: string }>>`
    SELECT "instanceId" FROM "AmuxWorkerRuntime" WHERE "workerName" = 'worker-two'`;
  const numbers = await tx.$queryRaw<Array<{ greatest: number | null }>>`
    SELECT MAX("attemptNumber") AS "greatest" FROM "AmuxExecutionAttempt" WHERE "taskId" = ${taskId}`;
  let next = (numbers[0]?.greatest ?? 0) + 1;
  await withoutTriggers(tx, async () => {
    for (const minutes of minutesAgo) {
      await tx.$executeRaw`INSERT INTO "AmuxExecutionAttempt"
        ("id", "taskId", "worker", "workerInstanceId", "workerGeneration", "taskRevision",
         "attemptNumber", "reservedCostMicrousd", "heartbeatAt", "startedAt", "endedAt",
         "outcome", "toStatus", "endedBy", "reason", "updatedAt")
        VALUES (${randomUUID()}, ${taskId}, 'worker-two', ${instance!.instanceId}, 1, 3, ${next},
          1000, now(), now() - make_interval(mins => ${minutes + 1}), now() - make_interval(mins => ${minutes}),
          'blocked', 'todo', 'worker-two', 'infra_early_exit', now())`;
      next += 1;
    }
  });
}

test("a worker that exits right after start: attempts kept, other worker first, quarantine, then back", async () => {
  await lifecycle(async (tx) => {
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx),
      { taskRole: "investigate" }) as { taskId: string };
    const taskId = await secondCard(tx, seed.taskId);
    await earlyExits(tx, taskId, [3, 2, 1]);
    await fixtureCommitted(tx);
    const s = await services();

    // The card's attempts: four rows, three of them the platform's.
    const facts = await s.readAmuxAttemptBudgetFacts(tx, taskId);
    assert.equal(facts.historicalRows, 4);
    assert.equal(facts.infraRows, 3);
    assert.equal(facts.reservedMicrousd, BigInt(4_000));
    const budget = s.decideAmuxAttemptBudget({ historical_rows: facts.historicalRows,
      greatest_attempt_number: facts.greatestAttemptNumber, infra_rows: facts.infraRows });
    assert.equal(budget.allowed, true);
    assert.equal((budget as { next_attempt_number: number }).next_attempt_number, 5,
      "the number stays unique; the count is the card's own");
    assert.deepEqual(await s.countAmuxInfraAttemptsBefore(tx, taskId, randomUUID()),
      { total: 3, window: 3 });
    assert.deepEqual(await s.readAmuxRecentResultSignatures(tx, taskId, randomUUID(), 2),
      ["failed:reported_result"], "an infrastructure failure is never a repeat of the card's own result");

    // The next claim tries the other worker first.
    const failedOn = await s.recentAmuxInfraFailureWorkers(tx, taskId);
    assert.deepEqual(failedOn, ["worker-two"]);
    const route = (workerName: string, provider: string) => ({ routeId: `route-${workerName}`, workerName,
      provider, modelId: "model", routePolicyDigest: "d".repeat(64), perAttemptMicroUsd: "1000" });
    const chosen = s.chooseAmuxV22WorkerRoute({ routes: [route("worker-two", "cursor"), route("worker-one", "openai")],
      priorAuthorWorkers: [], priorAuthorProviders: [], isReview: false,
      infraFailedWorkers: failedOn, infraFailedProviders: ["cursor"] });
    assert.equal(chosen?.workerName, "worker-one");

    // Its unknown usage holds no worker, and no person has to accept it.
    assert.equal(await s.amuxV22WorkerUsageUnverified(tx, "worker-two", null, randomUUID(), true), false);

    // worker-two is out for a while; worker-one is not.
    const now = new Date();
    const circuits = await s.readAmuxWorkerCircuits(tx, ["worker-one", "worker-two"], now);
    assert.equal(circuits.get("worker-one")?.state, "closed");
    const open = circuits.get("worker-two");
    assert.equal(open?.state, "open");
    assert.equal(open?.state === "open" && open.lastKind, "early_exit");

    // Its usage is read again after the last failure: one card may try it.
    await tx.amuxQuotaObservation.create({ data: { worker: "worker-two", provider: "cursor",
      remainingBasisPoints: 9_000, confidenceBasisPoints: 10_000, exhausted: false,
      source: "provider_api", observedAt: new Date(now.getTime() + 1_000) } });
    assert.equal((await s.readAmuxWorkerCircuits(tx, ["worker-two"], now)).get("worker-two")?.state, "probing");

    // Admin sees the quarantine, the usage reading and the box's sign-in signal.
    await s.recordAmuxWorkerHealthSignals("worker-two", [{ source: "login_keepalive", signal: "relogin_soon",
      observedAt: now, expiresAt: new Date(now.getTime() + 20 * 3_600_000) }], now);
    const views = await s.readAmuxWorkerHealthViews(["worker-two"], now, tx);
    assert.equal(views["worker-two"]?.circuit.state, "probing");
    assert.equal(views["worker-two"]?.usage.state, "fresh");
    assert.deepEqual(views["worker-two"]?.signals.map((signal) => signal.signal), ["relogin_soon"]);
    // A repeated signal is not raised again.
    const [signal] = await tx.$queryRaw<Array<{ reportedAt: Date | null }>>`
      SELECT "reportedAt" FROM "AmuxWorkerHealthSignal" WHERE "workerName" = 'worker-two'`;
    assert.ok(signal?.reportedAt);
  });
});

test("platform failures have no bound: the card stays claimable and only waits longer", async () => {
  // Owner decision 2026-11-16: twelve used to hand the card to a person. The
  // failures keep their reason (so they are counted for the wait) and use none
  // of the card's attempts.
  await lifecycle(async (tx) => {
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx),
      { taskRole: "investigate" }) as { taskId: string };
    const taskId = await secondCard(tx, seed.taskId);
    await earlyExits(tx, taskId, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await fixtureCommitted(tx);
    const s = await services();
    const { amuxInfraRetryDelayMs } = await import("@/lib/amux/infraFailureCore");
    const facts = await s.readAmuxAttemptBudgetFacts(tx, taskId);
    assert.equal(facts.historicalRows, 13);
    assert.equal(facts.infraRows, 12);
    assert.equal(facts.infraWindowRows, 12);
    assert.equal(facts.lastEndedIsInfra, true);
    assert.ok(facts.lastEndedAt instanceof Date);
    const budget = s.decideAmuxAttemptBudget({ historical_rows: facts.historicalRows,
      greatest_attempt_number: facts.greatestAttemptNumber, infra_rows: facts.infraRows });
    assert.deepEqual(budget, { allowed: true, next_attempt_number: 14,
      max_attempts: s.AMUX_MAX_EXECUTION_ATTEMPTS });
    // The wait doubles from a minute and holds at an hour.
    assert.equal(amuxInfraRetryDelayMs(facts.infraWindowRows), 60 * 60_000);
    // A person's retry starts the count of the wait over; the earlier failures
    // still use none of the card's attempts.
    await withoutTriggers(tx, async () => {
      await tx.$executeRaw`INSERT INTO "AmuxHumanEscalation"
        ("id", "taskId", "specialty", "reason", "status", "openedBy", "resolvedById",
         "resolvedAt", "resolution", "resolutionOutcome", "updatedAt")
        VALUES (${randomUUID()}, ${taskId}, 'execution-recovery', 'infra_attempts_exhausted',
          'resolved', 'system:amux-v22-settlement', 'synthetic-owner', now(),
          'Signed the worker in again.', 'retry', now())`;
    });
    const after = await s.readAmuxAttemptBudgetFacts(tx, taskId);
    assert.equal(after.infraRows, 12);
    assert.equal(after.infraWindowRows, 0);
    assert.equal(amuxInfraRetryDelayMs(after.infraWindowRows), 0);
    assert.deepEqual(await s.countAmuxInfraAttemptsBefore(tx, taskId, randomUUID()),
      { total: 12, window: 0 });
  });
});

test("why a card waits is stored per card, kept while it lasts and cleared when it is claimed", async () => {
  await lifecycle(async (tx) => {
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx),
      { taskRole: "investigate" }) as { taskId: string };
    await fixtureCommitted(tx);
    const s = await services();
    const t0 = new Date();
    await s.recordAmuxCardWaitReasons([{ taskId: seed.taskId, stage: "claim", code: "task_not_ready",
      detail: { reasons: ["dependency_unpublished"] } }], t0);
    let row = (await s.readAmuxCardWaitReasons([seed.taskId])).get(seed.taskId);
    assert.deepEqual([row?.code, row?.detail], ["task_not_ready", { reasons: ["dependency_unpublished"] }]);
    // The same reason later keeps when it began.
    const t1 = new Date(t0.getTime() + 6 * 60_000);
    await s.recordAmuxCardWaitReasons([{ taskId: seed.taskId, stage: "claim", code: "task_not_ready",
      detail: { reasons: ["dependency_unpublished"] } }], t1);
    row = (await s.readAmuxCardWaitReasons([seed.taskId])).get(seed.taskId);
    assert.equal(row?.firstSeenAt.getTime(), t0.getTime());
    assert.equal(row?.lastSeenAt.getTime(), t1.getTime());
    assert.equal(row?.seenCount, 2);
    // Another reason starts again; its route detail names each worker's cause.
    await s.recordAmuxCardWaitReasons([{ taskId: seed.taskId, stage: "claim", code: "worker_quarantined",
      detail: { routes: [{ worker: "worker-two", provider: "cursor", why: "quarantined" }] } }], t1);
    row = (await s.readAmuxCardWaitReasons([seed.taskId])).get(seed.taskId);
    assert.equal(row?.firstSeenAt.getTime(), t1.getTime());
    assert.deepEqual(row?.detail.routes, [{ worker: "worker-two", provider: "cursor", why: "quarantined" }]);
    await s.clearAmuxCardWaitReasons([seed.taskId]);
    assert.equal((await s.readAmuxCardWaitReasons([seed.taskId])).size, 0);
    // A code outside the vocabulary is never stored.
    await s.recordAmuxCardWaitReasons([{ taskId: seed.taskId, stage: "claim", code: "Free text", detail: {} }], t1);
    assert.equal((await s.readAmuxCardWaitReasons([seed.taskId])).size, 0);
  });
});
