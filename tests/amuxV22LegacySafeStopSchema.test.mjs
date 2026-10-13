import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  amuxV22RecoveryEvidenceSchema,
  amuxV22SafeStopEvidenceSchema,
} from "../lib/amux/v22TaskRecoveryCore.ts";

const additiveMigration = new URL(
  "../prisma/migrations/20261013210000_amux_v22_legacy_safe_stop/migration.sql",
  import.meta.url,
);
const phaseTwoMigration = new URL(
  "../prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
  import.meta.url,
);
const schema = new URL("../prisma/schema.prisma", import.meta.url);
const actors = new URL("../lib/adminAuditSystemActors.ts", import.meta.url);
const policy = new URL("../docs/policy/development-agent-orchestration.md", import.meta.url);
const dbIntegration = new URL("./integration/amuxV4PortfolioScore.db.test.mjs", import.meta.url);
const seedFixture = new URL("./integration/helpers/amuxV4PortfolioSeedFixture.mjs", import.meta.url);
const recoveryFixture = new URL("./integration/helpers/amuxV22TaskRecoveryFixture.mjs", import.meta.url);

const quotedValues = (source) =>
  Array.from(source.matchAll(/'([^']+)'/g), (match) => match[1]);

const valuesFor = (source, pattern) => {
  const match = source.match(pattern);
  assert.ok(match, `missing closed list: ${pattern}`);
  return quotedValues(match[1]);
};

