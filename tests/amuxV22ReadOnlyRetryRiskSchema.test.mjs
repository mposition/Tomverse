import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const functionBody = (sql, name) => {
  const start = sql.indexOf(`FUNCTION ${name}() RETURNS trigger`);
  assert.notEqual(start, -1, name);
  const bodyStart = sql.indexOf("AS $$", start) + "AS $$".length;
  const bodyEnd = sql.indexOf("$$;", bodyStart);
  assert.notEqual(bodyEnd, -1, name);
  return sql.slice(bodyStart, bodyEnd);
};

test("v39 is additive and leaves all four applied recovery migrations byte-identical", async () => {
  const [capabilities, v36, v37, v39] = await Promise.all([
    source("prisma/migrations/20261013100000_amux_worker_capability/migration.sql"),
    source("prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql"),
    source("prisma/migrations/20261013210000_amux_v22_legacy_safe_stop/migration.sql"),
    source("prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql"),
  ]);
  assert.equal(sha256(capabilities), "a420d51243673a1f4b0ffc13860950c6ef0d1c04a825475ef7facce2135744a9");
  assert.equal(sha256(v36), "e8babeef69b980a8b62f7e8c58e20c27f1d3d205eb4b7b3e09e0454c7a745d5a");
  assert.equal(sha256(v37), "7b832437bee8c4ae6a8a8d3d9494c71d33cbbee14361778f6d9c93e733a47482");
  assert.equal(sha256(v39), "9119c8cba8c92307116e2105faf36e8c4d5d779b89d5cc67f064da847246ddfd");
  assert.match(v39, /CREATE TABLE "AmuxV22TaskRecoveryRiskAcceptance"/);
  assert.match(v39, /CREATE TABLE "AmuxV22ReadOnlyLaunchCheck"/);
  assert.match(v39, /CREATE TABLE "AmuxV22ReadOnlyLaunchProof"/);
});

test("the v39 follow-up is row-preserving and rechecks the exact capability and cost", async () => {
  const sql = await source(
    "prisma/migrations/20261013230000_amux_v22_read_only_retry_db_guards/migration.sql");
  assert.equal(sha256(sql), "a18df0d45553cc4abd385b3d94f52b87e70fc525d5fda7467b2e007e093d8f66");
  assert.match(sql,
    /^-- baseline-check: present-if-function "amux_v22_v39_launch_capability_guard"$/m);
  assert.match(sql,
    /"protocolCapabilities" = ARRAY\['read_only_retry_v1'\]::TEXT\[\]/g);
  assert.equal(sql.match(/"protocolCapabilities" = ARRAY\['read_only_retry_v1'\]::TEXT\[\]/g)?.length, 4);
  assert.match(sql, /launch_check\."additionalCapMicroUsd" IS DISTINCT FROM NEW\."additionalCapMicroUsd"/);
  assert.match(sql, /launch_check\."worstExposureMicroUsd" IS DISTINCT FROM NEW\."worstExposureMicroUsd"/);
  assert.match(sql, /NEW\."perAttemptMicroUsd" IS DISTINCT FROM approval\."additionalCapMicroUsd"/);
  assert.match(sql, /NEW\."reservedCostMicrousd" IS DISTINCT FROM approval\."additionalCapMicroUsd"/);
  assert.match(sql, /AFTER INSERT ON "AmuxV22ReadOnlyLaunchCheck"/);
  assert.match(sql, /AFTER INSERT ON "AmuxV22TaskRecoveryApproval"/);
  assert.match(sql, /AFTER INSERT ON "AmuxV22WorkerAssignment"/);
  assert.match(sql, /AFTER INSERT ON "AmuxExecutionAttempt"/);
  assert.doesNotMatch(sql,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s+|DROP\s+)/im);
});

