import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("Prompt Refiner product Auto operational latch on PostgreSQL",
  { skip: !rawUrl }, async t => {
    if (!rawUrl) return;
    const url = new URL(rawUrl);
    assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    const schema = `refiner_operational_${randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString: rawUrl });
    const pool = new pg.Pool({ connectionString: rawUrl, max: 2 });
    await client.connect();
    const query = (db: pg.PoolClient, strings: TemplateStringsArray,
      values: unknown[]) => db.query(strings.reduce((sql, part, index) =>
      sql + part + (index < values.length ? `$${index + 1}` : ""), ""), values);
    type TestTimeZone = "UTC" | "Australia/Brisbane" |
      "America/Los_Angeles";
    type TestTx = {
      $queryRaw: (strings: TemplateStringsArray,
        ...values: unknown[]) => Promise<unknown[]>;
      $executeRaw: (strings: TemplateStringsArray,
        ...values: unknown[]) => Promise<number>;
    };
    const transactionAtTimeZone = async <T>(timeZone: TestTimeZone,
      work: (tx: TestTx) => Promise<T>, rollback = false) => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query(`SET LOCAL search_path TO "${schema}"`);
        await db.query(`SET LOCAL TIME ZONE '${timeZone}'`);
        const result = await work({
          $queryRaw: async (strings, ...values) =>
            (await query(db, strings, values)).rows,
          $executeRaw: async (strings, ...values) =>
            (await query(db, strings, values)).rowCount ?? 0,
        });
        await db.query(rollback ? "ROLLBACK" : "COMMIT"); return result;
      } catch (error) {
        await db.query("ROLLBACK"); throw error;
      } finally { db.release(); }
    };
    const transaction = <T>(work: (tx: TestTx) => Promise<T>) =>
      transactionAtTimeZone("UTC", work);
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE "AdminAuditLog" (
          "id" TEXT PRIMARY KEY, "action" TEXT NOT NULL,
          "targetType" TEXT NOT NULL, "targetId" TEXT
        );
        CREATE TABLE "PromptRefinerProductAttempt" (
          "id" TEXT PRIMARY KEY, "mode" TEXT NOT NULL, "state" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT
            (clock_timestamp() AT TIME ZONE 'UTC'),
          "expiresAt" TIMESTAMP(3) NOT NULL
        );
        CREATE TABLE "PromptRefinerAutoBudgetHold" (
          "id" TEXT PRIMARY KEY, "requestKey" TEXT NOT NULL,
          "status" TEXT NOT NULL, "dispatchedAt" TIMESTAMPTZ,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );
        CREATE INDEX "PromptRefinerAutoBudgetHold_status_createdAt_idx"
          ON "PromptRefinerAutoBudgetHold" ("status", "createdAt");
        CREATE TABLE "PromptRefinerProductExecutionReceipt" (
          "id" TEXT PRIMARY KEY, "requestId" TEXT,
          "outcome" TEXT NOT NULL,
          "failureCode" TEXT, "preparationLatencyMs" INTEGER NOT NULL,
          "completedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE "PromptRefinerProductExecutionContext" (
          "executionReceiptId" TEXT PRIMARY KEY, "mode" TEXT NOT NULL
        );
        CREATE TABLE "PromptRefinerProductDispositionReceipt" (
          "id" TEXT PRIMARY KEY, "executionReceiptId" TEXT NOT NULL,
          "outcome" TEXT NOT NULL,
          "observedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );
      `);
      await client.query(await readFile(resolve(root,
        "prisma/migrations/20261010123000_prompt_refiner_product_attempt_state_created_at/migration.sql"),
      "utf8"));
      const attemptStateIndex = await client.query(`SELECT indexdef
        FROM pg_indexes WHERE schemaname = $1 AND
          indexname = 'PromptRefinerProductAttempt_state_createdAt_idx'`,
      [schema]);
      assert.equal(attemptStateIndex.rowCount, 1);
      assert.match(attemptStateIndex.rows[0].indexdef,
        /USING btree \(state, "createdAt"\)$/);
      await client.query(await readFile(resolve(root,
        "prisma/migrations/20261010120000_prompt_refiner_product_operational_guard/migration.sql"),
      "utf8"));
      let auditLockCount = 0;
      mock.module(mod("lib/adminAudit.ts"), { namedExports: {
        takeAuditChainLock: async (tx: {
          $executeRaw: (strings: TemplateStringsArray,
            ...values: unknown[]) => Promise<number>;
        }) => {
          auditLockCount += 1;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(
            hashtext('tomverse-admin-audit-chain'))`;
        },
        writeSystemAuditLog: async (input: { tx: {
          $executeRaw: (strings: TemplateStringsArray,
            ...values: unknown[]) => Promise<number>;
        }; action: string; targetType: string; targetId: string }) => {
          const id = randomUUID();
          await input.tx.$executeRaw`INSERT INTO "AdminAuditLog"
            ("id", "action", "targetType", "targetId") VALUES
            (${id}, ${input.action}, ${input.targetType}, ${input.targetId})`;
          return id;
        },
      } });
      mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
        $transaction: transaction,
      } } });
      const guard = await import(mod("lib/promptRefinerProductOperationalGuard.ts"));
      const transitionAudit = async (action: string) => {
        const id = randomUUID();
        await client.query(`INSERT INTO "AdminAuditLog"
          ("id","action","targetType","targetId") VALUES ($1,$2,$3,'auto')`,
        [id, action, "PromptRefinerProductOperationalGuard"]);
        return id;
      };
      const insertReceipt = async (input: { outcome?: string;
        latency?: number; failureCode?: string | null; audited?: boolean;
        requestId?: string; historical?: boolean }) => {
        const id = randomUUID();
        await client.query(`INSERT INTO "PromptRefinerProductExecutionReceipt"
          ("id","requestId","outcome","failureCode","preparationLatencyMs")
          VALUES ($1,$2,$3,$4,$5)`, [id, input.requestId ?? null,
          input.outcome ?? "suggested", input.failureCode ?? null,
          input.latency ?? 10]);
        if (input.historical) {
          await client.query(`UPDATE "PromptRefinerProductExecutionReceipt"
            SET "completedAt" = (SELECT "baselineAt" FROM
              "PromptRefinerProductOperationalGuard" WHERE "id"='auto')
            WHERE "id" = $1`, [id]);
        }
        await client.query(`INSERT INTO "PromptRefinerProductExecutionContext"
          VALUES ($1,'explicit')`, [id]);
        if (input.audited !== false) {
          await client.query(`INSERT INTO "AdminAuditLog"
            ("id","action","targetType","targetId") VALUES
            ($1,'prompt_refiner.product_execution_recorded',
              'PromptRefinerProductExecutionReceipt',$2)`, [randomUUID(), id]);
        }
        return id;
      };
      const insertDisposition = async (executionReceiptId: string,
        outcome: "accepted" | "kept_original") => {
        const id = randomUUID();
        await client.query(`INSERT INTO "PromptRefinerProductDispositionReceipt"
          ("id","executionReceiptId","outcome") VALUES ($1,$2,$3)`,
        [id, executionReceiptId, outcome]);
        await client.query(`INSERT INTO "AdminAuditLog"
          ("id","action","targetType","targetId") VALUES
          ($1,'prompt_refiner.product_disposition_recorded',
            'PromptRefinerProductDispositionReceipt',$2)`, [randomUUID(), id]);
      };
      type GuardState = { active: boolean; generation: number | null;
        reasonCode: string | null; transitionAuditLogId?: string | null };
      const evaluate = (current: { executionReceiptId?: string;
        dispositionReceiptId?: string } = {}) => transaction(async tx => await
        guard.evaluatePromptRefinerProductAutoGuardInTransaction(
          tx as never, current) as GuardState);
      const evaluateAtTimeZone = (timeZone: TestTimeZone, rollback = false) =>
        transactionAtTimeZone(timeZone, async tx => await
          guard.evaluatePromptRefinerProductAutoGuardInTransaction(
            tx as never) as GuardState, rollback);
      const read = () => transaction(async tx => await
        guard.readPromptRefinerProductAutoGuard(tx as never) as GuardState);
      const backdateActiveBaseline = async () => {
        await client.query(`ALTER TABLE "PromptRefinerProductOperationalGuard"
          DISABLE TRIGGER "PromptRefinerProductOperationalGuard_guard"`);
        try {
          await client.query(`UPDATE "PromptRefinerProductOperationalGuard"
            SET "baselineAt" = clock_timestamp() - interval '30 seconds'
            WHERE "id"='auto' AND "state"='active'`);
        } finally {
          await client.query(`ALTER TABLE "PromptRefinerProductOperationalGuard"
            ENABLE TRIGGER "PromptRefinerProductOperationalGuard_guard"`);
        }
      };

      await t.test("the 100-request p90 latch survives rolling success and activation", async () => {
        const activationAuditId = await transitionAudit("activation");
        await transaction(tx => guard.initializePromptRefinerProductAutoGuard(
          tx as never, activationAuditId));
        // Age only the synthetic activation baseline. The protected trigger is
        // restored before any product code runs.
        await backdateActiveBaseline();
        const zonedAttemptId = randomUUID();
        await transactionAtTimeZone("Australia/Brisbane", async tx => {
          await tx.$executeRaw`INSERT INTO "PromptRefinerProductAttempt"
            ("id","mode","state","expiresAt") VALUES
            (${zonedAttemptId},'auto','preparing',
              (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes')`;
        });
        const utcAgeMs = Number((await client.query(`SELECT
          EXTRACT(EPOCH FROM ((clock_timestamp() AT TIME ZONE 'UTC') -
            "createdAt")) * 1000 AS age
          FROM "PromptRefinerProductAttempt" WHERE "id"=$1`,
        [zonedAttemptId])).rows[0].age);
        assert.ok(utcAgeMs >= 0 && utcAgeMs < 2_000,
        `non-UTC writer stored a non-UTC attempt timestamp: ${utcAgeMs}`);
        assert.equal((await evaluateAtTimeZone(
          "Australia/Brisbane", true)).active, true,
        "a fresh UTC-naive attempt must not pause in a positive-offset session");
        await transactionAtTimeZone("America/Los_Angeles", async tx => {
          await tx.$executeRaw`UPDATE "PromptRefinerProductAttempt"
            SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') -
              interval '14 seconds' WHERE "id" = ${zonedAttemptId}`;
        });
        assert.equal((await evaluateAtTimeZone(
          "America/Los_Angeles", true)).active, true,
        "an in-flight attempt has no invented audit deadline");
        await client.query(`DELETE FROM "PromptRefinerProductAttempt"
          WHERE "id" = $1`, [zonedAttemptId]);
        for (let index = 0; index < 100; index += 1) {
          await insertReceipt({ latency: 6_001 });
        }
        const paused = await evaluate();
        assert.deepEqual({ active: paused.active, reasonCode: paused.reasonCode },
          { active: false, reasonCode: "latency_p90_exceeded" });
        const pauseReadback = (await client.query(`SELECT "reasonCode",
          "sampleSize", "p90LatencyMs", "fallbackCount",
          "lastTransitionAuditLogId" FROM
          "PromptRefinerProductOperationalGuard" WHERE "id"='auto'`)).rows[0];
        assert.deepEqual({ reasonCode: pauseReadback.reasonCode,
          sampleSize: pauseReadback.sampleSize,
          p90LatencyMs: pauseReadback.p90LatencyMs,
          fallbackCount: pauseReadback.fallbackCount }, {
          reasonCode: "latency_p90_exceeded", sampleSize: 100,
          p90LatencyMs: 6_001, fallbackCount: 0 });
        assert.equal((await client.query(`SELECT count(*)::int AS n FROM
          "AdminAuditLog" WHERE "id"=$1
            AND "action"='prompt_refiner.product_auto_paused'`,
        [pauseReadback.lastTransitionAuditLogId])).rows[0].n, 1);
        for (let index = 0; index < 100; index += 1) {
          await insertReceipt({ latency: 10 });
        }
        assert.equal((await evaluate()).active, false);
        auditLockCount = 0;
        assert.equal((await evaluate()).active, false);
        await transaction(tx => guard.latchPromptRefinerProductAutoStopInTransaction(
          tx as never, "audit_failure"));
        assert.equal(auditLockCount, 0,
        "a paused guard read must not reacquire the global audit lock");
        const secondActivation = await transitionAudit("activation");
        const initialized = await transaction(async tx => await
          guard.initializePromptRefinerProductAutoGuard(tx as never,
            secondActivation) as { initialized: boolean });
        assert.equal(initialized.initialized, false);
        assert.equal((await read()).active, false);
      });

      await t.test("only an exact owner-audit generation transition resumes", async () => {
        const current = await read();
        const resumeAuditId = await transitionAudit("owner-resume");
        await assert.rejects(transaction(tx =>
          guard.resumePromptRefinerProductAutoGuardInTransaction(tx as never, {
            expectedGeneration: (current.generation ?? 0) + 1,
            resumeAuditLogId: resumeAuditId })), /resume_stale/);
        const resumed = await transaction(tx =>
          guard.resumePromptRefinerProductAutoGuardInTransaction(tx as never, {
            expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        assert.deepEqual(resumed, { active: true, generation: 2 });
        assert.deepEqual((await client.query(`SELECT "state", "generation",
          "reasonCode", "sampleSize", "p90LatencyMs", "fallbackCount",
          "lastTransitionAuditLogId" FROM
          "PromptRefinerProductOperationalGuard" WHERE "id"='auto'`)).rows[0], {
          state: "active", generation: 2, reasonCode: null, sampleSize: 0,
          p90LatencyMs: null, fallbackCount: null,
          lastTransitionAuditLogId: resumeAuditId });
        assert.equal((await evaluate()).active, true);
      });

      await t.test("system fallbacks pause while manual kept-original choices do not", async () => {
        for (let index = 0; index < 100; index += 1) {
          const receiptId = await insertReceipt({ outcome: "suggested" });
          if (index < 6) await insertDisposition(receiptId, "kept_original");
        }
        assert.equal((await evaluate()).active, true,
        "manual kept-original choices are dispositions, not system fallbacks");
        for (let index = 0; index < 100; index += 1) {
          await insertReceipt({ outcome: index < 6 ? "failed" : "suggested" });
        }
        const paused = await evaluate();
        assert.equal(paused.reasonCode, "original_fallback_rate_exceeded");
        const row = (await client.query(`SELECT "sampleSize", "fallbackCount"
          FROM "PromptRefinerProductOperationalGuard"`)).rows[0];
        assert.deepEqual(row, { sampleSize: 100, fallbackCount: 6 });
      });

      await t.test("unknown and missing audit facts pause immediately after owner resume", async () => {
        let current = await read();
        let resumeAuditId = await transitionAudit("owner-resume");
        await transaction(tx => guard.resumePromptRefinerProductAutoGuardInTransaction(
          tx as never, { expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        const attemptId = randomUUID();
        await client.query(`INSERT INTO "PromptRefinerProductAttempt"
          ("id","mode","state","expiresAt") VALUES ($1,'auto','unknown',
          clock_timestamp() + interval '5 minutes')`, [attemptId]);
        await insertReceipt({ requestId: attemptId, historical: true });
        for (let index = 0; index < 125; index += 1) {
          await insertReceipt({});
        }
        assert.equal((await evaluate()).reasonCode,
          "unknown_dispatch_or_cost",
          "an unknown attempt remains fail-closed outside latest-100 receipts");

        current = await read();
        resumeAuditId = await transitionAudit("owner-resume");
        await transaction(tx => guard.resumePromptRefinerProductAutoGuardInTransaction(
          tx as never, { expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        for (let index = 0; index < 125; index += 1) {
          await insertReceipt({});
        }
        const criticalReceiptId = await insertReceipt({
          failureCode: "execution_contract_mismatch", historical: true });
        assert.equal((await evaluate({ executionReceiptId: criticalReceiptId }))
          .reasonCode, "critical_safety_failure");

        current = await read();
        resumeAuditId = await transitionAudit("owner-resume");
        await transaction(tx => guard.resumePromptRefinerProductAutoGuardInTransaction(
          tx as never, { expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        await client.query(`DELETE FROM "PromptRefinerAutoBudgetHold"`);
        await client.query(`DELETE FROM "PromptRefinerProductAttempt"`);
        await client.query(`DELETE FROM "PromptRefinerProductExecutionContext"`);
        await client.query(`DELETE FROM "PromptRefinerProductExecutionReceipt"`);
        await backdateActiveBaseline();
        const strandedAttemptId = randomUUID();
        await client.query(`INSERT INTO "PromptRefinerProductAttempt"
          ("id","mode","state","expiresAt") VALUES ($1,'auto','preparing',
          (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes')`,
        [strandedAttemptId]);
        await client.query(`INSERT INTO "PromptRefinerAutoBudgetHold"
          ("id","requestKey","status") VALUES ($1,$2,'settled')`,
        [randomUUID(), strandedAttemptId]);
        assert.equal((await evaluate()).active, true);
        await client.query(`UPDATE "PromptRefinerProductAttempt"
          SET "createdAt" = (clock_timestamp() AT TIME ZONE 'UTC') -
            interval '14 seconds'
          WHERE "id" = $1`, [strandedAttemptId]);
        assert.equal((await evaluate()).active, true,
        "settlement may complete before receipt audit cleanup acquires its lock");
        await client.query(`INSERT INTO "PromptRefinerAutoBudgetHold"
          ("id","requestKey","status","dispatchedAt")
          VALUES ($1,$2,'dispatching',clock_timestamp() - interval '14 seconds')`,
        [randomUUID(), randomUUID()]);
        assert.equal((await evaluate()).reasonCode, "unknown_dispatch_or_cost",
        "a dispatch still unconfirmed after the execution deadline is unknown");

        current = await read();
        resumeAuditId = await transitionAudit("owner-resume");
        await transaction(tx => guard.resumePromptRefinerProductAutoGuardInTransaction(
          tx as never, { expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        for (let index = 0; index < 125; index += 1) {
          await insertReceipt({});
        }
        const missingAuditReceiptId = await insertReceipt({ audited: false,
          historical: true });
        assert.equal((await evaluate({
          executionReceiptId: missingAuditReceiptId,
        })).reasonCode, "audit_failure");
      });

      await t.test("only expired preparing receipt gaps pause across time zones", async () => {
        const resume = async () => {
          const current = await read();
          const resumeAuditLogId = await transitionAudit("owner-resume");
          await transaction(tx =>
            guard.resumePromptRefinerProductAutoGuardInTransaction(tx as never, {
              expectedGeneration: current.generation!,
              resumeAuditLogId,
            }));
        };
        const insertGap = async (timeZone: TestTimeZone,
          status: "reserved" | "settled" | "released" | null,
          expired: boolean) => {
          const attemptId = randomUUID();
          await transactionAtTimeZone(timeZone, async tx => {
            await tx.$executeRaw`INSERT INTO "PromptRefinerProductAttempt"
              ("id","mode","state","expiresAt") VALUES
              (${attemptId},'auto','preparing',
                (clock_timestamp() AT TIME ZONE 'UTC') +
                  ${expired ? -1 : 300} * interval '1 second')`;
            if (status !== null) {
              await tx.$executeRaw`INSERT INTO "PromptRefinerAutoBudgetHold"
                ("id","requestKey","status") VALUES
                (${randomUUID()},${attemptId},${status})`;
            }
          });
          return attemptId;
        };

        for (const [timeZone, status] of [
          ["UTC", "settled"],
          ["Australia/Brisbane", "released"],
          ["America/Los_Angeles", "settled"],
          ["Australia/Brisbane", "reserved"],
          ["America/Los_Angeles", null],
        ] as const) {
          await resume();
          await insertGap(timeZone, status, true);
          assert.equal((await evaluateAtTimeZone(timeZone)).reasonCode,
            "audit_failure",
            `${status ?? "no-hold"} gap did not pause in ${timeZone}`);
        }

        await resume();
        await insertGap("Australia/Brisbane", "settled", false);
        assert.equal((await evaluateAtTimeZone("America/Los_Angeles")).active,
          true, "an unexpired settled writer may still finish receipt cleanup");

        const terminalAttemptId = randomUUID();
        await transactionAtTimeZone("America/Los_Angeles", async tx => {
          await tx.$executeRaw`INSERT INTO "PromptRefinerProductAttempt"
            ("id","mode","state","expiresAt") VALUES
            (${terminalAttemptId},'auto','terminal',
              (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second')`;
          await tx.$executeRaw`INSERT INTO "PromptRefinerAutoBudgetHold"
            ("id","requestKey","status") VALUES
            (${randomUUID()},${terminalAttemptId},'released')`;
        });
        await insertReceipt({ requestId: terminalAttemptId });
        assert.equal((await evaluateAtTimeZone("UTC")).active, true,
          "a terminal attempt with its receipt is not an audit gap");
        await transaction(tx =>
          guard.latchPromptRefinerProductAutoStopInTransaction(
            tx as never, "audit_failure"));
      });

      await t.test("concurrent receipt completion and pause keep audit then guard lock order", async () => {
        const current = await read();
        const resumeAuditId = await transitionAudit("owner-resume");
        await transaction(tx => guard.resumePromptRefinerProductAutoGuardInTransaction(
          tx as never, { expectedGeneration: current.generation!,
            resumeAuditLogId: resumeAuditId }));
        for (let index = 0; index < 99; index += 1) {
          await insertReceipt({ latency: 6_001 });
        }
        assert.equal((await evaluate()).active, true,
        "the literal latest-100 policy must not infer a smaller denominator");
        const completeReceipt = () => transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(
            hashtext('tomverse-admin-audit-chain'))`;
          const receiptId = randomUUID();
          await tx.$executeRaw`INSERT INTO "PromptRefinerProductExecutionReceipt"
            ("id","requestId","outcome","failureCode","preparationLatencyMs")
            VALUES (${receiptId},NULL,'suggested',NULL,6001)`;
          await tx.$executeRaw`INSERT INTO "PromptRefinerProductExecutionContext"
            VALUES (${receiptId},'auto')`;
          await tx.$executeRaw`INSERT INTO "AdminAuditLog"
            ("id","action","targetType","targetId") VALUES
            (${randomUUID()},'prompt_refiner.product_execution_recorded',
              'PromptRefinerProductExecutionReceipt',${receiptId})`;
          return guard.evaluatePromptRefinerProductAutoGuardInTransaction(
            tx as never) as Promise<GuardState>;
        });
        const timeout = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("concurrent_guard_deadlock")), 2_000);
        });
        const results = await Promise.race([
          Promise.all([completeReceipt(), evaluate()]), timeout,
        ]);
        assert.equal(results.length, 2);
        assert.equal((await read()).reasonCode, "latency_p90_exceeded");
        assert.ok(results.some(result => result.active === false));
      });

      await t.test("guard rows reject direct reset, delete and truncate", async () => {
        await assert.rejects(client.query(`UPDATE "PromptRefinerProductOperationalGuard"
          SET "state"='active'`), /transition_invalid|resume_invalid/);
        await assert.rejects(client.query(`DELETE FROM "PromptRefinerProductOperationalGuard"`),
          /delete_forbidden/);
        await assert.rejects(client.query(`TRUNCATE "PromptRefinerProductOperationalGuard"`),
          /truncate_forbidden/);
      });
    } finally {
      await pool.end();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  });
