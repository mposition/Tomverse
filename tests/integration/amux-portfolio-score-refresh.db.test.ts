import assert from "node:assert/strict";
import { after, test } from "node:test";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, lifecycle, queryAdapter, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Owner decision 2026-11-14: a backlog v4 Task whose score is about to lapse
// keeps its place on the promotion list when nothing it was confirmed on has
// changed. The refresher runs through the product's own service, against
// every trigger, and the promotion's candidate read sees the extended score.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-score-refresh-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });

const services = async () => ({
  ...(await import("@/lib/amux/portfolioScoreService")),
});
const digestKey = { digestKeyId: "synthetic", digestKey: Buffer.alloc(32, 7) };
const DAY = 86_400_000;
const STOP = new Error("score refresh fixture stop");

type Score = { id: string; evidenceAsOf: Date; activeStaleAt: Date;
  baselineStaleAt: Date; approvedByUserId: string; approvalAuditLogId: string };

/** The fixture's registered backlog Task, its source approval consumed, with
 * its score's evidence moved back so the active window closes within the
 * refresh lead. The fixture also records a newer Task assessment after that
 * score; `keepNewerAssessment` leaves it (the owner revised the evidence),
 * otherwise it is taken out so the score's inputs are the latest. */
async function dueTask(tx: LifecycleTx, ageMs: number,
  work: (taskId: string, scoreId: string) => Promise<void>,
  keepNewerAssessment = false) {
  try {
    await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
      afterSourceConsumed: async ({ scoreId, newerAssessmentId }:
        { scoreId: string; newerAssessmentId: string }) => {
        const [{ taskId }] = await tx.$queryRaw<Array<{ taskId: string }>>`
          SELECT "taskId" FROM "AmuxPortfolioScoreSnapshot" WHERE "id" = ${scoreId}::uuid`;
        await withoutTriggers(tx, async () => {
          if (!keepNewerAssessment) {
            await tx.$executeRaw`DELETE FROM "AmuxPortfolioAssessment"
              WHERE "id" = ${newerAssessmentId}::uuid`;
          }
          const at = new Date(Date.now() - ageMs);
          await tx.$executeRaw`UPDATE "AmuxPortfolioAssessment" SET "evidenceAsOf" = ${at}
            WHERE "id" IN (SELECT unnest(ARRAY["initiativeAssessmentId", "epicAssessmentId",
              "featureAssessmentId", "taskAssessmentId"]) FROM "AmuxPortfolioScoreSnapshot"
              WHERE "id" = ${scoreId}::uuid)`;
          await tx.$executeRaw`UPDATE "AmuxPortfolioScoreSnapshot" SET "evidenceAsOf" = ${at},
            "activeStaleAt" = ${new Date(at.getTime() + 7 * DAY)},
            "baselineStaleAt" = ${new Date(at.getTime() + 28 * DAY)}
            WHERE "id" = ${scoreId}::uuid`;
        });
        await work(taskId, scoreId);
        // The rest of the seed walks the Task past backlog; this test is done.
        throw STOP;
      },
    });
  } catch (error) {
    if (error !== STOP) throw error;
  }
}

const newest = async (tx: LifecycleTx, taskId: string) => (await tx.$queryRaw<Score[]>`
  SELECT "id"::text, "evidenceAsOf", "activeStaleAt", "baselineStaleAt",
    "approvedByUserId", "approvalAuditLogId" FROM "AmuxPortfolioScoreSnapshot"
  WHERE "taskId" = ${taskId} ORDER BY "computedAt" DESC, "id" DESC LIMIT 1`)[0];

