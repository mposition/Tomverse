import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
  import.meta.url,
);
const schema = new URL("../prisma/schema.prisma", import.meta.url);
const workerRuntime = new URL("../lib/amux/workerRuntime.ts", import.meta.url);

test("v22 recovery schema binds one approval without widening the five-attempt circuit", async () => {
  const [sql, prisma, runtime] = await Promise.all([
    readFile(migration, "utf8"),
    readFile(schema, "utf8"),
    readFile(workerRuntime, "utf8"),
  ]);

  assert.match(sql, /"nextAttemptNumber" BETWEEN 1 AND 5/);
  assert.match(
    sql,
    /p\."taskRevision" IS DISTINCT FROM NEW\."priorAttemptTaskRevision"/,
  );
  assert.doesNotMatch(
    sql,
    /CREATE OR REPLACE FUNCTION amux_v22_execution_attempt_guard/,
  );
  assert.match(sql, /CREATE FUNCTION amux_v22_recovery_attempt_guard/);
  assert.match(
    sql,
    /attempt_count IS DISTINCT FROM recovery\."historicalAttempts" \+ 1/,
  );
  assert.match(
    sql,
    /held IS DISTINCT FROM recovery\."oldHeldMicroUsd" \+ NEW\."reservedCostMicrousd"/,
  );
  assert.match(
    prisma,
    /recoveryApprovalId\s+String\?\s+@unique\s+@db\.Uuid/,
  );
  assert.match(
    prisma,
    /authorizationAuditLogId\s+String\s+@unique\(map: "AmuxV22TaskRecoveryInspectionReques_authorizationAuditLogId_key"\)/,
  );
  assert.match(
    prisma,
    /@relation\("AmuxV22RecoveryInspectionAudit",[^\n]+map: "AmuxV22TaskRecoveryInspectionReque_authorizationAuditLogId_fkey"\)/,
  );
  assert.match(
    sql,
    /audit\."metadata"->>'recoveryApprovalId' IS DISTINCT FROM a\."id"::text/,
  );
  assert.match(
    sql,
    /NEW\."recordedAt" := clock_timestamp\(\) AT TIME ZONE 'UTC'/,
  );
  assert.match(
    sql,
    /db_now - e\."recordedAt" > INTERVAL '90 seconds'/,
  );
  assert.match(
    sql,
    /u->'projectedCostMicroUsd' <> 'null'::jsonb AND\s+NOT \(u->>'projectedCostMicroUsd' ~/,
  );
  assert.doesNotMatch(
    sql,
    /inputTokens|outputTokens|inputTokenCount|outputTokenCount/,
  );
  assert.match(runtime, /AMUX_WORKER_RUNTIME_LEASE_MS = 90_000/);
});

test("v22 recovery migration is append-only and creates no corrective cost ledger", async () => {
  const sql = await readFile(migration, "utf8");

  assert.match(sql, /Task recovery metadata is append-only/);
  assert.match(sql, /AmuxV22Recovery_prior_attempt_immutable_check/);
  assert.match(sql, /IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+"AmuxCostLedgerEntry"/i);
  assert.doesNotMatch(sql, /UPDATE\s+"AmuxExecutionAttempt"/i);
});
