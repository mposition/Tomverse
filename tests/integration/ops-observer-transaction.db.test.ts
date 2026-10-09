// The ops-observer transaction wrapper against a migrated database
// (docs/policy/sre-ops.md §6): READ COMMITTED with the kind's timers armed by
// statement 1, the inherited transaction_timeout logged, the statement ceiling
// rolling the whole transaction back, a short budget refused, and
// assertNotLate refusing at or past the deadline.

import assert from "node:assert/strict";
import { test } from "node:test";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("the ops-observer transaction wrapper", { skip: !rawUrl }, async (t) => {
  const { prisma } = await import("@/lib/prisma");
  const { withOpsObserverTransaction, assertNotLate, OpsObserverLateError, isBudgetInsufficient } = await import("@/lib/opsObserverTransaction");
  const inSeconds = (s: number) => new Date(Date.now() + s * 1000);
  // A fixed name: the callback may only send tagged templates, so the table
  // name is literal SQL text, not an interpolated fragment.
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "OpsObserverWrapperProbe" (x int)`);
  await prisma.$executeRawUnsafe(`DELETE FROM "OpsObserverWrapperProbe"`);

  try {
    await t.test("statement 1 arms the kind's timers in a READ COMMITTED transaction, and the inherited timer is logged", async () => {
      const logged: string[] = [];
      const original = console.info;
      console.info = (line: string) => logged.push(line);
      try {
        const { result, armed } = await withOpsObserverTransaction("confirm", inSeconds(170), async (tx) => {
          const rows = await tx.$queryRaw<{ iso: string; st: string; idle: string }[]>`
            SELECT current_setting('transaction_isolation') AS iso,
                   current_setting('statement_timeout') AS st,
                   current_setting('idle_in_transaction_session_timeout') AS idle`;
          return rows[0];
        });
        assert.deepEqual(result, { iso: "read committed", st: "2s", idle: "1s" });
        if (armed.serverVersion >= 170000) {
          assert.equal(armed.ttArmed, true);
          assert.ok(armed.ttArmedMs! >= 51_000 && armed.ttArmedMs! <= 55_000);
        } else {
          assert.equal(armed.ttArmed, false);
        }
        const entry = logged.map((l) => JSON.parse(l)).find((e) => e.event === "ops_observer_transaction_armed");
        assert.ok(entry, "the arming is logged");
        assert.equal(entry.kind, "confirm");
        assert.ok("priorTxTimeoutMs" in entry);
      } finally {
        console.info = original;
      }
    });

    await t.test("the statement past the ceiling rolls the whole transaction back", async () => {
      // `assert` allows A = 3, so the callback may send 2 after the arming statement.
      const error = await withOpsObserverTransaction("assert", inSeconds(60), async (tx) => {
        await tx.$executeRaw`INSERT INTO "OpsObserverWrapperProbe" VALUES (${1})`;
        await tx.$executeRaw`INSERT INTO "OpsObserverWrapperProbe" VALUES (${2})`;
        await tx.$executeRaw`INSERT INTO "OpsObserverWrapperProbe" VALUES (${3})`;
      }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, "statement_ceiling_exceeded");
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "OpsObserverWrapperProbe"`);
      assert.equal(rows[0].n, 0);
    });

    await t.test("the audit append writes one signed ops-observer entry and is charged four statements", async () => {
      const targetId = `wrapper-probe-${Date.now()}`;
      const { result } = await withOpsObserverTransaction("confirm", inSeconds(170), async (tx) =>
        tx.$appendSystemAudit({
          action: "ops_observer.wrapper_probe",
          targetType: "OpsObserverWrapperProbe",
          targetId,
          summary: "Wrapper probe.",
        }),
      );
      const rows = await prisma.$queryRawUnsafe<{ id: string; entryHash: string | null; actorUserId: string | null; actor: string }[]>(
        `SELECT id, "entryHash", "actorUserId", metadata ->> 'systemActor' AS actor FROM "AdminAuditLog" WHERE "targetId" = $1`,
        targetId,
      );
      assert.equal(rows.length, 1);
      assert.deepEqual(result, { id: rows[0].id, entryHash: rows[0].entryHash });
      assert.equal(rows[0].actorUserId, null);
      assert.equal(rows[0].actor, "ops-observer");

      // `assert` allows 2 statements after arming: one raw call leaves too few for an append.
      const error = await withOpsObserverTransaction("assert", inSeconds(60), async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await tx.$appendSystemAudit({ action: "ops_observer.wrapper_probe", targetType: "OpsObserverWrapperProbe", targetId, summary: "Refused." });
      }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, "statement_ceiling_exceeded");
      const after = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "AdminAuditLog" WHERE "targetId" = $1`, targetId);
      assert.equal(after[0].n, 1);
    });

    await t.test("a raw call that could carry two statements is refused before it is sent", async () => {
      const error = await withOpsObserverTransaction("confirm", inSeconds(170), async (tx) => {
        await (tx as unknown as { $executeRawUnsafe: (sql: string) => Promise<number> }).$executeRawUnsafe(
          `INSERT INTO "OpsObserverWrapperProbe" VALUES (9); INSERT INTO "OpsObserverWrapperProbe" VALUES (9)`,
        );
      }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, "statement_ceiling_unknown_method");
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "OpsObserverWrapperProbe"`);
      assert.equal(rows[0].n, 0);
    });

    await t.test("a model delegate is refused before it sends anything", async () => {
      const error = await withOpsObserverTransaction("assert", inSeconds(60), async (tx) => {
        // `user` exists in every generated client; the point is that no delegate is reachable.
        await (tx as unknown as { user: { findMany: () => Promise<unknown> } }).user.findMany();
      }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, "statement_ceiling_unknown_method");
    });

    await t.test("budget refusal is recognised by SQLSTATE, not by message text", async () => {
      assert.equal(isBudgetInsufficient(new Error("deadline_budget_insufficient")), false);
      assert.equal(isBudgetInsufficient({ code: "OB001" }), true);
      assert.equal(isBudgetInsufficient({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "OB001" } } } }), true);
    });

    await t.test("a method not known to be one statement is refused", async () => {
      const error = await withOpsObserverTransaction("confirm", inSeconds(170), async (tx) => {
        await (tx as unknown as { $transaction: () => Promise<void> }).$transaction();
      }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, "statement_ceiling_unknown_method");
    });

    await t.test("a budget under C_guarded + 250 ms is refused before anything runs", async () => {
      let ran = false;
      const error = await withOpsObserverTransaction("confirm", inSeconds(40), async () => {
        ran = true;
      }).then(() => null, (e: Error) => e);
      assert.match(String(error?.message), /deadline_budget_insufficient/);
      assert.equal(isBudgetInsufficient(error), true, "the SQLSTATE or message is found in the adapter error");
      assert.equal(ran, false);
    });

    await t.test("assertNotLate passes with time to spare and refuses at or past the deadline", async () => {
      await assertNotLate(inSeconds(30));
      for (const deadline of [inSeconds(2), inSeconds(-1)]) {
        const error = await assertNotLate(deadline).then(() => null, (e: Error) => e);
        assert.ok(error instanceof OpsObserverLateError, String(error));
      }
    });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "OpsObserverWrapperProbe"`);
    await prisma.$disconnect();
  }
});
