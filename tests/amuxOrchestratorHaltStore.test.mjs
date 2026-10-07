// Orchestration policy version 20: who may write the three new tables, what
// the database itself refuses, and what the clear may never do.
//
// Source-level checks, so they run without a database. The same rules are
// exercised against PostgreSQL in the routing lane
// (tests/integration/amux-orchestration-halt.db.test.ts).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/orchestratorHaltStore.ts";
const MIGRATION = "prisma/migrations/20260930120000_amux_orchestrator_halt/migration.sql";

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one store module reads and writes the three tables", () => {
  // Foundation rule: one module writes an Agent's tables. A Prisma accessor or
  // a quoted table name anywhere else is a second writer or a reader that
  // bypasses the store's rules (the clear rule, the resolver rule).
  const pattern =
    /\b(amuxOrchestratorWrite|amuxOrchestratorWriteReceipt|amuxOrchestratorHalt)\b\.|"AmuxOrchestrator(Write|WriteReceipt|Halt)"/;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  // The export declaration names the Prisma model as data, to exclude it from
  // the customer export; it neither reads nor writes the table.
  const declarations = new Set(["lib/accountDataExportDomains.ts"]);
  const offenders = files.filter(
    (path) =>
      path !== STORE &&
      !declarations.has(path) &&
      pattern.test(withoutComments(readFileSync(join(root, path), "utf8"))),
  );
  assert.deepEqual(offenders, []);
  assert.match(read(STORE), /export const findOpenAmuxOrchestratorHalt =/);
  assert.match(read(STORE), /INSERT INTO "AmuxOrchestratorWrite"/);
  assert.match(read(STORE), /INSERT INTO "AmuxOrchestratorWriteReceipt"/);
  assert.match(read(STORE), /INSERT INTO "AmuxOrchestratorHalt"/);
});

test("every AMUX admission path consults the central halt store", () => {
  for (const path of [
    "lib/amux/execution.ts",
    "lib/amux/v4TaskReadyService.ts",
    "lib/amux/v22WorkerClaimService.ts",
    "lib/amux/v22AutoPromotionService.ts",
  ]) {
    const source = withoutComments(read(path));
    assert.match(source, /findOpenAmuxOrchestratorHalt\(tx\)/, path);
  }
});