test("an unchanged score is extended by the system refresher, once, within its baseline", async () => {
  const { readDueAmuxPortfolioScoreTaskIds, refreshAmuxPortfolioScoreInTx } = await services();
  await lifecycle(async (tx) => {
    // Evidence six and a half days old: the window closes in twelve hours.
    await dueTask(tx, 6.5 * DAY, async (taskId, scoreId) => {
      const before = await newest(tx, taskId);
      assert.equal(before.id, scoreId);
      assert.deepEqual(await readDueAmuxPortfolioScoreTaskIds(tx), [taskId]);

      const outcome = await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey });
      assert.equal(outcome.state, "refreshed", JSON.stringify(outcome));
      const after = await newest(tx, taskId);
      assert.notEqual(after.id, scoreId);
      // The evidence's age and baseline are the confirmed ones; only the
      // active window moved, to seven days past now.
      assert.equal(after.evidenceAsOf.getTime(), before.evidenceAsOf.getTime());
      assert.equal(after.baselineStaleAt.getTime(), before.baselineStaleAt.getTime());
      assert.ok(Math.abs(after.activeStaleAt.getTime() - (Date.now() + 7 * DAY)) < 60_000);
      assert.equal(after.approvedByUserId, before.approvedByUserId);
      const [audit] = await tx.$queryRaw<Array<{ action: string; actorUserId: string | null;
        systemActor: string | null; targetId: string; entryHash: string | null }>>`
        SELECT "action", "actorUserId", "metadata"->>'systemActor' AS "systemActor",
          "targetId", "entryHash" FROM "AdminAuditLog" WHERE "id" = ${after.approvalAuditLogId}`;
      assert.deepEqual({ ...audit, entryHash: /^[a-f0-9]{64}$/.test(audit.entryHash ?? "") }, {
        action: "amux.v4.portfolio.score.refresh", actorUserId: null,
        systemActor: "amux-portfolio-scorer", targetId: after.id, entryHash: true });

      // Not due again for six days: a second pass writes nothing.
      assert.deepEqual(await readDueAmuxPortfolioScoreTaskIds(tx), []);
      assert.deepEqual(await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey }),
        { state: "skipped", taskId, reason: "not_due" });
      assert.equal((await newest(tx, taskId)).id, after.id);

      // The v22 promotion's own candidate read accepts the extended score.
      const [candidate] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT s."id"::text FROM "AmuxPortfolioScoreSnapshot" s
        WHERE s."taskId" = ${taskId} AND s."activeStaleAt" > clock_timestamp() AT TIME ZONE 'UTC'
        ORDER BY s."computedAt" DESC, s."id" DESC LIMIT 1`;
      assert.equal(candidate?.id, after.id);
    });
  });
});

test("a score at its baseline, or whose assessment the owner replaced, waits for the owner", async () => {
  const { readDueAmuxPortfolioScoreTaskIds, refreshAmuxPortfolioScoreInTx } = await services();
  await lifecycle(async (tx) => {
    // Evidence 27.5 days old, its active window long closed (as on the
    // stopped board): reopened, but only up to the 28-day baseline.
    await dueTask(tx, 27.5 * DAY, async (taskId) => {
      const before = await newest(tx, taskId);
      assert.ok(before.activeStaleAt.getTime() < Date.now() - 20 * DAY);
      assert.equal((await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey })).state,
        "refreshed");
      const capped = await newest(tx, taskId);
      assert.equal(capped.activeStaleAt.getTime(), before.baselineStaleAt.getTime());
      // Its window now ends at the baseline itself: nothing left to extend.
      assert.deepEqual(await readDueAmuxPortfolioScoreTaskIds(tx), []);
      assert.deepEqual(await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey }),
        { state: "skipped", taskId, reason: "not_due" });
    });
  });
  await lifecycle(async (tx) => {
    // The owner's newer Task assessment stays: the next score is the owner's
    // to confirm, so the refresher neither lists nor writes one.
    await dueTask(tx, 6.5 * DAY, async (taskId, scoreId) => {
      assert.deepEqual(await readDueAmuxPortfolioScoreTaskIds(tx), []);
      assert.deepEqual(await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey }),
        { state: "skipped", taskId, reason: "input_changed" });
      assert.equal((await newest(tx, taskId)).id, scoreId);
    }, true);
  });
  await lifecycle(async (tx) => {
    // The parent Feature was revised after its assessment: the refresher would
    // refuse it, so it holds no place in the list ahead of Tasks it can extend.
    await dueTask(tx, 6.5 * DAY, async (taskId, scoreId) => {
      await withoutTriggers(tx, async () => {
        await tx.$executeRaw`UPDATE "AmuxPortfolioNode" SET "revision" = "revision" + 1
          WHERE "id" = (SELECT "parentFeatureNodeId" FROM "AmuxWorkItem" WHERE "id" = ${taskId})`;
      });
      assert.deepEqual(await readDueAmuxPortfolioScoreTaskIds(tx), []);
      assert.deepEqual(await refreshAmuxPortfolioScoreInTx(tx, { taskId, digestKey }),
        { state: "skipped", taskId, reason: "not_ready" });
      assert.equal((await newest(tx, taskId)).id, scoreId);
    });
  });
});

after(closeLifecycleHarness);