test("Prisma names every migrated v39 relation and index without replacement DDL", async () => {
  const schema = await source("prisma/schema.prisma");
  for (const name of [
    "AmuxV22RiskAcceptance_task_fkey",
    "AmuxV22RiskAcceptance_attempt_fkey",
    "AmuxV22RiskAcceptance_evidence_fkey",
    "AmuxV22RiskAcceptance_audit_fkey",
    "AmuxV22RecoveryRequest_riskAcceptanceId_fkey",
    "AmuxV22RecoveryApproval_riskAcceptanceId_fkey",
    "AmuxV22RecoveryApproval_launchProofId_fkey",
    "AmuxV22ReadOnlyLaunchCheck_risk_fkey",
    "AmuxV22ReadOnlyLaunchCheck_source_fkey",
    "AmuxV22ReadOnlyLaunchCheck_task_fkey",
    "AmuxV22ReadOnlyLaunchCheck_attempt_fkey",
    "AmuxV22ReadOnlyLaunchCheck_audit_fkey",
    "AmuxV22ReadOnlyLaunchProof_check_fkey",
    "AmuxV22ReadOnlyLaunchProof_audit_fkey",
    "AmuxV22RiskAcceptance_task_attempt_key",
    "AmuxV22RiskAcceptance_sourceEvidenceId_idx",
    "AmuxV22ReadOnlyLaunchCheck_task_requestedAt_idx",
    "AmuxV22ReadOnlyLaunchCheck_risk_requestedAt_idx",
  ]) assert.match(schema, new RegExp(`map: "${name}"`), name);
});

test("the PostgreSQL 17 proof guard repair replaces only the pinned prior body", async () => {
  const sql = await source(
    "prisma/migrations/20261013240000_amux_v22_read_only_launch_proof_guard_repair/migration.sql");
  assert.equal(sha256(sql), "fe94edf736f49ef5f5b58e9bb47a7e138d62b06ba11c9a439615ba9a346f9d3a");
  assert.match(sql,
    /^-- baseline-check: replace-function-if-body-sha256 "amux_v22_v39_launch_proof_guard" "42878a7eb9a83b29eaaf2233ed6470ef328ae9bd0d70bf5a4ffa138312caefce"$/m);
  assert.match(sql,
    /\(NEW\."report"->'launchScope'\) - 'launcherConfigDigest'::text IS DISTINCT FROM/);
  assert.match(sql, /c\."launchScope" - 'launcherConfigDigest'::text/);
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assert.doesNotMatch(sql,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s+|DROP\s+)/im);
});