test("the clear never runs the original claim, recovery or promotion", () => {
  // Section 7: "해제는 원래 작업을 다시 하지 않는다."
  const store = withoutComments(read(STORE));
  const clear = store.slice(
    store.indexOf("export async function clearAmuxOrchestratorHalt"),
    store.indexOf("export const countOpenAmuxOrchestratorHalts"),
  );
  assert.ok(clear.length > 500, "the clear function was found");
  const route = withoutComments(read("app/api/admin/amux/orchestrator-halts/route.ts"));
  const operations =
    /claimUnownedTodo|reclaimExpiredAmux|sweepExpiredAmuxQuotaObservations|tickAutoPromotion|runAutoPromotionTick|commitSystemAutoPromotion|expireDueAutoGrants|\/api\/internal\/amux\//;
  assert.doesNotMatch(clear, operations);
  assert.doesNotMatch(route, operations);
  for (const operationModule of ["lib/amux/store", "lib/amux/execution", "lib/amux/telemetry", "lib/amux/autoPromotionService"]) {
    assert.equal(store.includes(`"@/${operationModule}"`), false, operationModule);
    assert.equal(route.includes(`"@/${operationModule}"`), false, operationModule);
  }
  // Owner and a recent step-up, before the body is read; a stale step-up is
  // answered through the approval helper (428), which the panel handles.
  assert.ok(route.indexOf('getAdminRole(session) !== "owner"') < route.indexOf("readLimitedJson("));
  assert.ok(route.indexOf("assertRecentAdminAuthentication(session)") < route.indexOf("readLimitedJson("));
  assert.match(route, /adminApprovalErrorResponse\(error\)/);
  // The human audit and the three columns in one transaction, the typed prefix
  // compared first.
  assert.ok(clear.indexOf("amuxOrchestratorHaltKeyPrefixMatches(") < clear.indexOf("writeAdminAuditLog("));
  assert.ok(clear.indexOf("writeAdminAuditLog(") < clear.indexOf('SET\n          "clearedAt" = clock_timestamp()'));
  assert.match(clear, /"resolution" = 'human_confirmed'/);
  assert.match(clear, /prisma\.\$transaction\(/);
});

test("the internal halt route opens halts and has no way to clear one", () => {
  const route = withoutComments(read("app/api/internal/amux/orchestrator/halt/route.ts"));
  const service = withoutComments(read("lib/amux/orchestratorHaltService.ts"));
  for (const source of [route, service]) {
    assert.doesNotMatch(source, /clearAmuxOrchestratorHalt|clearedAt|clearedByUserId|clearAuditLogId/);
    assert.doesNotMatch(source, /export async function (PUT|PATCH|DELETE)\b/);
  }
  assert.match(route, /export async function POST\(/);
  assert.match(route, /export async function GET\(/);
  assert.match(route, /isAmuxSyncAuthorized\(request\)/);
});

test("the migration makes the database refuse what the policy forbids", () => {
  const sql = read(MIGRATION);
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // Additive: three tables, three functions, three triggers, nothing altered
  // but the one foreign key on the new receipt table, no row written.
  assert.equal((statements.match(/^CREATE TABLE /gm) ?? []).length, 3);
  assert.equal((statements.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 3);
  assert.equal((statements.match(/^CREATE TRIGGER /gm) ?? []).length, 3);
  assert.doesNotMatch(statements, /\bDROP\b|\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b/im);
  assert.equal((statements.match(/^ALTER TABLE /gm) ?? []).length, 1);
  assert.match(statements, /^BEGIN;$/m);
  assert.match(statements, /^COMMIT;$/m);

  const between = (start, end) => statements.slice(statements.indexOf(start), statements.indexOf(end, statements.indexOf(start)));
  const writeGuard = between('CREATE OR REPLACE FUNCTION "amux_orchestrator_write_guard"', "$$;");
  // admittedAt and deadlineAt come from the insert's database clock.
  assert.match(writeGuard, /NEW\."admittedAt" := pg_catalog\.clock_timestamp\(\);/);
  assert.match(writeGuard, /NEW\."deadlineAt" := NEW\."admittedAt" \+ budget;/);
  // no_commit needs the grace passed, no receipt and its system audit.
  assert.match(writeGuard, /OLD\."deadlineAt" \+ INTERVAL '5 seconds'/);
  assert.match(writeGuard, /AMUX_ORCHESTRATOR_WRITE_HAS_RECEIPTS/);
  assert.match(writeGuard, /'amux\.orchestrator\.write_resolved'/);
  // human_confirmed needs a cleared halt naming the request.
  assert.match(writeGuard, /AMUX_ORCHESTRATOR_WRITE_CLEAR_MISSING/);
  // Written once; unacknowledged unresolved rows are never deleted.
  assert.match(writeGuard, /AMUX_ORCHESTRATOR_WRITE_ACKED_ONCE/);
  assert.match(writeGuard, /AMUX_ORCHESTRATOR_WRITE_RESOLVED_ONCE/);
  assert.match(writeGuard, /AMUX_ORCHESTRATOR_WRITE_RETAINED/);
  assert.match(writeGuard, /INTERVAL '90 days'/);

  const receiptGuard = between('CREATE OR REPLACE FUNCTION "amux_orchestrator_write_receipt_guard"', "$$;");
  // A receipt for an acknowledged or resolved admission is refused, after
  // waiting for whoever holds the admission row.
  assert.match(receiptGuard, /"ackedAt" IS NULL AND "resolvedAt" IS NULL FROM %I\.%I WHERE "requestId" = \$1 FOR SHARE/);
  assert.match(receiptGuard, /AMUX_ORCHESTRATOR_WRITE_CLOSED/);
  assert.match(receiptGuard, /AMUX_ORCHESTRATOR_WRITE_RECEIPT_IMMUTABLE/);

  const haltGuard = between('CREATE OR REPLACE FUNCTION "amux_orchestrator_halt_guard"', "$$;");
  assert.match(haltGuard, /AMUX_ORCHESTRATOR_HALT_RETAINED/);
  assert.match(haltGuard, /AMUX_ORCHESTRATOR_HALT_CLEARED_ONCE/);
  assert.match(haltGuard, /AMUX_ORCHESTRATOR_HALT_CLEAR_INCOMPLETE/);
  assert.match(haltGuard, /AMUX_ORCHESTRATOR_HALT_IMMUTABLE/);
  assert.match(haltGuard, /'amux\.orchestrator\.halted'/);
  assert.match(haltGuard, /'amux\.orchestrator\.halt_cleared'/);
  for (const trigger of [
    'BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorWrite"',
    'BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorWriteReceipt"',
    'BEFORE INSERT OR UPDATE OR DELETE ON "AmuxOrchestratorHalt"',
  ]) {
    assert.ok(statements.includes(trigger), trigger);
  }
});

test("the three tables have no column for user content or free text", () => {
  const schema = read("prisma/schema.prisma");
  const columns = (model) => {
    const body = schema.slice(schema.indexOf(`model ${model} {`));
    return body
      .slice(0, body.indexOf("\n}"))
      .split("\n")
      .slice(1)
      .map((line) => /^\s{2}(\w+)\s+(\w+)/.exec(line))
      .filter((match) => match && !match[1].startsWith("@@") && /^[a-z]/.test(match[1]))
      .map((match) => match[1]);
  };
  assert.deepEqual(columns("AmuxOrchestratorWrite"), [
    "requestId",
    "instanceId",
    "callKind",
    "admittedAt",
    "deadlineAt",
    "ackedAt",
    "resolvedAt",
    "resolution",
    "receipts",
  ]);
  assert.deepEqual(columns("AmuxOrchestratorWriteReceipt"), [
    "id",
    "requestId",
    "targetKind",
    "targetId",
    "rowCount",
    "committedAt",
    "write",
  ]);
  assert.deepEqual(columns("AmuxOrchestratorHalt"), [
    "id",
    "haltKey",
    "reasonCode",
    "requestId",
    "openedAt",
    "clearedAt",
    "clearedByUserId",
    "clearAuditLogId",
  ]);
  // Every audit entry of this version goes through the allowlist.
  const store = withoutComments(read(STORE));
  const auditCalls = store.match(/(writeAmuxOrchestratorSystemAudit|writeAdminAuditLog)\(/g) ?? [];
  assert.equal(auditCalls.length, 3);
  assert.equal((store.match(/metadata: amuxOrchestratorAuditMetadata\(/g) ?? []).length, 3);
});

test("a mutation of an admitted write locks the admission before its work and writes its receipts in its fence", () => {
  const boundary = withoutComments(read("lib/amux/dbBoundary.ts"));
  const body = boundary.slice(boundary.indexOf("export async function withAmuxDbBoundary<T>("));
  const lock = body.indexOf("await lockAmuxRouteOrchestratorAdmission(tx, boundary.operation);");
  const work = body.indexOf("const result = await work(tx, {");
  const fence = body.indexOf("INSERT INTO \"AmuxCommitDeadline\"");
  assert.ok(lock > 0 && lock < work && work < fence);
  assert.match(body, /\)\$\{receiptSql\}\s*SELECT/);
  // A refusal audit takes no lock and records no receipt.
  assert.match(boundary, /claimRefusal: \{[\s\S]*?admissionLock: "none",/);
  // The internal route never sends one of the three "nothing committed"
  // answers once a receipt may have committed.
  const internal = withoutComments(read("lib/amux/internalRoute.ts"));
  const first = internal.indexOf("amuxRouteOrchestratorReceiptsMayHaveCommitted()");
  assert.ok(first > 0);
  assert.ok(first < internal.indexOf('reason: AMUX_DATABASE_BUSY_REASON'));
  assert.ok(first < internal.indexOf('reason: "amux_database_deadline_exceeded"'));
  assert.ok(first < internal.indexOf('reason: "amux_database_call_ceiling_exceeded"'));
});

test("every state-changing path of the three write routes records its receipts", () => {
  const store = read("lib/amux/store.ts");
  assert.match(store, /context\.recordReceipt\("work_item", input\.taskId, 1\);\s*context\.recordReceipt\("claim_decision", decision\.id, 1\);/);
  const execution = read("lib/amux/execution.ts");
  assert.match(execution, /context\.recordReceipt\("work_item", attempt\.taskId, 1\);\s*context\.recordReceipt\("execution_attempt", attempt\.id, 1\);/);
  assert.match(execution, /context\.recordReceipt\("work_item", task\.id, 1\);/);
  const telemetry = read("lib/amux/telemetry.ts");
  assert.match(telemetry, /if \(deleted > 0\) \{\s*context\.recordReceipt\("quota_observation_batch", null, deleted\);/);
  const auto = read("lib/amux/autoPromotionService.ts");
  assert.match(auto, /if \(expired\) recordReceipt\("auto_promotion_grant", due\.id, 1\);/);
  assert.match(auto, /recordReceipt\("work_item", bound\.item\.cardId, 1\);\s*recordReceipt\("auto_promotion_grant", grant\.id, 1\);\s*recordReceipt\("auto_promotion_consumption", value\.consumptionId, 1\);/);
  assert.match(auto, /recordReceipt\("auto_promotion_consumption", input\.consumptionId, 1\);/);
  // The claim refusal audit records none.
  const refusal = store.slice(
    store.indexOf("export async function recordAmuxClaimRefusal"),
    store.indexOf("async function writeAmuxClaimRefusalAudit"),
  );
  assert.doesNotMatch(refusal, /recordReceipt/);
});

test("all three write routes admit first, and serve a request without identity headers as before", () => {
  for (const [path, callKind] of [
    ["app/api/internal/amux/claim/route.ts", "claim"],
    ["app/api/internal/amux/execution/recover/route.ts", "recover"],
    ["app/api/internal/amux/auto-promotion/tick/route.ts", "auto_promotion_tick"],
  ]) {
    const source = withoutComments(read(path));
    const auth = source.indexOf("isAmuxSyncAuthorized(request)");
    const identity = source.indexOf("readAmuxOrchestratorWriteIdentity(request.headers)");
    const budget = source.indexOf("withAmuxRouteBudget(");
    const admit = source.indexOf(`admitAmuxOrchestratorRequest(identity, "${callKind}")`);
    assert.ok(auth > 0 && auth < identity && identity < budget && budget < admit, path);
    // Nothing reads the body or the switches before the admission.
    for (const later of ["readLimitedJson(", "anchorAmuxClaimDeadline(", "autoPromotionApplyPermitted("]) {
      const at = source.indexOf(later);
      if (at >= 0) assert.ok(admit < at, `${path}: ${later}`);
    }
  }
});