test("v37 extends, rather than rewrites, the approved v36 recovery ledger", async () => {
  const [oldSql, sql, prisma] = await Promise.all([
    readFile(phaseTwoMigration),
    readFile(additiveMigration, "utf8"),
    readFile(schema, "utf8"),
  ]);

  assert.equal(
    createHash("sha256").update(oldSql).digest("hex"),
    "e8babeef69b980a8b62f7e8c58e20c27f1d3d205eb4b7b3e09e0454c7a745d5a",
  );
  assert.match(sql, /ALTER TABLE "AmuxV22TaskRecoveryInspectionRequest"/);
  assert.match(sql, /ADD COLUMN "requestKind" TEXT NOT NULL DEFAULT 'inspect'/);
  assert.match(sql, /ADD COLUMN "sourceEvidenceId" UUID/);
  assert.match(sql, /ADD COLUMN "profileWorkerNames" TEXT\[\] NOT NULL DEFAULT ARRAY\[\]::TEXT\[\]/);
  assert.match(sql, /ALTER TABLE "AmuxV22TaskRecoveryEvidence"/);
  assert.match(sql, /ADD COLUMN "stopAcknowledgement" TEXT/);
  assert.match(sql, /ADD COLUMN "processState" TEXT/);
  assert.match(prisma, /requestKind\s+String\s+@default\("inspect"\)/);
  assert.match(prisma, /profileWorkerNames\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(prisma, /stopJournalBindingDigest\s+String\?/);
});

test("v37 serializes the safe-stop fence with claim, start and queued delivery", async () => {
  const sql = await readFile(additiveMigration, "utf8");

  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('tomverse-amux-admission'\)\)/);
  assert.match(sql, /FROM "AmuxWorkerRuntime"[\s\S]+ORDER BY "workerName" FOR UPDATE/);
  for (const table of ["AmuxV22WorkerAssignment", "AmuxExecutionAttempt", "AmuxWorkDelivery"]) {
    assert.match(
      sql,
      new RegExp(`CREATE TRIGGER amux_v22_legacy_safe_stop_[a-z_]+ BEFORE INSERT\\s+ON "${table}"`),
    );
  }
  assert.match(sql, /delivery\."status" IN \('queued', 'leased'\)/);
  assert.match(sql, /attempt\."endedAt" IS NULL OR attempt\."outcome" IS NULL/);
  assert.match(sql, /profileWorkerNames" @> ARRAY\[worker_name\]::TEXT\[\]/);
  assert.match(sql, /profileWorkerNames" @> ARRAY\[worker_name\]::TEXT\[\]\s+\);\s+\$\$;/);
  assert.doesNotMatch(sql, /worker_generation <= request\."workerGeneration"/);
  assert.doesNotMatch(sql, /proof\."verified" = true AND proof\."processState" = 'gone'/);
  assert.match(sql, /CONSTRAINT = 'AmuxV22LegacySafeStop_worker_fenced_check'/);
  assert.match(sql, /CREATE TRIGGER amux_v22_legacy_safe_stop_delivery_lease_guard_trigger\s+BEFORE UPDATE OF "worker", "status", "receiptId", "leasedAt", "leaseExpiresAt"\s+ON "AmuxWorkDelivery"/);
  assert.match(sql, /TG_OP = 'INSERT' OR NEW\."status" = 'leased'/);
  assert.match(sql, /CREATE TRIGGER amux_v22_legacy_safe_stop_task_guard_trigger\s+BEFORE UPDATE OF "owner", "status", "v22AssignmentId"\s+ON "AmuxWorkItem"/);
  assert.match(sql, /NEW\."owner" IS DISTINCT FROM OLD\."owner"/);
  assert.match(sql, /NEW\."status" IN \('todo', 'doing', 'review'\)/);
  assert.match(sql, /NEW\."owner" IS NULL OR NOT/);
});

test("v37 admits only the approved legacy read-only source and separates stop ack from process proof", async () => {
  const [sql, actorSource, policySource] = await Promise.all([
    readFile(additiveMigration, "utf8"),
    readFile(actors, "utf8"),
    readFile(policy, "utf8"),
  ]);

  assert.match(sql, /w\."taskRole" IS DISTINCT FROM 'investigate'/);
  assert.match(sql, /source_e\."reason" = 'legacy_invocation_unbound'/);
  assert.match(sql, /source_e\."report"->'proof'->'externalEffectsKnown' = 'true'::jsonb/);
  assert.match(sql, /b->>'modelOutcome' IS DISTINCT FROM 'unknown'/);
  assert.match(sql, /'stopAcknowledgement','processState'/);
  assert.match(sql, /'safe_stop_process_gone'/);
  assert.match(sql, /'safe_stop_process_present'/);
  assert.match(sql, /'safe_stop_process_unknown'/);
  assert.match(actorSource, /AMUX_V22_RECOVERY_CONTROLLER_AUDIT_ACTOR = "amux-v22-recovery-controller"/);
  assert.match(actorSource, /action === "amux\.v22\.recovery\.safe_stop_reported"/);
  assert.match(policySource, /TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED`가 정확히 `true`/);
  assert.match(policySource, /TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET/);
  assert.match(policySource, /`systemctl show <fixed-unit>`와\s+`systemctl stop <fixed-unit>`뿐/);
  assert.match(policySource, /모든 현재·미래 epoch/);
  assert.match(policySource, /다른 eligible worker/);
  assert.match(policySource, /이미 `Restart=no`라고 가정하지 않는다/);
});

test("v37 evidence shape keeps each DB branch aligned with its input proof schema", async () => {
  const sql = await readFile(additiveMigration, "utf8");
  const shape = sql.slice(
    sql.indexOf('ADD CONSTRAINT "AmuxV22RecoveryEvidence_shape_check"'),
    sql.indexOf("CREATE OR REPLACE FUNCTION amux_v22_recovery_inspection_guard"),
  );
  assert.ok(shape.length > 0, "evidence shape constraint is required");

  const reasonLists = Array.from(
    shape.matchAll(/"reason"\s+IN\s*\(([^)]*)\)/g),
    (match) => quotedValues(match[1]),
  );
  assert.equal(reasonLists.length, 2);

  const inspectInputReasons = amuxV22RecoveryEvidenceSchema.shape.reason.options;
  const safeStopInputReasons = amuxV22SafeStopEvidenceSchema.shape.reason.options;
  assert.deepEqual(
    valuesFor(shape, /"requestKind"\s+IN\s*\(([^)]*)\)/),
    ["inspect", amuxV22SafeStopEvidenceSchema.shape.requestKind.value],
  );
  assert.deepEqual(reasonLists[0], [
    "terminal_success",
    "legacy_invocation_unbound",
    "inspection_unverified",
    "external_effects_unknown",
    "workspace_unverified",
    "recovery_identity_changed",
    "runtime_observation_unverified",
  ]);
  assert.deepEqual(
    inspectInputReasons.filter((reason) => reason !== "stopped_proven").toSorted(),
    reasonLists[0].slice(0, 3).toSorted(),
  );
  assert.deepEqual(
    reasonLists[1],
    safeStopInputReasons.filter((reason) => reason !== "safe_stop_process_gone"),
  );
  assert.deepEqual(
    valuesFor(shape, /"stopAcknowledgement"\s+IN\s*\(([^)]*)\)/),
    amuxV22SafeStopEvidenceSchema.shape.stopProof.shape.stopAcknowledgement.options,
  );
  assert.deepEqual(
    valuesFor(shape, /"processState"\s+IN\s*\(([^)]*)\)/),
    amuxV22SafeStopEvidenceSchema.shape.stopProof.shape.processState.options,
  );
});

test("v37 migration never changes old attempts, approvals, settlements or cost ledgers", async () => {
  const sql = await readFile(additiveMigration, "utf8");

  assert.doesNotMatch(sql, /UPDATE\s+"AmuxExecutionAttempt"/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+"AmuxExecutionAttempt"/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+"AmuxCostLedgerEntry"/i);
  assert.doesNotMatch(sql, /UPDATE\s+"AmuxV22TaskRecoveryApproval"/i);
  assert.doesNotMatch(sql, /settledCostMicrousd|costConfirmed/);
});

test("v37 DB lane executes the permanent fence and another-worker recovery contract", async () => {
  const [integration, seed, fixture] = await Promise.all([
    readFile(dbIntegration, "utf8"),
    readFile(seedFixture, "utf8"),
    readFile(recoveryFixture, "utf8"),
  ]);

  assert.match(integration, /exerciseAmuxV22LegacySafeStopFenceFixture\(client,\s*recovery\.safeStopFenceInput\)/);
  assert.match(integration, /import\s*\{\s*seedAmuxV4PortfolioRecoveryPrerequisites\s*\}\s*from\s*"\.\/helpers\/amuxV4PortfolioSeedFixture\.mjs"/);
  assert.match(integration, /const seed = await seedAmuxV4PortfolioRecoveryPrerequisites\(client,\s*\{/);
  assert.match(integration, /const recovery = await exerciseAmuxV22TaskRecoveryFixture\(client,\s*seed\)/);
  assert.match(seed, /export async function seedAmuxV4PortfolioRecoveryPrerequisites\(db, input = \{\}\)/);
  assert.match(seed, /'reservation', 3400000/);
  assert.match(seed, /"AmuxCliUsageEvent"/);
  assert.match(seed, /"status"='acknowledged'/);
  assert.match(fixture, /oldHeldMicroUsd: "3400000"/);
  assert.match(fixture, /additionalCapMicroUsd: "3400000"/);
  assert.match(fixture, /worstExposureMicroUsd: "6800000"/);
  assert.match(fixture, /workerName: "worker-two"/);
  assert.match(fixture, /physical_fenced: true, recovery_fenced: false/);
  assert.match(fixture, /attemptNumber: 3, v22AssignmentId: null/);
  assert.match(fixture, /AmuxV22TaskRecoveryApproval_inspectionId_key/);
  assert.match(fixture, /SELECT \* FROM public\."AmuxCliUsageEvent" WHERE "attemptId"=\$1/);
  assert.match(fixture, /workerGeneration',2147483647/);
  assert.match(fixture, /SET "worker"=\$1[\s\S]+"status"='leased'/);
});