test("v40 replaces only the four pinned capability guards and selects one exact executor", async () => {
  const [before, sql] = await Promise.all([
    source("prisma/migrations/20261013230000_amux_v22_read_only_retry_db_guards/migration.sql"),
    source("prisma/migrations/20261013250000_amux_v22_read_only_api_capability_guards/migration.sql"),
  ]);
  const functions = ["amux_v22_v39_launch_capability_guard",
    "amux_v22_v39_approval_capability_guard",
    "amux_v22_v39_assignment_capability_guard",
    "amux_v22_v39_attempt_capability_guard"];
  const beforeDigests = Object.fromEntries(functions.map((name) =>
    [name, sha256(functionBody(before, name))]));
  assert.deepEqual(beforeDigests, {
    amux_v22_v39_launch_capability_guard:
      "3042b6f3159a6933cb62034b63e8449c69a1a97bf6f84b00a7bff11e97a0acdb",
    amux_v22_v39_approval_capability_guard:
      "c207f179c567273daaef25d8481fa9345b7ed5aa4a2afc1ada8a1d17f6dc8ffd",
    amux_v22_v39_assignment_capability_guard:
      "0e97a7ab2f68b01b624d5e0a52ad5bddaed19d53a5e1439ace9686656c3aed1f",
    amux_v22_v39_attempt_capability_guard:
      "11ee70d829ee29879425917ca6b679a765fbcd3f4e88104d80cdc848d0f5ee6a",
  });
  for (const [name, digest] of Object.entries(beforeDigests))
    assert.match(sql, new RegExp(`\\('${digest}', '${name}'\\)`), name);
  assert.match(sql, new RegExp(
    `^-- baseline-check: replace-function-if-body-sha256 ` +
    `"${functions[0]}" "${beforeDigests[functions[0]]}"$`, "m"));
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 4);
  assert.equal((sql.match(/ARRAY\['read_only_retry_v1'\]::TEXT\[\]/g) ?? []).length, 4);
  assert.equal((sql.match(/ARRAY\['read_only_api_retry_v1'\]::TEXT\[\]/g) ?? []).length, 4);
  assert.equal((sql.match(/launchScope"->>'executorKind' = 'read_only_api_retry_v1'/g) ?? []).length, 4);
  assert.equal((sql.match(/NOT \([^\n]*"launchScope" \? 'executorKind'\)/g) ?? []).length, 4);
  for (const invariant of ["additionalCapMicroUsd", "worstExposureMicroUsd",
    "perAttemptMicroUsd", "reservedCostMicrousd"])
    assert.match(sql, new RegExp(invariant), invariant);
  assert.doesNotMatch(sql,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s+|DROP\s+)/im);
  assert.deepEqual(Object.fromEntries(functions.map((name) =>
    [name, sha256(functionBody(sql, name))])), {
    amux_v22_v39_launch_capability_guard:
      "b880950dc2a89c0d45c0f6fc86bf21d300176a9cab3198d94227dbcb1111cfef",
    amux_v22_v39_approval_capability_guard:
      "876d76f7dc9eed83cbe0c4737522f7b465a74a64bd7716d834b65e2c53805f7b",
    amux_v22_v39_assignment_capability_guard:
      "2b11280b2648339e3317acad12020c07f59414b75e522472dedfb56825512545",
    amux_v22_v39_attempt_capability_guard:
      "6efdc868bc967cc6ad93c3039768c75f77cafb131538775bb68756e3fd260b8d",
  });
});

test("v40 admits the API capability and gives its four-key launch scope a strict DB branch", async () => {
  const [sql, proofText] = await Promise.all([
    source("prisma/migrations/20261013260000_amux_v22_read_only_api_scope_guards/migration.sql"),
    source("prisma/migrations/20261013260000_amux_v22_read_only_api_scope_guards/baseline-check.json"),
  ]);
  assert.equal(sha256(sql),
    "ee2145362acafe6198fcc952186ae1aa835388e82b414d9b763265c213b3e6f1");
  const proof = JSON.parse(proofText);
  assert.equal(proof.migrationSqlSha256, sha256(sql));
  assert.deepEqual(proof.replacedChecks, [{
    table: "AmuxWorkerRuntime",
    constraint: "AmuxWorkerRuntime_protocolCapabilities_check",
    previousDefinitionSha256:
      "8e627eb7618477d93a370472aa635e8f05a89271f4c942aa29b618d4bc697f1a",
  }, {
    table: "AmuxV22ReadOnlyLaunchCheck",
    constraint: "AmuxV22ReadOnlyLaunchCheck_shape_check",
    previousDefinitionSha256:
      "c3634e56060e5ad5bcf501f5f8b67076ae00da76a5efb5792c1b8f1396440b4c",
  }]);
  assert.equal((sql.match(/DROP CONSTRAINT/g) ?? []).length, 2);
  assert.equal((sql.match(/ADD CONSTRAINT/g) ?? []).length, 2);
  assert.match(sql, /ARRAY\[\]::TEXT\[\][\s\S]*ARRAY\['read_only_retry_v1'\]::TEXT\[\][\s\S]*ARRAY\['read_only_api_retry_v1'\]::TEXT\[\]/);
  assert.match(sql,
    /"launchScope" - ARRAY\['version', 'executorKind',[\s\S]*'apiExecutionFrameDigest'\]::TEXT\[\]\) = '\{\}'::jsonb/);
  for (const key of ["version", "executorKind", "launcherConfigDigest",
    "apiExecutionFrameDigest"])
    assert.match(sql, new RegExp(`"launchScope" \\? '${key}'`), key);
  assert.match(sql, /"launchScope"->>'executorKind' = 'read_only_api_retry_v1'/);
  assert.equal((sql.match(/\^\[a-f0-9\]\{64\}\$/g) ?? []).length >= 10, true);
  assert.doesNotMatch(sql,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s+|DROP\s+TABLE)/im);
});

test("initial risk intent is exact, append-only, and cannot reserve or execute work", async () => {
  const sql = await source("prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql");
  assert.match(sql, /"taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af'/);
  assert.match(sql, /"priorAttemptId" = '97858395-3d66-42fa-9bfb-0e5a6cba9bd8'/);
  assert.match(sql, /"oldHeldMicroUsd" = 3400000[\s\S]*"additionalCapMicroUsd" = 3400000[\s\S]*"worstExposureMicroUsd" = 6800000/);
  assert.match(sql, /amux_v22_risk_acceptance_immutable BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+"(?:AmuxExecutionAttempt|AmuxWorkDelivery|AmuxCostLedgerEntry)"/i);
  assert.doesNotMatch(sql, /UPDATE\s+"AmuxWorkItem"/i);
  assert.match(sql, /a\."metadata"->>'executionStarted' = 'false'/);
  assert.match(sql, /a\."metadata"->>'reservationCreated' = 'false'/);
});

test("false legacy effects open only the accepted safe-stop source and never become known", async () => {
  const sql = await source("prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql");
  assert.match(sql, /source_e\."report"->'proof'->'externalEffectsKnown' = 'false'::jsonb[\s\S]*NEW\."riskAcceptanceId" IS NOT NULL/);
  assert.match(sql, /risk\."sourceEvidenceId" = source_e\."id"[\s\S]*risk\."acceptanceDigest" = NEW\."riskAcceptanceDigest"/);
  assert.match(sql, /source_allowed IS DISTINCT FROM true/);
  assert.doesNotMatch(sql, /externalEffectsKnown'\s*=\s*'true'::jsonb[\s\S]*UPDATE/);
});

test("one final consent can create only attempt two within the fixed exposure", async () => {
  const sql = await source("prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX "AmuxV22RecoveryApproval_riskAcceptanceId_key"/);
  assert.match(sql, /WHERE "riskAcceptanceId" IS NOT NULL/);
  assert.match(sql, /NEW\."attemptNumber" IS DISTINCT FROM 2/);
  assert.match(sql, /NEW\."reservedCostMicrousd" IS DISTINCT FROM a\."additionalCapMicroUsd"/);
  assert.match(sql, /count\(\*\)[\s\S]*> 2/);
  assert.match(sql, /"worstExposureMicroUsd" <= 6800000/);
  assert.match(sql, /NEW\."report"->'launchScope' - 'launcherConfigDigest' IS DISTINCT FROM[\s\S]*c\."launchScope" - 'launcherConfigDigest'/);
  assert.match(sql, /proof_audit\."metadata"->>'launchScopeDigest' = NEW\."launchScopeDigest"/);
  assert.match(sql, /p\."report"->'launchScope'->>'profileConfigDigest'/);
});

test("the exact FIRST Task rejects every unapproved second or third attempt", async () => {
  const [before, sql] = await Promise.all([
    source("prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql"),
    source("prisma/migrations/20261013290000_amux_v22_first_task_attempt_limit/migration.sql"),
  ]);
  const previousBodyDigest = sha256(functionBody(before,
    "amux_v22_v39_attempt_guard"));
  assert.equal(previousBodyDigest,
    "5fd506041790421b0bdc83a5ab87fc5b7c769988da8d944200e632326d8c1fd6");
  assert.equal(sha256(sql),
    "19ab206b5dfee0a11231ae65b8c9458d56aae2f617501f9db1e42a22aec378e0");
  assert.match(sql, new RegExp(
    `^-- baseline-check: replace-function-if-body-sha256 ` +
    `"amux_v22_v39_attempt_guard" "${previousBodyDigest}"$`, "m"));
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  const guard = functionBody(sql, "amux_v22_v39_attempt_guard");
  assert.match(guard, /NEW\."taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af'/);
  assert.match(guard,
    /current_setting\('transaction_isolation'\) NOT IN\s+\('read committed', 'read uncommitted', 'serializable'\)/);
  const isolationGuard = guard.indexOf("current_setting('transaction_isolation')");
  const globalLock = guard.indexOf("pg_catalog.pg_advisory_xact_lock");
  const taskLock = guard.indexOf('FROM "AmuxWorkItem"');
  const attemptCount = guard.indexOf('FROM "AmuxExecutionAttempt"');
  assert.ok(isolationGuard > 0 && globalLock > isolationGuard &&
    taskLock > globalLock && attemptCount > taskLock,
    "the exact Task guard must preserve global, Task, attempt lock order");
  assert.match(guard,
    /attempt_count > 2 OR\s+NEW\."attemptNumber" IS DISTINCT FROM attempt_count/);
  assert.match(guard, /IF NEW\."attemptNumber" = 2 THEN/);
  assert.match(guard, /assignment\."recoveryApprovalId"/);
  assert.match(guard, /approval\."riskAcceptanceId" IS NULL/);
  assert.match(guard, /approval\."priorAttemptId" IS DISTINCT FROM[\s\S]*'97858395-3d66-42fa-9bfb-0e5a6cba9bd8'/);
  assert.match(guard, /approval\."historicalAttempts" IS DISTINCT FROM 1/);
  assert.match(guard, /approval\."nextAttemptNumber" IS DISTINCT FROM 2/);
  assert.match(guard,
    /NEW\."reservedCostMicrousd" IS DISTINCT FROM[\s\S]*approval\."additionalCapMicroUsd"/);
  const otherTasks = guard.slice(guard.indexOf(
    'IF NEW."v22AssignmentId" IS NULL THEN RETURN NEW; END IF;'));
  assert.ok(otherTasks.length < guard.length,
    "the pre-existing recovery guard must remain after the exact Task branch");
  assert.match(otherTasks,
    /NEW\."taskId" IS DISTINCT FROM approval\."taskId"/);
  assert.match(otherTasks, /NEW\."attemptNumber" IS DISTINCT FROM 2/);
  assert.match(otherTasks,
    /NEW\."reservedCostMicrousd" IS DISTINCT FROM[\s\S]*approval\."additionalCapMicroUsd"/);
  assert.match(otherTasks,
    /count\(\*\) FROM "AmuxExecutionAttempt"[\s\S]*> 2/);
  assert.doesNotMatch(sql,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|TRUNCATE\s+|DROP\s+)/im);
});

test("risk delivery, start, and settlement fail closed around the read-only bridge", async () => {
  const [delivery, execution, claim, pull, settle, recovery] = await Promise.all([
    source("lib/amux/delivery.ts"), source("lib/amux/execution.ts"),
    source("lib/amux/v22WorkerClaimService.ts"),
    source("app/api/internal/amux/delivery/pull/route.ts"),
    source("app/api/internal/amux/v22/execution/settle/route.ts"),
    source("lib/amux/v22TaskRecoveryService.ts"),
  ]);
  assert.match(delivery, /assignment\.recoveryApprovalId && !recovery[\s\S]*throw new Error\("v22 recovery delivery authority is unavailable"\)/);
  assert.match(delivery, /recovery\?\.riskAcceptanceId[\s\S]*validateAmuxV22ReadOnlyRetryBinding/);
  assert.match(delivery, /recoveryApprovalId = recovery\.id/);
  assert.match(delivery, /amuxV22ReadOnlyLaunchProofScope\(proof\.report\)/);
  assert.match(delivery, /launcherConfigDigest: scope\.launchScope\.launcherConfigDigest/);
  assert.match(delivery, /scope\.launchScopeDigest !== recovery\.launchScopeDigest/);
  assert.match(execution, /protocolCapabilities\.length !== 1[\s\S]*protocolCapabilities\[0\] !== recovery\.readOnlyExecutorKind/);
  assert.match(claim, /protocolCapabilities\.length !== 1[\s\S]*protocolCapabilities\[0\] !== recovery\.readOnlyExecutorKind/);
  assert.match(pull, /recovery_approval_id: outcome\.delivery\.recoveryApprovalId/);
  assert.match(pull, /read_only_retry:/);
  assert.match(settle, /readOnlyRetrySchema = z\.union/);
  assert.match(settle, /launch_binding_id:[\s\S]*launch_proof_digest:[\s\S]*launch_scope_digest:/);
  assert.match(execution, /needsReadOnlyEcho !== !!input\.readOnlyRetry/);
  assert.match(execution, /reason: "read_only_retry_echo_unverified"/);
  assert.match(recovery, /launcherConfigDigest: reportedScope\.launcherConfigDigest/);
  assert.match(recovery, /launchScopeDigest: launchScope!\.launchScopeDigest/);
  assert.match(recovery, /scope\?\.launchScopeDigest !== row\.launchScopeDigest/);
});

test("proof freshness is a final-consent gate, not an expiry on an approved snapshot", async () => {
  const recovery = await source("lib/amux/v22TaskRecoveryService.ts");
  const authority = recovery.slice(
    recovery.indexOf("export async function readAmuxV22RecoveryAuthority"),
    recovery.indexOf("export function recoveryAttemptBudget"));
  assert.doesNotMatch(authority, /evidenceFresh\(/);
  assert.match(recovery,
    /action: "approve_attempt"[\s\S]*!evidenceFresh\(launchProof\.recordedAt, now\)/);
});
