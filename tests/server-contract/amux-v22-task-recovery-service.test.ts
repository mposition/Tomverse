import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { amuxV22RecoveryDigest, amuxV22SafeStopJournalBinding,
  amuxV22ReadOnlyLaunchScope, amuxV22ReadOnlyLaunchScopeDigest,
  amuxV22ReadOnlyLaunchProofSchema, amuxV22RecoveryAdminSchema,
  configuredAmuxV22RecoveryProfile,
  AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
  type AmuxV22RecoveryEvidenceInput,
  type AmuxV22SafeStopEvidenceInput } from "../../lib/amux/v22TaskRecoveryCore.ts";
import { createAmuxV22SidecarHandler } from "../../lib/amux/v22OneShotSidecar.mjs";
import { amuxV22ApiModelAccessResult } from
  "../../lib/amux/v22ApiModelAccessProtocol.mjs";
import { runAmuxV22RecoveryCheckerOnce } from "../../lib/amux/v22RecoveryHost.mjs";
import { inspectV4TaskCostCatalog } from "../../lib/amux/v4TaskCostCatalogCore.ts";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
/**
 * The v22 catalog the world's assignment catalog read returns: one worker's
 * profile overlaid on its static entry, as the derived catalog lists it.
 */
const v22CatalogFor = (workerName: string) => [{
  worker_name: workerName, provider: "anthropic", model: "claude-opus",
  routing_roles: ["investigate"], tool_capabilities: ["repo_read"],
  running: false, status: "stopped", dispatch_ready: false,
  archived: false, paused: false, isolated: false, blocked: false }];
let v22Catalog = v22CatalogFor("claude-test");
const owner = {
  user: { id: "owner-1" },
  expires: "2099-01-01T00:00:00.000Z",
};
const now = new Date("2026-10-13T01:00:20.000Z");
const requestId = "530abfe8-b2e0-4b58-bef9-ea5a63a2e90d";
const approvalRequestId = "6ddc04b1-e28f-4b56-9613-f3059b890cd9";
const safeStopRequestId = "2d76084f-150d-4050-a4ce-74d7ccc58a7f";
const attemptId = "d3e88810-998d-40ca-8fa7-7655411d99e0";
const instanceId = "b5eb2898-7c55-48ac-91b6-0af241c40344";
const receipt = { role: "design", grade: "small", catalogVersion: "catalog-1", catalogDigest: "a".repeat(64),
  pricingVersion: "price-1", gradeRulesVersion: "grade-1", calculatedAtIso: now.toISOString(),
  caps: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 1 },
  routes: [{ routeId: "route-1", workerName: "claude-test", provider: "anthropic", modelId: "claude-opus",
    routePolicyDigest: "b".repeat(64), perAttemptMicroUsd: "3400000" }], ceilingMicroUsd: "3400000", receiptDigest: "c".repeat(64) };
const approvedCatalog = (workerName: string) => ({ schemaVersion: 1,
  catalogVersion: "catalog-1", pricingVersion: "price-1",
  gradeRulesVersion: "grade-1", gradeRules: [{ role: "investigate", grade: "small",
    caps: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
      cacheWriteTokens: 0, maxAttempts: 1 } }],
  routes: [{ routeId: "route-1", workerName, provider: "anthropic",
    modelId: "claude-opus", routePolicyDigest: "b".repeat(64), enabled: true,
    roles: ["investigate"], grades: ["small"], pricingSource: "approved-record",
    pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
    pricingExpiresAt: "2026-10-20T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 1_000_000,
    cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0,
    toolCostCapMicroUsdPerAttempt: 0 }],
});
type Row = Record<string, unknown>;
const world = { task: {} as Row, attempt: {} as Row, runtime: {} as Row,
  retryRuntime: {} as Row, routeWorkerName: "claude-test",
  inspections: [] as Row[], evidence: [] as Row[], approvals: [] as Row[], audits: [] as Row[],
  risks: [] as Row[], launchChecks: [] as Row[], launchProofs: [] as Row[],
  apiModelAccessEvidence: [] as Row[],
  preApprovals: [] as Row[], preApprovalResults: [] as Row[], escalations: [] as Row[],
  usageAcceptances: [] as Row[],
  ready: true, incident: false, cap: "3400000", costAdmission: true, cas: true,
  otherWork: false,
  // null keeps the fixed test receipt. A Date makes the receipt digest depend on
  // its calculation time, as production does (calculatedAtIso is digested).
  costClock: null as Date | null,
  readyReasons: ["dependency_incomplete"] as string[], sourceReceipt: null as unknown,
  changedOld: 0, ledgerWrites: 0, attemptWrites: 0 };
function reset() {
  world.costClock = null;
  world.readyReasons = ["dependency_incomplete"]; world.sourceReceipt = null;
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  process.env.TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED = "true";
  delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED;
  delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID;
  delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST;
  delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST;
  delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST;
  process.env.TOMVERSE_AMUX_V22_RECOVERY_PROFILES_JSON = JSON.stringify({ version: 1,
    profiles: [{ alias: "profile-one", workerNames: ["claude-test"] },
      { alias: "profile-two", workerNames: ["codex-test"] }] });
  v22Catalog = v22CatalogFor("claude-test");
  world.attempt = { id: attemptId, taskId: "task-1234", taskRevision: 7,
    worker: "claude-test", workerInstanceId: instanceId, workerGeneration: 2,
    endedAt: new Date("2026-10-13T00:59:00.000Z"), outcome: "expired", reason: "outcome_unknown",
    attemptNumber: 1, reservedCostMicrousd: BigInt(3_400_000) };
  world.task = { id: "task-1234", sourceSystem: "admin-idea-v4", cardType: "task", archivedAt: null,
    v22ReceiptId: requestId, taskRole: "design", executionGrade: "small", status: "blocked", owner: null,
    claimedAt: null, v22AssignmentId: null, revision: 8, projectKey: null, teamKey: null,
    executionAttempts: [world.attempt] };
  world.runtime = { workerName: "claude-test", instanceId, generation: 2,
    heartbeatAt: new Date("2026-10-13T01:00:10.000Z"),
    leaseExpiresAt: new Date("2026-10-13T01:01:30.000Z"), status: "idle",
    dispatchReady: true, protocolCapabilities: ["read_only_retry_v1"] };
  world.retryRuntime = { ...world.runtime, workerName: "codex-test" };
  world.routeWorkerName = "claude-test";
  world.inspections = []; world.evidence = []; world.approvals = []; world.audits = [];
  world.risks = []; world.launchChecks = []; world.launchProofs = [];
  world.apiModelAccessEvidence = [];
  world.preApprovals = []; world.preApprovalResults = []; world.escalations = [];
  world.usageAcceptances = [];
  world.ready = true; world.incident = false; world.cap = "3400000"; world.costAdmission = true;
  world.cas = true; world.otherWork = false; world.changedOld = 0;
  world.ledgerWrites = 0; world.attemptWrites = 0;
}
const matches = (row: Row, where: Row) => Object.entries(where).every(([key, value]) => key === "assignment" ? true : row[key] === value);
function preApprovalWithResult(row: Row | undefined) {
  return row ? { ...row, result: world.preApprovalResults.find((item) =>
    item.preApprovalId === row.id) ?? null } : null;
}
function inspectionWithRelations(row: Row | undefined) {
  return row ? { ...row, evidence: world.evidence.find((item) => item.inspectionId === row.id) ?? null,
    approval: world.approvals.find((item) => item.inspectionId === row.id) ?? null,
    preApproval: preApprovalWithResult(world.preApprovals.find((item) =>
      item.inspectionId === row.id)) } : null;
}
/** The where clauses the pre-approval paths use: exact keys, result: null,
 * expiresAt.gt / .lt, and the sweep's evidence-or-expired OR. */
function preApprovalMatches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "result") return value !== null ||
      !world.preApprovalResults.some((item) => item.preApprovalId === row.id);
    if (key === "expiresAt") {
      const bound = value as { gt?: Date; lt?: Date };
      const at = (row.expiresAt as Date).getTime();
      return (!bound.gt || at > bound.gt.getTime()) && (!bound.lt || at < bound.lt.getTime());
    }
    if (key === "inspection") return world.evidence.some((item) =>
      item.inspectionId === row.inspectionId);
    if (key === "OR") return (value as Row[]).some((branch) => preApprovalMatches(row, branch));
    return row[key] === value;
  });
}
// Every recovery transaction that writes an audit entry takes the audit chain
// lock after any resource policy and worker runtime lock and before the Task
// row, and locks no new runtime or attempt row after it (lib/adminAudit.ts
// takeAuditChainLock); withAutoTransaction below checks it.
let lockLog: string[] = [];
function assertAuditBeforeTask(log: string[]) {
  if (!log.includes("write")) return;
  const audit = log.indexOf("audit");
  const task = log.indexOf("task");
  if (task >= 0) {
    assert.ok(audit >= 0 && audit < task && log.slice(audit, task).every((step) => step === "audit"),
      `audit chain lock, then the Task row: ${log.join(" > ")}`);
  }
  if (audit < 0) return;
  const before = new Set(log.slice(0, audit));
  for (const step of log.slice(audit)) {
    assert.ok(!(step.startsWith("runtime:") || step.startsWith("attempt:")) || before.has(step),
      `${step} is first locked after the audit chain: ${log.join(" > ")}`);
  }
}
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("");
    if (sql.includes('FROM "AmuxWorkItem"') && sql.includes("FOR UPDATE")) lockLog.push("task");
    if (sql.includes('FROM "AmuxWorkerRuntime"') && /FOR (SHARE|UPDATE)/.test(sql)) {
      for (const name of [values[0]].flat()) lockLog.push(`runtime:${String(name)}`);
    }
    if (sql.includes("AS present")) return [{ present: world.otherWork }];
    if (sql.includes('FROM "AmuxWorkerRuntime"')) {
      const workerNames = Array.isArray(values[0]) ? values[0] : [values[0]];
      return [world.runtime, world.retryRuntime].filter((row) =>
        workerNames.includes(row.workerName));
    }
    if (sql.includes('FROM "AmuxExecutionAttempt"') && /FOR (NO KEY UPDATE|UPDATE|SHARE)/.test(sql)) lockLog.push(`attempt:${String(values[0])}`);
    if (sql.includes('FROM "AmuxExecutionAttempt"')) return [{ id: attemptId }];
    if (sql.includes("unnest(request")) return Array.isArray(values[0]) &&
      values[0].includes("claude-test") ? [{ workerName: "claude-test" }] : [];
    return [{ id: world.task.id }];
  },
  amuxIdeaUnitDecision: { findUnique: async () => world.sourceReceipt === null ? null :
    { confirmationSnapshot: { card: { task: { costReceipt: world.sourceReceipt } } } } },
  amuxWorkItem: { findUnique: async () => world.task, findMany: async () => [],
    updateMany: async ({ where }: { where: Row }) => {
    if (!world.cas || !matches(world.task, where)) return { count: 0 };
    world.task.status = "todo"; world.task.revision = Number(world.task.revision) + 1;
    return { count: 1 };
  } },
  amuxExecutionAttempt: { aggregate: async () => ({ _count: { _all: 1 }, _max: { attemptNumber: 1 },
    _sum: { reservedCostMicrousd: BigInt(3_400_000) } }), update: async () => { world.changedOld++; },
    create: async () => { world.attemptWrites++; } },
  amuxCostLedgerEntry: { create: async () => { world.ledgerWrites++; }, createMany: async () => { world.ledgerWrites++; } },
  amuxV22AttemptUsageAcceptance: { createMany: async ({ data }: { data: Row[] }) => {
    world.usageAcceptances.push(...data); return { count: data.length }; } },
  adminAuditLog: { findUnique: async ({ where }: { where: Row }) => world.audits.find((row) => matches(row, where)) ?? null },
  amuxV22TaskRecoveryInspectionRequest: {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = world.inspections.find((item) => matches(item, where));
      return include ? inspectionWithRelations(row) : row ?? null;
    }, findFirst: async ({ where }: { where: Row }) => inspectionWithRelations(world.inspections.find((item) => matches(item, where))),
    findMany: async ({ where }: { where: Row }) => world.inspections.filter((item) =>
      matches(item, Object.fromEntries(Object.entries(where).filter(([key]) =>
        key !== "evidence" && key !== "approval"))) &&
      !world.evidence.some((e) => e.inspectionId === item.id) &&
      !world.approvals.some((a) => a.inspectionId === item.id)),
    create: async ({ data }: { data: Row }) => { world.inspections.push(data); return data; },
  },
  amuxV22TaskRecoveryEvidence: { findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
    const row = world.evidence.find((item) => matches(item, where));
    return row && include ? { ...row,
      inspection: world.inspections.find((item) => item.id === row.inspectionId)! } : row ?? null;
  },
    create: async ({ data }: { data: Row }) => { world.evidence.push(data); return data; } },
  amuxV22TaskRecoveryApproval: { findUnique: async ({ where }: { where: Row }) => world.approvals.find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = world.approvals.find((item) => matches(item, where));
      return row && include ? { ...row,
        inspection: world.inspections.find((item) => item.id === row.inspectionId),
        evidence: world.evidence.find((item) => item.id === row.evidenceId),
        apiModelAccessEvidence: world.apiModelAccessEvidence.find((item) =>
          item.id === row.apiModelAccessEvidenceId) ?? null } : row ?? null;
    },
    create: async ({ data }: { data: Row }) => { world.approvals.push(data); return data; } },
  amuxV22TaskRecoveryPreApproval: {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = world.preApprovals.find((item) => matches(item, where));
      if (!row || !include) return row ?? null;
      return { ...preApprovalWithResult(row), inspection: inspectionWithRelations(
        world.inspections.find((item) => item.id === row.inspectionId)) };
    },
    findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = world.preApprovals.find((item) => preApprovalMatches(item, where));
      return row && select ? Object.fromEntries(Object.keys(select).map((key) =>
        [key, row[key]])) : row ?? null;
    },
    create: async ({ data }: { data: Row }) => { world.preApprovals.push(data); return data; },
  },
  amuxHumanEscalation: {
    findMany: async ({ where }: { where: Row }) => world.escalations.filter((row) =>
      row.taskId === where.taskId &&
      ((where.status as { in: string[] }).in.includes(row.status as string))).map((row) => ({ id: row.id })),
    findFirst: async ({ where }: { where: Row }) => world.escalations.find((row) =>
      row.taskId === where.taskId &&
      ((where.status as { in: string[] }).in.includes(row.status as string))) ?? null,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const ids = (where.id as { in: string[] }).in;
      const rows = world.escalations.filter((row) => ids.includes(row.id as string) &&
        row.taskId === where.taskId &&
        (where.status as { in: string[] }).in.includes(row.status as string));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: `escalation-${world.escalations.length + 1}`, status: "open", ...data };
      world.escalations.push(row); return row;
    },
  },
  amuxV22TaskRecoveryPreApprovalResult: {
    create: async ({ data }: { data: Row }) => { world.preApprovalResults.push(data); return data; },
  },
  amuxV22TaskRecoveryRiskAcceptance: {
    findUnique: async ({ where }: { where: Row }) => world.risks.find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where }: { where: Row }) => world.risks.find((row) => matches(row, where)) ?? null,
    create: async ({ data }: { data: Row }) => { world.risks.push(data); return data; },
  },
  amuxV22ReadOnlyLaunchCheck: {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = world.launchChecks.find((item) => matches(item, where));
      return row && include ? { ...row, task: { ...world.task,
        taskRole: world.task.taskRole,
        executionGrade: world.task.executionGrade } } : row ?? null;
    },
    findFirst: async ({ where }: { where: Row }) => world.launchChecks.find((row) => matches(row, where)) ?? null,
    findMany: async ({ include }: { include?: Row } = {}) => include ?
      world.launchChecks.map((row) => ({ ...row, task: {
        taskRole: world.task.taskRole,
        executionGrade: world.task.executionGrade,
      } })) : world.launchChecks,
    create: async ({ data }: { data: Row }) => { world.launchChecks.push(data); return data; },
  },
  amuxV22ReadOnlyLaunchProof: {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = world.launchProofs.find((item) => matches(item, where));
      return row && include ? { ...row, launchCheck: world.launchChecks.find((item) =>
        item.id === row.launchCheckId) } : row ?? null;
    },
    findMany: async ({ where, include }: { where?: Row; include?: Row } = {}) =>
      world.launchProofs.filter((row) => {
        if (!where) return true;
        const check = world.launchChecks.find((item) => item.id === row.launchCheckId);
        const recordedAt = row.recordedAt as Date;
        const range = where.recordedAt as { gte: Date; lte: Date } | undefined;
        return row.verified === where.verified &&
          !world.apiModelAccessEvidence.some((item) => item.launchProofId === row.id) &&
          (!range || (recordedAt >= range.gte && recordedAt <= range.lte)) &&
          Boolean(check && (where.launchCheck as Row).workerName === check.workerName);
      }).sort((left, right) => (right.recordedAt as Date).getTime() -
        (left.recordedAt as Date).getTime()).slice(0, 1).map((row) => include ? {
          ...row, launchCheck: { ...world.launchChecks.find((item) =>
            item.id === row.launchCheckId)!, task: world.task },
        } : row),
    create: async ({ data }: { data: Row }) => { world.launchProofs.push(data); return data; },
  },
  amuxV22ApiModelAccessEvidence: {
    findUnique: async ({ where }: { where: Row }) => world.apiModelAccessEvidence.find((row) =>
      matches(row, where)) ?? null,
    create: async ({ data, select }: { data: Row; select?: Row }) => {
      world.apiModelAccessEvidence.push(data);
      return select ? Object.fromEntries(Object.keys(select).map((key) =>
        [key, data[key]])) : data;
    },
  },
  amuxWorkerRuntime: {
    findMany: async () => [world.runtime, world.retryRuntime],
    findUnique: async ({ where }: { where: Row }) =>
      [world.runtime, world.retryRuntime].find((row) => matches(row, where)) ?? null,
  },
  amuxOrchestratorHalt: { findFirst: async () => null },
};
let loaded: Promise<typeof import("../../lib/amux/v22TaskRecoveryService.ts")> | null = null;
let apiAccessLoaded: Promise<typeof import("../../lib/amux/v22ApiModelAccessService.ts")> | null = null;
function load() {
  if (loaded) return loaded;
  mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => true, getAdminRole: () => "owner" } });
  mock.module(mod("lib/adminReauthentication.ts"), { namedExports: { assertRecentAdminAuthentication: async () => {} } });
  mock.module(mod("lib/adminAudit.ts"), { namedExports: {
    takeAuditChainLock: async () => { lockLog.push("audit"); },
    writeAdminAuditLog: async (input: Row) => {
      lockLog.push("write");
      const id = `audit-${world.audits.length}`;
      world.audits.push({ ...input, id, actorUserId: "owner-1", entryHash: "d".repeat(64) }); return id;
    }, writeSystemAuditLog: async (input: Row) => {
      lockLog.push("write");
      const id = `audit-${world.audits.length}`;
      world.audits.push({ ...input, id, actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
        metadata: { ...(input.metadata as Row), systemActor: input.systemActor }, entryHash: "d".repeat(64) }); return id;
    },
  } });
  mock.module(mod("lib/amux/autoPromotionService.ts"), { namedExports: {
    OWNER_TRANSACTION_LIMITS: {}, TICK_TRANSACTION_LIMITS: {},
    withAutoTransaction: async (_id: unknown, _limits: unknown,
      callback: (transaction: typeof tx, time: Date) => Promise<unknown>) => {
      const saved = { task: structuredClone(world.task), inspections: [...world.inspections],
        approvals: [...world.approvals], evidence: [...world.evidence], audits: [...world.audits],
        risks: [...world.risks], launchChecks: [...world.launchChecks], launchProofs: [...world.launchProofs],
        apiModelAccessEvidence: [...world.apiModelAccessEvidence],
        preApprovals: [...world.preApprovals], preApprovalResults: [...world.preApprovalResults],
        usageAcceptances: [...world.usageAcceptances],
        escalations: structuredClone(world.escalations) };
      lockLog = [];
      try { const result = await callback(tx, now); assertAuditBeforeTask(lockLog); return result; }
      catch (error) { assertAuditBeforeTask(lockLog); world.task = saved.task; world.inspections = saved.inspections;
        world.approvals = saved.approvals;
        world.evidence = saved.evidence; world.audits = saved.audits;
        world.risks = saved.risks; world.launchChecks = saved.launchChecks;
        world.launchProofs = saved.launchProofs;
        world.apiModelAccessEvidence = saved.apiModelAccessEvidence;
        world.preApprovals = saved.preApprovals; world.preApprovalResults = saved.preApprovalResults;
        world.usageAcceptances = saved.usageAcceptances;
        world.escalations = saved.escalations;
        throw error; }
    },
  } });
  mock.module(mod("lib/amux/incident.ts"), { namedExports: { lockAmuxAdmissionAndReadIncident: async () => ({ blocks_admission: world.incident }) } });
  mock.module(mod("lib/amux/v4TaskReadyService.ts"), { namedExports: {
    loadAmuxV4TaskReadyContext: async () => ({}), evaluateAmuxV4TaskReadyInTransaction: async (_tx: unknown,
      _task: string, _context: unknown, _owner: unknown, expected: string) => {
      assert.equal(expected, "blocked");
      return { ready: world.ready, reasons: world.ready ? [] : world.readyReasons,
        sourceApprovalId: "source-approval" }; },
  } });
  mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
    calculateCurrentApprovedAmuxV4TaskCost: async (_tx: unknown, _role: string,
      _grade: string, options: { asOf?: Date } = {}) => {
      const catalog = approvedCatalog(world.routeWorkerName);
      const inspected = inspectV4TaskCostCatalog(catalog);
      assert.equal(inspected.ok, true);
      // Each unpinned calculation happens a second later than the last one.
      const at = world.costClock ? (options.asOf ?? (world.costClock =
        new Date(world.costClock.getTime() + 1_000))).toISOString() : null;
      return { approvalId: "catalog-id", catalog,
        catalogDigest: inspected.catalogDigest, receipt: {
          ...receipt, catalogDigest: inspected.catalogDigest,
          ...(at ? { calculatedAtIso: at, receiptDigest: amuxV22RecoveryDigest("test-receipt", { at }) } : {}),
          routes: [{ ...receipt.routes[0], workerName: world.routeWorkerName,
            perAttemptMicroUsd: world.cap }] } };
    },
  } });
  mock.module(mod("lib/amux/resourcePolicy.ts"), { namedExports: {
    lockAmuxResourcePolicies: async () => { lockLog.push("resource"); return []; },
    evaluateLockedAmuxCostAdmission: async () => ({
      allowed: world.costAdmission, reason: "cost_budget_exhausted" }),
  } });
  mock.module(mod("lib/amux/workerRuntime.ts"), { namedExports: { AMUX_WORKER_RUNTIME_LEASE_MS: 90_000 } });
  // Orchestration policy version 53, section 4: the recovery path reads the
  // assignment catalog inside its own transaction, as the claim path does.
  // The catalog this world configures is the one that read returns.
  mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
    readAmuxAssignmentCatalogs: async (client: unknown) => {
      assert.equal(client, tx);
      return { workers: null, ceilings: null, v22: v22Catalog };
    },
  } });
  loaded = import(mod("lib/amux/v22TaskRecoveryService.ts")); return loaded;
}
async function loadApiAccess() {
  await load();
  apiAccessLoaded ??= import(mod("lib/amux/v22ApiModelAccessService.ts"));
  return apiAccessLoaded;
}
async function requestInspection() {
  const service = await load();
  return service.requestAmuxV22RecoveryInspection({ session: owner, request: new Request("https://tomverse.test"),
    action: "request_inspection", taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId, requestId });
}
async function submitEvidence(change: Partial<AmuxV22RecoveryEvidenceInput> = {}) {
  const service = await load(); const inspection = world.inspections[0]!;
  const report = { inspectionId: inspection.id as string, evidenceId: "8fe97a85-d5df-4432-b4b0-7406571eaf37",
    requestDigest: inspection.requestDigest as string, taskId: inspection.taskId as string,
    taskRevision: inspection.taskRevision as number,
    priorAttemptId: inspection.priorAttemptId as string,
    priorAttemptTaskRevision: inspection.priorAttemptTaskRevision as number,
    workerName: "claude-test", workerInstanceId: instanceId,
    workerGeneration: 2, targetHost: "amux-ubuntu", hostInvocationId: "f".repeat(32),
    proof: { terminalOutcome: "unknown", sameLiveInvocation: true, noActiveExecution: true,
      processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
      socketTerminal: true, externalEffectsKnown: true, workspaceClean: true },
    usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "stopped_proven", ...change } as AmuxV22RecoveryEvidenceInput;
  await service.reportAmuxV22RecoveryEvidence(report);
  return service.readAmuxV22TaskRecovery(owner, inspection.taskId as string,
    inspection.ownerRequestId as string);
}
async function approvalInput() {
  const read = await submitEvidence();
  return { session: owner, request: new Request("https://tomverse.test"), action: "approve_attempt" as const,
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId, requestId: approvalRequestId,
    inspectionId: read.inspectionId!, evidenceId: read.evidenceId!, evidenceDigest: read.evidenceDigest!, costDigest: read.cost!.costDigest };
}
async function requestLegacySafeStopSource() {
  world.task.taskRole = "investigate";
  await requestInspection();
  return submitEvidence({ hostInvocationId: null, reason: "legacy_invocation_unbound",
    proof: { terminalOutcome: "unknown", sameLiveInvocation: false,
      noActiveExecution: false, processTreeStopped: false, rootOwnedUnit: false,
      controlGroupBound: false, journalBound: false, socketTerminal: false,
      externalEffectsKnown: true, workspaceClean: true } });
}
async function requestSafeStop() {
  const source = await requestLegacySafeStopSource();
  const service = await load();
  const read = await service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
    requestId: safeStopRequestId });
  return { source, read };
}
async function submitSafeStop() {
  const service = await load();
  const inspection = world.inspections.find((item) => item.requestKind === "safe_stop")!;
  const report: AmuxV22SafeStopEvidenceInput = {
    inspectionId: inspection.id as string,
    evidenceId: "76737099-0932-4cb2-b075-6d2805b16303",
    requestKind: "safe_stop", requestDigest: inspection.requestDigest as string,
    taskId: inspection.taskId as string, taskRevision: inspection.taskRevision as number,
    priorAttemptId: inspection.priorAttemptId as string,
    priorAttemptTaskRevision: inspection.priorAttemptTaskRevision as number,
    workerName: "claude-test",
    workerInstanceId: instanceId, workerGeneration: 2, targetHost: "amux-ubuntu",
    sourceEvidenceId: inspection.sourceEvidenceId as string,
    sourceEvidenceDigest: inspection.sourceEvidenceDigest as string,
    workerProfileAlias: inspection.workerProfileAlias as string,
    profileWorkerNames: inspection.profileWorkerNames as string[],
    targetUnit: inspection.targetUnit as string,
    profileConfigDigest: inspection.profileConfigDigest as string,
    hostInvocationId: null, modelOutcome: "unknown",
    stopProof: { journalBindingDigest: amuxV22SafeStopJournalBinding({
      taskId: inspection.taskId as string,
      priorAttemptId: inspection.priorAttemptId as string,
      workerProfileAlias: inspection.workerProfileAlias as string,
      targetUnit: inspection.targetUnit as string }),
    journalEntryDigest: "e".repeat(64), journalDisposition: "intent_recorded",
    stopAcknowledgement: "acknowledged", processState: "gone",
    fixedUnit: true, rootOwnedConfig: true, profileUnique: true,
    noOtherWork: true, restartDisabled: true, journalBound: true,
    mainPidAbsent: true, controlGroupEmpty: true, kernelProofFresh: true },
    usage: { status: "unknown", projectedCostMicroUsd: null },
    reason: "safe_stop_process_gone",
  };
  return service.reportAmuxV22LegacySafeStopEvidence(report);
}

async function prepareUnknownRiskSafeStop(protocolCapabilities = ["read_only_retry_v1"],
  costClock: Date | null = null) {
  reset();
  world.costClock = costClock;
  world.retryRuntime.protocolCapabilities = protocolCapabilities;
  if (protocolCapabilities.length === 1 &&
      protocolCapabilities[0] === "read_only_api_retry_v1") {
    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED = "true";
    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID =
      "first-task-anthropic";
    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST =
      "a".repeat(64);
    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST =
      "b".repeat(64);
    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST =
      "c".repeat(64);
  }
  world.task.id = AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID;
  world.task.taskRole = "investigate";
  world.task.revision = 7;
  world.task.v4BriefDigest = "9".repeat(64);
  world.attempt.id = AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID;
  world.attempt.taskId = AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID;
  world.attempt.taskRevision = 6;
  world.task.executionAttempts = [world.attempt];
  const service = await load();
  await service.requestAmuxV22RecoveryInspection({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_inspection",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID, requestId });
  const source = await submitEvidence({ hostInvocationId: null,
    reason: "legacy_invocation_unbound",
    proof: { terminalOutcome: "unknown", sameLiveInvocation: false,
      noActiveExecution: false, processTreeStopped: false, rootOwnedUnit: false,
      controlGroupBound: false, journalBound: false, socketTerminal: false,
      externalEffectsKnown: false, workspaceClean: true } });
  const riskRequestId = "35f8124e-e122-4d4f-bb42-ec75fc95ef5a";
  await service.acceptAmuxV22UnknownPriorEffects({ session: owner,
    request: new Request("https://tomverse.test"), action: "accept_unknown_prior_effects",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
    requestId: riskRequestId, acceptRisk: true });
  await service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
    requestId: safeStopRequestId });
  v22Catalog = v22CatalogFor("codex-test");
  world.routeWorkerName = "codex-test";
  await submitSafeStop();
  return { service, source, riskRequestId };
}

async function submitReadOnlyLaunchProof() {
  const service = await load();
  const check = world.launchChecks[0]!;
  const pending = await service.pendingAmuxV22LegacySafeStops();
  const request = pending.requests.find((candidate) =>
    "launchCheckId" in candidate && candidate.launchCheckId === check.id);
  assert.ok(request && "launchScope" in request);
  const nominalScope = request.launchScope;
  const actualScope = { ...nominalScope, launcherConfigDigest: "7".repeat(64) };
  const report = amuxV22ReadOnlyLaunchProofSchema.parse({
    ...request, launchScope: actualScope,
    launchProofId: "97037c9c-d382-43fb-9409-69ed89f76f10", observation: "current" });
  await service.reportAmuxV22ReadOnlyLaunchProof(report);
  return service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, safeStopRequestId);
}

test("inspection and approval use real stored IDs, preserve old unknown spend, and create no attempt or ledger", async () => {
  reset(); const service = await load(); const old = structuredClone(world.attempt);
  const requested = await requestInspection(); assert.equal(requested.state, "pending");
  const pending = await service.pendingAmuxV22RecoveryInspections("claude-test");
  assert.equal(pending.requests[0]!.inspectionId, requested.inspectionId);
  assert.equal(pending.requests[0]!.workerInstanceId, instanceId);
  const input = await approvalInput(); const read = await service.approveAmuxV22TaskRecovery(input);
  assert.equal(read.state, "approved"); assert.equal(world.task.status, "todo"); assert.equal(world.task.revision, 9);
  assert.equal(read.cost!.oldHeldMicroUsd, "3400000"); assert.equal(read.cost!.worstExposureMicroUsd, "6800000");
  assert.deepEqual(world.attempt, old); assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
  assert.equal(world.approvals.length, 1); assert.equal(world.audits.length, 3);
  assert.deepEqual(await service.approveAmuxV22TaskRecovery(input), read);
  assert.equal(world.approvals.length, 1); assert.equal(world.audits.length, 3);
  // Owner decision 2026-11-10: the approval accepts the Task's earlier
  // unknown-usage attempt, named in its own audit, and changes no cost.
  const approved = world.audits.find((row) => row.action === "amux.v22.recovery.approved")!;
  assert.deepEqual((approved.metadata as Row).acceptedUnknownUsageAttemptIds, [attemptId]);
  assert.equal(world.usageAcceptances.length, 1);
  assert.equal(world.usageAcceptances[0]!.attemptId, attemptId);
  assert.equal(world.usageAcceptances[0]!.source, "recovery_approval");
  assert.equal(world.usageAcceptances[0]!.acceptedByUserId, "owner-1");
  assert.equal(world.usageAcceptances[0]!.authorizationAuditLogId, approved.id);
});
test("inspection replay is exact and a reused ID cannot name another revision", async () => {
  reset(); const service = await load(); await requestInspection(); await requestInspection();
  assert.equal(world.inspections.length, 1);
  await assert.rejects(service.requestAmuxV22RecoveryInspection({ session: owner, request: new Request("https://tomverse.test"),
    action: "request_inspection", taskId: "task-1234", expectedRevision: 9, priorAttemptId: attemptId, requestId }), /request_id_reused/);
});
test("exact approval read-back survives later Task revisions without inferring execution completion", async () => {
  reset(); const service = await load(); await requestInspection(); const input = await approvalInput();
  const receipt = await service.approveAmuxV22TaskRecovery(input);
  const auditCount = world.audits.length;
  for (const [revision, status] of [[9, "todo"], [10, "todo"], [11, "doing"], [12, "review"]] as const) {
    world.task.revision = revision; world.task.status = status;
    world.task.owner = revision > 9 ? "claude-test" : null;
    world.task.executionAttempts = [{ id: "newer-attempt", taskRevision: revision, outcome: null }];
    const read = await service.readAmuxV22TaskRecovery(owner, input.taskId, input.requestId);
    assert.equal(read.state, "approved"); assert.equal(read.approvalId, receipt.approvalId);
    assert.equal(read.taskRevision, input.expectedRevision + 1);
    assert.equal(read.priorAttemptId, input.priorAttemptId);
    assert.equal(read.evidenceId, input.evidenceId); assert.equal(read.evidenceDigest, input.evidenceDigest);
    assert.deepEqual(read.currentTask, { revision, status });
    assert.deepEqual(read.cost, receipt.cost);
    assert.equal("outcome" in read, false); assert.equal("executionCompleted" in read, false);
  }
  assert.equal(world.audits.length, auditCount); assert.equal(world.approvals.length, 1);
  assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
});
test("read-back closes wrong Task or forged before-revision evidence bindings and keeps absence non-authoritative", async () => {
  reset(); const service = await load(); await requestInspection(); const input = await approvalInput();
  await service.approveAmuxV22TaskRecovery(input);
  await assert.rejects(service.readAmuxV22TaskRecovery(owner, "task-other", input.requestId), /recovery_receipt_mismatch/);
  const missing = await service.readAmuxV22TaskRecovery(owner, input.taskId, "0c1a9db5-b13e-4bf6-97c4-672a024b4a75");
  assert.equal(missing.state, "not_visible"); assert.equal(missing.retryWrite, false);
  world.approvals[0]!.beforeRevision = 7;
  await assert.rejects(service.readAmuxV22TaskRecovery(owner, input.taskId, input.requestId), /recovery_receipt_mismatch/);
  assert.equal(world.approvals.length, 1); assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
});
test("terminal success, unbound invocation and changed runtime are stored as explicit unverified evidence", async () => {
  for (const mutation of ["success", "legacy", "runtime"] as const) {
    reset(); await requestInspection();
    if (mutation === "runtime") world.runtime.generation = 3;
    const reportChange = mutation === "legacy" ? { hostInvocationId: null, reason: "legacy_invocation_unbound" as const } :
      mutation === "success" ? { proof: { terminalOutcome: "succeeded" as const, sameLiveInvocation: true,
        noActiveExecution: true, processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true,
        journalBound: true, socketTerminal: true, externalEffectsKnown: true, workspaceClean: true } } : {};
    const read = await submitEvidence(reportChange); assert.equal(read.state, "unverified");
    assert.equal(world.evidence.length, 1); assert.equal(world.approvals.length, 0);
  }
});
test("the actual no-memory legacy producer stays unknown through the checker and cannot request safe-stop", async () => {
  reset(); world.task.taskRole = "investigate";
  const service = await load(); await requestInspection();
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-no-memory-"));
  const capture: { transmitted?: AmuxV22RecoveryEvidenceInput } = {};
  try {
    const handler = createAmuxV22SidecarHandler({ worker: "claude-test", stateDir,
      protocolCapabilities: () => ["read_only_retry_v1"],
      quota: undefined, recoveryUnit: undefined, recoveryWorkspace: undefined,
      modelAccess: undefined,
      run: async () => {
        throw new Error("provider execution is not allowed in this regression");
      } });
    const checker = await runAmuxV22RecoveryCheckerOnce({ enabled: "1",
      workerName: "claude-test", socketPath: "/run/tomverse-amux-v22-claude-test/task.sock",
      syncSecret: "i".repeat(40), internalUrl: "https://tomverse.test/" }, {
      fetcher: async (_url: URL, init: RequestInit) => {
        if (init.method === "GET")
          return Response.json(await service.pendingAmuxV22RecoveryInspections("claude-test"));
        const transmitted = JSON.parse(String(init.body)) as AmuxV22RecoveryEvidenceInput;
        capture.transmitted = transmitted;
        const recorded = await service.reportAmuxV22RecoveryEvidence(transmitted);
        return Response.json({ recorded: recorded.recorded, evidenceId: recorded.evidenceId });
      },
      inspectSocket: async (_path: string, body: unknown) => handler(body),
    });
    assert.equal(checker.state, "reported");
    assert.equal(capture.transmitted?.reason, "legacy_invocation_unbound");
    assert.equal(capture.transmitted?.proof.externalEffectsKnown, false);

    const source = await service.readAmuxV22TaskRecovery(owner, "task-1234", requestId);
    assert.equal(source.state, "unverified");
    // Outside the approved FIRST Task the same legacy evidence offers no risk intent.
    assert.equal(source.eligibility.acceptUnknownPriorEffects, false);
    const before = { inspections: world.inspections.length, audits: world.audits.length,
      evidence: world.evidence.length };
    await assert.rejects(service.requestAmuxV22LegacySafeStop({ session: owner,
      request: new Request("https://tomverse.test"), action: "request_safe_stop",
      taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
      sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
      requestId: safeStopRequestId }), (error: unknown) =>
      error instanceof Error && error.message === "safe_stop_external_effects_unknown" &&
      "httpStatus" in error && error.httpStatus === 409);
    assert.deepEqual({ inspections: world.inspections.length, audits: world.audits.length,
      evidence: world.evidence.length }, before);
    assert.equal(world.inspections.some((item) => item.requestKind === "safe_stop"), false);
    assert.equal(world.approvals.length + world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("a restarted sidecar's journal proves an earlier run stopped and opens one capped attempt with the old hold kept", async () => {
  // Production 2026-11-07 (AMUX-FILEREQ-004): the run failed on 11-06, the
  // sidecar restarted for a bundle install and the bridge registered again.
  reset(); const service = await load(); await requestInspection();
  const old = structuredClone(world.attempt);
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-journal-"));
  const syntheticJournal = (path: string) => readFile(path, "utf8").catch(() => null);
  const capture: { transmitted?: AmuxV22RecoveryEvidenceInput } = {};
  try {
    const earlier = createAmuxV22SidecarHandler({ worker: "claude-test", stateDir,
      invocationId: "a".repeat(32), recoveryJournal: syntheticJournal,
      quota: undefined, protocolCapabilities: undefined, modelAccess: undefined,
      recoveryUnit: undefined, recoveryWorkspace: undefined,
      run: async () => ({ kind: "failed", attemptId, cliStarted: true }) });
    await earlier({ op: "execute", version: 1, attemptId, worker: "claude-test",
      role: "design", modelId: "claude-opus", budgetMicrousd: 3_400_000,
      prompt: "Private synthetic prompt", recoveryBinding: { version: 1, taskId: "task-1234",
        taskRevision: 7, workerInstanceId: instanceId, workerGeneration: 2,
        targetHost: "amux-ubuntu" } });
    for (const deadline = Date.now() + 10_000;
      (await earlier({ op: "readback", attemptId })).kind === "in_progress";) {
      if (Date.now() > deadline) throw new Error("synthetic terminal was not durable");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    let runs = 0;
    const restarted = createAmuxV22SidecarHandler({ worker: "claude-test", stateDir,
      invocationId: "c".repeat(32), recoveryJournal: syntheticJournal,
      quota: undefined, protocolCapabilities: undefined, modelAccess: undefined,
      recoveryUnit: async () => ({ rootOwnedUnit: true, controlGroupBound: true,
        processTreeStopped: true }),
      recoveryWorkspace: async () => ({ ok: true, baseSha: "d".repeat(40) }),
      run: async () => { runs += 1; throw new Error("no provider call in this regression"); } });
    world.runtime.instanceId = "0f5a2c9e-6d1b-4e3a-9c7f-2b8d4e6a1c03"; world.runtime.generation = 7;
    const checker = await runAmuxV22RecoveryCheckerOnce({ enabled: "1",
      workerName: "claude-test", socketPath: "/run/tomverse-amux-v22-claude-test/task.sock",
      syncSecret: "i".repeat(40), internalUrl: "https://tomverse.test/" }, {
      fetcher: async (_url: URL, init: RequestInit) => {
        if (init.method === "GET")
          return Response.json(await service.pendingAmuxV22RecoveryInspections("claude-test"));
        const transmitted = JSON.parse(String(init.body)) as AmuxV22RecoveryEvidenceInput;
        capture.transmitted = transmitted;
        const recorded = await service.reportAmuxV22RecoveryEvidence(transmitted);
        return Response.json({ recorded: recorded.recorded, evidenceId: recorded.evidenceId });
      },
      inspectSocket: async (_path: string, body: unknown) => restarted(body),
    });
    assert.equal(checker.state, "reported");
    assert.equal(capture.transmitted?.reason, "terminal_journal_proven");
    assert.equal(capture.transmitted?.hostInvocationId, "a".repeat(32));
    assert.equal(capture.transmitted?.proof.sameLiveInvocation, false);
    assert.equal(JSON.stringify(capture.transmitted).includes("Private synthetic prompt"), false);

    const read = await service.readAmuxV22TaskRecovery(owner, "task-1234", requestId);
    assert.equal(read.state, "verified"); assert.equal(read.reason, null);
    assert.deepEqual(read.eligibility, { acceptUnknownPriorEffects: false,
      requestSafeStop: false, approveAttempt: true, reason: null });
    assert.equal(read.cost!.oldHeldMicroUsd, "3400000");
    assert.equal(read.cost!.additionalCapMicroUsd, "3400000");
    assert.equal(read.cost!.worstExposureMicroUsd, "6800000");
    const approved = await service.approveAmuxV22TaskRecovery({ session: owner,
      request: new Request("https://tomverse.test"), action: "approve_attempt",
      taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
      requestId: approvalRequestId, inspectionId: read.inspectionId!,
      evidenceId: read.evidenceId!, evidenceDigest: read.evidenceDigest!,
      costDigest: read.cost!.costDigest });
    assert.equal(approved.state, "approved"); assert.equal(world.task.status, "todo");
    assert.equal(approved.cost!.oldHeldMicroUsd, "3400000");
    assert.deepEqual(world.attempt, old);
    assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites + runs, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("a journal report the app cannot confirm stays unverified", async () => {
  const journal = { hostInvocationId: "a".repeat(32), reason: "terminal_journal_proven" as const,
    proof: { terminalOutcome: "failed" as const, sameLiveInvocation: false, noActiveExecution: true,
      processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
      socketTerminal: true, externalEffectsKnown: true, workspaceClean: true } };
  for (const [change, reason] of [
    [{ hostInvocationId: null }, "legacy_invocation_unbound"],
    [{ proof: { ...journal.proof, noActiveExecution: false } }, "inspection_unverified"],
    [{ proof: { ...journal.proof, processTreeStopped: false } }, "inspection_unverified"],
    [{ proof: { ...journal.proof, journalBound: false } }, "legacy_invocation_unbound"],
    [{ proof: { ...journal.proof, externalEffectsKnown: false, workspaceClean: false } },
      "external_effects_unknown"],
    // A read-only role still needs a clean checkout on the journal path, as the DB guard does.
    [{ proof: { ...journal.proof, workspaceClean: false } }, "workspace_unverified"],
  ] as const) {
    reset(); await requestInspection();
    const read = await submitEvidence({ ...journal, ...change });
    assert.equal(read.state, "unverified"); assert.equal(read.reason, reason);
    assert.equal(read.eligibility.approveAttempt, false);
  }
  // Only the journal reason verifies a terminal of an earlier invocation, and
  // a live stopped_proven report still needs the attempt's runtime.
  reset(); await requestInspection();
  assert.equal((await submitEvidence({ proof: { ...journal.proof } })).reason,
    "inspection_unverified");
  reset(); await requestInspection();
  assert.equal((await submitEvidence({ proof: { ...journal.proof, journalBound: false } })).reason,
    "legacy_invocation_unbound");
  reset(); await requestInspection();
  world.runtime.generation = 7;
  assert.equal((await submitEvidence({ ...journal, reason: "stopped_proven",
    proof: { ...journal.proof, sameLiveInvocation: true } })).reason,
  "runtime_observation_unverified");
});
test("the actual unknown producer authorizes only the approved FIRST Task risk intent without execution", async () => {
  reset();
  world.task.id = AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID;
  world.task.taskRole = "investigate";
  world.task.revision = 7;
  world.task.v4BriefDigest = "9".repeat(64);
  world.attempt.id = AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID;
  world.attempt.taskId = AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID;
  world.attempt.taskRevision = 6;
  world.task.executionAttempts = [world.attempt];
  const service = await load();
  const inspectionRequestId = "6e07ad55-33ca-4c71-9a5b-30f052bbb5b8";
  const riskRequestId = "35f8124e-e122-4d4f-bb42-ec75fc95ef5a";
  await service.requestAmuxV22RecoveryInspection({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_inspection",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    requestId: inspectionRequestId });
  const stateDir = await mkdtemp(join(tmpdir(), "amux-recovery-risk-intent-"));
  try {
    const handler = createAmuxV22SidecarHandler({ worker: "claude-test", stateDir,
      protocolCapabilities: () => ["read_only_retry_v1"],
      quota: undefined, recoveryUnit: undefined, recoveryWorkspace: undefined,
      modelAccess: undefined,
      run: async () => { throw new Error("risk acceptance must not run the provider"); } });
    await runAmuxV22RecoveryCheckerOnce({ enabled: "1", workerName: "claude-test",
      socketPath: "/run/tomverse-amux-v22-claude-test/task.sock",
      syncSecret: "i".repeat(40), internalUrl: "https://tomverse.test/" }, {
      fetcher: async (_url: URL, init: RequestInit) => init.method === "GET" ?
        Response.json(await service.pendingAmuxV22RecoveryInspections("claude-test")) :
        Response.json(await service.reportAmuxV22RecoveryEvidence(
          JSON.parse(String(init.body)) as AmuxV22RecoveryEvidenceInput)),
      inspectSocket: async (_path: string, body: unknown) => handler(body),
    });
    const source = await service.readAmuxV22TaskRecovery(owner,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, inspectionRequestId);
    assert.equal(source.state, "unverified");
    assert.equal(source.reason, "legacy_invocation_unbound");
    // The Admin panel renders the acceptance control only from this flag.
    assert.equal(source.eligibility.acceptUnknownPriorEffects, true);
    assert.equal(source.eligibility.reason, "risk_acceptance_required");
    const beforeTask = structuredClone(world.task);
    const accepted = await service.acceptAmuxV22UnknownPriorEffects({ session: owner,
      request: new Request("https://tomverse.test"), action: "accept_unknown_prior_effects",
      taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
      priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
      sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
      requestId: riskRequestId, acceptRisk: true });
    assert.equal(accepted.state, "pending");
    assert.equal(accepted.riskAcceptance?.oldHeldMicroUsd, "3400000");
    assert.equal(accepted.riskAcceptance?.worstExposureMicroUsd, "6800000");
    assert.equal(accepted.riskAcceptance?.executionStarted, false);
    assert.equal(accepted.riskAcceptance?.reservationCreated, false);
    assert.deepEqual(world.task, beforeTask);
    assert.equal(world.risks.length, 1);
    assert.equal(world.approvals.length + world.launchChecks.length + world.launchProofs.length +
      world.attemptWrites + world.ledgerWrites, 0);
    await service.acceptAmuxV22UnknownPriorEffects({ session: owner,
      request: new Request("https://tomverse.test"), action: "accept_unknown_prior_effects",
      taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
      priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
      sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
      requestId: riskRequestId, acceptRisk: true });
    assert.equal(world.risks.length, 1);
    const sourceAfter = await service.readAmuxV22TaskRecovery(owner,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, inspectionRequestId);
    assert.equal(sourceAfter.eligibility.acceptUnknownPriorEffects, false);
    const outsideScope = amuxV22RecoveryAdminSchema.safeParse({ action: "accept_unknown_prior_effects",
      taskId: "task-outside-approved-scope", expectedRevision: 7,
      priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
      sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
      requestId: "97037c9c-d382-43fb-9409-69ed89f76f10", acceptRisk: true });
    assert.equal(outsideScope.success, false);
    assert.equal(world.risks.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("the trusted root proof replaces only the nominal launcher digest and stores the actual scope", async () => {
  reset();
  const service = await load();
  const riskId = "35f8124e-e122-4d4f-bb42-ec75fc95ef5a";
  const checkId = "6e07ad55-33ca-4c71-9a5b-30f052bbb5b8";
  const proofId = "97037c9c-d382-43fb-9409-69ed89f76f10";
  const evidenceId = "76737099-0932-4cb2-b075-6d2805b16303";
  const riskDigest = "1".repeat(64);
  const profile = configuredAmuxV22RecoveryProfile("claude-test")!;
  const nominalScope = amuxV22ReadOnlyLaunchScope({
    profileConfigDigest: profile.profileConfigDigest });
  const actualScope = { ...nominalScope, launcherConfigDigest: "7".repeat(64) };
  world.risks.push({ id: riskId, acceptanceDigest: riskDigest });
  world.inspections.push({ id: safeStopRequestId, riskAcceptanceId: riskId,
    riskAcceptanceDigest: riskDigest });
  world.evidence.push({ id: evidenceId, inspectionId: safeStopRequestId,
    requestKind: "safe_stop", verified: true, reason: null,
    evidenceDigest: "2".repeat(64) });
  const check = { id: checkId, requestDigest: "3".repeat(64),
    riskAcceptanceId: riskId, riskAcceptanceDigest: riskDigest,
    sourceEvidenceId: evidenceId, sourceEvidenceDigest: "2".repeat(64),
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, taskRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    workerName: "claude-test", workerInstanceId: instanceId, workerGeneration: 2,
    targetHost: "amux-ubuntu", launchBindingId: requestId,
    briefDigest: "4".repeat(64), provider: "anthropic", modelId: "claude-opus",
    routeId: "route-1", routePolicyDigest: "5".repeat(64),
    catalogApprovalId: "catalog-id", catalogVersion: "catalog-1",
    pricingVersion: "price-1", costReceiptDigest: "6".repeat(64),
    costDigest: "8".repeat(64), additionalCapMicroUsd: BigInt(3_400_000),
    worstExposureMicroUsd: BigInt(6_800_000), launchScope: nominalScope,
    launchScopeDigest: amuxV22ReadOnlyLaunchScopeDigest(nominalScope),
    authorizationAuditLogId: "audit-check", requestedAt: now };
  world.launchChecks.push(check);
  world.audits.push({ id: "audit-check", action: "amux.v22.recovery.read_only_launch_requested",
    targetType: "AmuxV22ReadOnlyLaunchCheck", targetId: checkId,
    actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
    metadata: { systemActor: "amux-v22-recovery-controller" }, entryHash: "9".repeat(64) });
  const report = { requestKind: "read_only_launch_check" as const,
    launchCheckId: checkId, requestDigest: check.requestDigest,
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, taskRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    workerName: check.workerName, workerInstanceId: instanceId, workerGeneration: 2,
    targetHost: "amux-ubuntu" as const, sourceEvidenceId: evidenceId,
    sourceEvidenceDigest: check.sourceEvidenceDigest, riskAcceptanceId: riskId,
    riskAcceptanceDigest: riskDigest, launchBindingId: requestId,
    briefDigest: check.briefDigest, provider: "anthropic", modelId: "claude-opus",
    routeId: "route-1", routePolicyDigest: check.routePolicyDigest,
    catalogApprovalId: "catalog-id", catalogVersion: "catalog-1",
    pricingVersion: "price-1", costReceiptDigest: check.costReceiptDigest,
    additionalCapMicroUsd: "3400000", worstExposureMicroUsd: "6800000",
    launchScope: actualScope, launchProofId: proofId, observation: "current" as const };
  const parsedReport = amuxV22ReadOnlyLaunchProofSchema.parse(report);
  const recorded = await service.reportAmuxV22ReadOnlyLaunchProof(parsedReport);
  assert.equal(recorded.recorded, true);
  assert.equal(world.launchProofs[0]!.verified, true);
  assert.equal((world.launchProofs[0]!.report as typeof report).launchScope.launcherConfigDigest,
    actualScope.launcherConfigDigest);
  assert.equal((world.audits.at(-1)!.metadata as Row).launchScopeDigest,
    amuxV22ReadOnlyLaunchScopeDigest(actualScope));
  await assert.rejects(service.reportAmuxV22ReadOnlyLaunchProof(
    amuxV22ReadOnlyLaunchProofSchema.parse({ ...report,
    launchProofId: "8b465370-568a-4a78-b9dd-31dfd5413f95",
    launchScope: { ...actualScope, toolPolicyDigest: "0".repeat(64) } })),
  /read_only_launch_binding_mismatch/);
  assert.equal(world.launchProofs.length, 1);
});
test("only an exact read-only protocol capability can create a launch check", async () => {
  for (const capabilities of [[], ["legacy_v1"],
    ["read_only_retry_v1", "unexpected_v2"]]) {
    await prepareUnknownRiskSafeStop(capabilities);
    assert.equal(world.launchChecks.length, 0, JSON.stringify(capabilities));
    assert.equal(world.approvals.length, 0, JSON.stringify(capabilities));
    assert.equal(world.task.status, "blocked", JSON.stringify(capabilities));
  }
});
test("the exact API capability binds a server-priced v40 frame through final consent", async () => {
  const { service } = await prepareUnknownRiskSafeStop(["read_only_api_retry_v1"]);
  assert.equal(world.launchChecks.length, 1);
  const check = world.launchChecks[0]!;
  assert.deepEqual(Object.keys(check.launchScope as Row).sort(), [
    "apiExecutionFrameDigest", "executorKind", "launcherConfigDigest", "version",
  ]);
  assert.equal((check.launchScope as Row).executorKind, "read_only_api_retry_v1");
  const checkAudit = world.audits.find((row) =>
    row.action === "amux.v22.recovery.read_only_launch_requested")!;
  assert.equal((checkAudit.metadata as Row).policyVersion, 42);
  const pending = await service.pendingAmuxV22LegacySafeStops();
  const launch = pending.requests.find((candidate) => "launchCheckId" in candidate);
  assert.ok(launch && "apiExecutionFrame" in launch);
  const launchFrame = launch.apiExecutionFrame;
  assert.ok(launchFrame);
  assert.equal(launchFrame.executorKind, "read_only_api_retry_v1");
  assert.equal(launchFrame.maximumCostMicroUsd, 3_400_000);
  assert.equal(launchFrame.credentialProfileId, "first-task-anthropic");
  assert.equal(JSON.stringify(launch).includes("apiKey"), false);
  const ready = await submitReadOnlyLaunchProof();
  assert.equal(world.launchProofs.length, 1);
  assert.equal((world.launchProofs[0]!.report as Row).apiExecutionFrame !== undefined, true);
  assert.equal(ready.eligibility.approveAttempt, false);
  assert.equal(ready.eligibility.reason, "api_model_access_required");
  const accessService = await loadApiAccess();
  const pendingAccess = await accessService.pendingAmuxV22ApiModelAccess("codex-test");
  assert.equal(pendingAccess.requests.length, 1);
  const accessRequest = pendingAccess.requests[0]!;
  const accessResult = amuxV22ApiModelAccessResult(accessRequest, {
    access: "verified", canonicalModelId: accessRequest.selectedModelId, reason: null,
  });
  const accessReceipt = await accessService.reportAmuxV22ApiModelAccess(accessResult);
  assert.equal(accessReceipt.accepted, true);
  assert.equal(accessReceipt.access, "verified");
  assert.equal(world.apiModelAccessEvidence.length, 1);
  const readyWithAccess = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, safeStopRequestId);
  assert.equal(readyWithAccess.eligibility.approveAttempt, true);
  assert.equal(readyWithAccess.apiModelAccess?.state, "verified");
  const approved = await service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    requestId: approvalRequestId, inspectionId: readyWithAccess.inspectionId!,
    evidenceId: readyWithAccess.evidenceId!, evidenceDigest: readyWithAccess.evidenceDigest!,
    costDigest: readyWithAccess.cost!.costDigest,
    riskAcceptanceId: readyWithAccess.riskAcceptance!.id,
    riskAcceptanceDigest: readyWithAccess.riskAcceptance!.digest,
    launchProofId: readyWithAccess.launchProof!.id,
    launchProofDigest: readyWithAccess.launchProof!.digest, acceptRetry: true });
  assert.equal(approved.state, "approved");
  assert.equal(world.approvals.length, 1);
  assert.equal((world.audits.at(-1)!.metadata as Row).policyVersion, 42);
  assert.equal(world.approvals[0]!.profileConfigDigest, null);
  const prisma = new PrismaClient({ adapter: new PrismaPg({
    connectionString: "postgresql://local-test:local-test@127.0.0.1:1/local-test",
  }) });
  const transaction = new Proxy(prisma, { get(target, property) {
    return Reflect.has(tx, property) ? Reflect.get(tx, property) :
      Reflect.get(target, property, target);
  } });
  try {
    const authority = await service.readAmuxV22RecoveryAuthority(transaction,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, 8, approved.approvalId);
    assert.equal(authority?.readOnlyExecutorKind, "read_only_api_retry_v1");
    assert.deepEqual(authority?.apiExecutionFrame, launchFrame);
    world.approvals[0]!.profileConfigDigest = "4".repeat(64);
    await assert.rejects(service.readAmuxV22RecoveryAuthority(transaction,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, 8, approved.approvalId),
    /recovery_approval_unbound/);
  } finally { await prisma.$disconnect(); }
});
test("v47: a time-stamped receipt still binds the launch check through read and final consent", async () => {
  const { service } = await prepareUnknownRiskSafeStop(["read_only_api_retry_v1"], new Date(now));
  const check = world.launchChecks[0]!;
  await submitReadOnlyLaunchProof();
  const accessService = await loadApiAccess();
  const accessRequest = (await accessService.pendingAmuxV22ApiModelAccess("codex-test")).requests[0]!;
  await accessService.reportAmuxV22ApiModelAccess(amuxV22ApiModelAccessResult(accessRequest, {
    access: "verified", canonicalModelId: accessRequest.selectedModelId, reason: null }));
  const ready = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, safeStopRequestId);
  // Before v47 every later calculation produced another digest, so the read
  // dropped the cost (the panel showed "changed") and approval refused.
  assert.equal(ready.launchProof?.state, "current");
  assert.equal(ready.cost?.costReceiptDigest, check.costReceiptDigest);
  assert.equal(ready.eligibility.approveAttempt, true);
  const approved = await service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    requestId: approvalRequestId, inspectionId: ready.inspectionId!,
    evidenceId: ready.evidenceId!, evidenceDigest: ready.evidenceDigest!,
    costDigest: ready.cost!.costDigest,
    riskAcceptanceId: ready.riskAcceptance!.id, riskAcceptanceDigest: ready.riskAcceptance!.digest,
    launchProofId: ready.launchProof!.id, launchProofDigest: ready.launchProof!.digest,
    acceptRetry: true });
  assert.equal(approved.state, "approved");
  assert.equal(world.approvals[0]!.costReceiptDigest, check.costReceiptDigest);
});
test("v48: final consent excuses only a cost reconfirmation it actually covers", async () => {
  const { service } = await prepareUnknownRiskSafeStop(["read_only_api_retry_v1"]);
  await submitReadOnlyLaunchProof();
  const accessService = await loadApiAccess();
  const accessRequest = (await accessService.pendingAmuxV22ApiModelAccess("codex-test")).requests[0]!;
  await accessService.reportAmuxV22ApiModelAccess(amuxV22ApiModelAccessResult(accessRequest, {
    access: "verified", canonicalModelId: accessRequest.selectedModelId, reason: null }));
  const ready = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, safeStopRequestId);
  const approve = (requestId: string) => service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID, requestId,
    inspectionId: ready.inspectionId!, evidenceId: ready.evidenceId!,
    evidenceDigest: ready.evidenceDigest!, costDigest: ready.cost!.costDigest,
    riskAcceptanceId: ready.riskAcceptance!.id, riskAcceptanceDigest: ready.riskAcceptance!.digest,
    launchProofId: ready.launchProof!.id, launchProofDigest: ready.launchProof!.digest,
    acceptRetry: true });
  world.ready = false;
  // Another readiness reason is never excused.
  world.readyReasons = ["cost_reconfirmation_required", "dependency_incomplete"];
  await assert.rejects(approve("8b0e7c1d-5f2a-4c39-9e6d-1a2b3c4d5e60"), /task_not_ready/);
  // A reconfirmation the consent does not cover (no registered receipt) refuses.
  world.readyReasons = ["cost_reconfirmation_required"];
  await assert.rejects(approve("8b0e7c1d-5f2a-4c39-9e6d-1a2b3c4d5e61"), /task_not_ready/);
  // An unreadable registered receipt cannot show the route was added: refuse.
  world.sourceReceipt = "unparseable";
  await assert.rejects(approve("8b0e7c1d-5f2a-4c39-9e6d-1a2b3c4d5e62"), /task_not_ready/);
  assert.equal(world.approvals.length, 0);
});
test("API access selects the fresh proof and refuses stale, drifted and alias-mismatched authority", async () => {
  const { service } = await prepareUnknownRiskSafeStop(["read_only_api_retry_v1"]);
  await submitReadOnlyLaunchProof();
  const freshProof = world.launchProofs[0]!;
  const freshCheck = world.launchChecks[0]!;
  const staleProofId = "8b465370-568a-4a78-b9dd-31dfd5413f95";
  const staleCheckId = "cd3bbc7f-ed3f-438d-8ae9-77906ca4a8a2";
  world.launchChecks.unshift({ ...freshCheck, id: staleCheckId });
  world.launchProofs.unshift({ ...freshProof, id: staleProofId,
    launchCheckId: staleCheckId,
    recordedAt: new Date(now.getTime() - 91_000) });
  const accessService = await loadApiAccess();
  const pending = await accessService.pendingAmuxV22ApiModelAccess("codex-test");
  assert.equal(pending.requests.length, 1);
  assert.equal(pending.requests[0]!.requestId, freshProof.id,
    "a stale earlier proof must not hide the fresh authorization");
  const request = pending.requests[0]!;
  world.launchChecks = world.launchChecks.filter((row) => row.id !== staleCheckId);
  world.launchProofs = world.launchProofs.filter((row) => row.id !== staleProofId);

  freshProof.recordedAt = new Date(now.getTime() - 91_000);
  await assert.rejects(accessService.reportAmuxV22ApiModelAccess(
    amuxV22ApiModelAccessResult(request, { access: "verified",
      canonicalModelId: request.selectedModelId, reason: null })),
  /api_model_access_binding_mismatch/);
  assert.equal(world.apiModelAccessEvidence.length, 0);
  freshProof.recordedAt = now;

  world.retryRuntime.instanceId = "drifted-instance";
  await assert.rejects(accessService.reportAmuxV22ApiModelAccess(
    amuxV22ApiModelAccessResult(request, { access: "verified",
      canonicalModelId: request.selectedModelId, reason: null })),
  /api_model_access_binding_mismatch/);
  assert.equal(world.apiModelAccessEvidence.length, 0);
  world.retryRuntime.instanceId = freshCheck.workerInstanceId;

  const alias = await accessService.reportAmuxV22ApiModelAccess(
    amuxV22ApiModelAccessResult(request, { access: "verified",
      canonicalModelId: "claude-canonical-not-approved", reason: null }));
  assert.equal(alias.accepted, true);
  // The Rust client parses these bodies with deny_unknown_fields; keep the
  // service's real answers key-identical to the shared wire fixture.
  const wire = JSON.parse(readFileSync(resolve(import.meta.dirname, "../..",
    "tests/fixtures/amux-v22-api-model-access-wire-v1.json"), "utf8"));
  assert.deepEqual(Object.keys(alias).sort(), Object.keys(wire.recorded).sort());
  const readback = await accessService.readAmuxV22ApiModelAccess(alias.evidenceId);
  assert.deepEqual(Object.keys(readback).sort(), Object.keys(wire.readback).sort());
  assert.deepEqual(Object.keys(readback.evidence ?? {}).sort(),
    Object.keys(wire.readback.evidence).sort());
  assert.deepEqual(await accessService.readAmuxV22ApiModelAccess(
    "00000000-0000-4000-8000-0000000000ff"), wire.readbackMissing);
  const blocked = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, safeStopRequestId);
  assert.equal(blocked.apiModelAccess?.state, "catalog_mismatch");
  assert.equal(blocked.eligibility.approveAttempt, false);
  assert.equal(blocked.eligibility.reason,
    "canonical_catalog_approval_required");
  assert.equal(world.approvals.length, 0);
});
test("a late model-access report cannot extend the launch proof deadline at claim or start", async () => {
  const service = await load();
  const proofAt = new Date("2026-10-13T00:00:00.000Z");
  const at = (ms: number) => new Date(proofAt.getTime() + ms);
  const authority = (evidenceAt: Date, launchProofRecordedAt: Date | null = proofAt) => ({
    readOnlyExecutorKind: "read_only_api_retry_v1", modelId: "claude-opus-5-5",
    launchProofRecordedAt, apiModelAccessEvidence: { accessState: "verified",
      balanceKnown: false, canonicalModelId: "claude-opus-5-5",
      selectedModelId: "claude-opus-5-5", recordedAt: evidenceAt } });
  // proof/GET at T0, cached result reported at T0+89 s: still bounded by T0+90 s.
  assert.equal(service.amuxV22ApiModelAccessCurrent(authority(at(89_000)), at(90_000)), true);
  assert.equal(service.amuxV22ApiModelAccessCurrent(authority(at(89_000)), at(90_001)), false);
  assert.equal(service.amuxV22ApiModelAccessCurrent(authority(at(89_000)), at(179_000)), false);
  assert.equal(service.amuxV22ApiModelAccessCurrent(authority(at(1_000), null), at(2_000)), false);
  assert.equal(service.amuxV22ApiModelAccessCurrent(authority(at(-1), proofAt), at(2_000)), false,
    "evidence older than its launch proof is not bound to it");
  assert.equal(service.amuxV22ApiModelAccessCurrent({ ...authority(at(1_000)),
    readOnlyExecutorKind: "read_only_retry_v1" }, at(500_000)), true,
    "the CLI recovery path does not use API model access");
});
test("final consent rechecks the exact runtime capability before any approval or Task write", async () => {
  for (const capabilities of [[], ["legacy_v1"],
    ["read_only_retry_v1", "unexpected_v2"]]) {
    const { service } = await prepareUnknownRiskSafeStop();
    assert.equal(world.launchChecks.length, 1);
    const ready = await submitReadOnlyLaunchProof();
    assert.ok(ready.cost, "launch binding must remain current");
    world.retryRuntime.protocolCapabilities = capabilities;
    await assert.rejects(service.approveAmuxV22TaskRecovery({ session: owner,
      request: new Request("https://tomverse.test"), action: "approve_attempt",
      taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
      priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
      requestId: approvalRequestId, inspectionId: ready.inspectionId!,
      evidenceId: ready.evidenceId!, evidenceDigest: ready.evidenceDigest!,
      costDigest: ready.cost!.costDigest,
      riskAcceptanceId: ready.riskAcceptance!.id,
      riskAcceptanceDigest: ready.riskAcceptance!.digest,
      launchProofId: ready.launchProof!.id,
      launchProofDigest: ready.launchProof!.digest, acceptRetry: true }),
    /read_only_launch_proof_unverified/);
    assert.equal(world.approvals.length, 0, JSON.stringify(capabilities));
    assert.equal(world.task.status, "blocked", JSON.stringify(capabilities));
    assert.equal(world.task.revision, 7, JSON.stringify(capabilities));
  }
});
test("a current owner can resume the exact unconsumed risk with a fresh GET nonce", async () => {
  const { service, riskRequestId } = await prepareUnknownRiskSafeStop();
  const freshRequestId = "6f9bd126-0cc4-4a41-9075-95eeb65048a8";
  const resumed = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, freshRequestId);
  assert.equal(resumed.requestId, freshRequestId);
  assert.equal(resumed.riskAcceptance?.ownerRequestId, riskRequestId);
  assert.equal(resumed.requestKind, "safe_stop");
  assert.equal(resumed.inspectionId,
    world.inspections.find((item) => item.requestKind === "safe_stop")!.id);
  const otherOwner = await service.readAmuxV22TaskRecovery({
    user: { id: "owner-2" }, expires: owner.expires },
  AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, freshRequestId);
  assert.equal(otherOwner.state, "not_visible");
  const otherTask = await service.readAmuxV22TaskRecovery(owner,
    "task-outside-approved-scope", freshRequestId);
  assert.equal(otherTask.state, "not_visible");
  const riskAcceptanceId = world.risks[0]!.id;
  world.approvals.push({ id: "consumed-approval", ownerRequestId: approvalRequestId,
    riskAcceptanceId });
  const consumed = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, "eac90d46-9c96-4988-95f3-95b83db4982b");
  assert.equal(consumed.state, "not_visible");
  world.approvals.pop();
  world.task.revision = 8;
  const changedRevision = await service.readAmuxV22TaskRecovery(owner,
    AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, "1ae14ea5-7ef0-4e77-bf25-02c28f1a402f");
  assert.equal(changedRevision.state, "not_visible");
  assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
});
test("an approved read-only snapshot remains valid 91 seconds after proof freshness", async () => {
  const { service } = await prepareUnknownRiskSafeStop();
  const ready = await submitReadOnlyLaunchProof();
  const approved = await service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    requestId: approvalRequestId, inspectionId: ready.inspectionId!,
    evidenceId: ready.evidenceId!, evidenceDigest: ready.evidenceDigest!,
    costDigest: ready.cost!.costDigest,
    riskAcceptanceId: ready.riskAcceptance!.id,
    riskAcceptanceDigest: ready.riskAcceptance!.digest,
    launchProofId: ready.launchProof!.id,
    launchProofDigest: ready.launchProof!.digest, acceptRetry: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg({
    connectionString: "postgresql://local-test:local-test@127.0.0.1:1/local-test",
  }) });
  const transaction = new Proxy(prisma, { get(target, property) {
    return Reflect.has(tx, property) ? Reflect.get(tx, property) :
      Reflect.get(target, property, target);
  } });
  try {
    const authority = await service.readAmuxV22RecoveryAuthority(transaction,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, 8, approved.approvalId,
      new Date(now.getTime() + 91_000));
    assert.equal(authority?.id, approved.approvalId);
    assert.equal(typeof world.approvals[0]!.profileConfigDigest, "string");
    world.approvals[0]!.profileConfigDigest = null;
    await assert.rejects(service.readAmuxV22RecoveryAuthority(transaction,
      AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, 8, approved.approvalId),
    /recovery_approval_unbound/);
  } finally { await prisma.$disconnect(); }
});
test("approval rechecks evidence freshness, ready, costs, incident, allowance, and compare-and-set", async () => {
  const service = await load();
  for (const mutation of ["evidence", "future", "generation", "ready", "cost", "incident", "allowance", "cas"] as const) {
    reset(); await requestInspection(); const input = await approvalInput();
    if (mutation === "evidence") world.evidence[0]!.recordedAt = new Date(now.getTime() - 90_001);
    if (mutation === "future") world.evidence[0]!.recordedAt = new Date(now.getTime() + 1);
    if (mutation === "generation") world.runtime.generation = 3;
    if (mutation === "ready") world.ready = false;
    if (mutation === "cost") world.cap = "3400001";
    if (mutation === "incident") world.incident = true;
    if (mutation === "allowance") world.costAdmission = false;
    if (mutation === "cas") world.cas = false;
    await assert.rejects(service.approveAmuxV22TaskRecovery(input));
    assert.equal(world.task.status, "blocked", mutation); assert.equal(world.approvals.length, 0, mutation);
    assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0, mutation);
  }
});
test("a newly verified standalone inspection does not require the halted bridge to heartbeat", async () => {
  reset(); const service = await load();
  world.runtime.heartbeatAt = new Date(now.getTime() - 600_000);
  world.runtime.leaseExpiresAt = new Date(now.getTime() - 500_000);
  await requestInspection(); const input = await approvalInput();
  assert.equal(world.evidence[0]!.verified, true);
  const recordedAt = world.evidence[0]!.recordedAt;
  const result = await service.approveAmuxV22TaskRecovery(input);
  assert.equal(result.state, "approved");
  assert.deepEqual(world.evidence[0]!.recordedAt, recordedAt);
  assert.equal((world.runtime.leaseExpiresAt as Date).getTime() < now.getTime(), true);
});
test("evidence cannot echo a different attempt into trusted inspection authority", async () => {
  reset(); await requestInspection();
  await assert.rejects(submitEvidence({ priorAttemptId: requestId }), /inspection_binding_mismatch/);
  assert.equal(world.evidence.length, 0);
  assert.equal(amuxV22RecoveryDigest("inspection", { task: "one" }).length, 64);
});
test("a complete receipt with unknown actual cost retains the prior cap and never releases zero", async () => {
  reset(); await requestInspection();
  const read = await submitEvidence({ usage: { status: "reported_complete", projectedCostMicroUsd: null } });
  assert.equal(read.state, "verified"); assert.equal(read.cost!.oldHeldMicroUsd, "3400000");
  assert.equal(read.cost!.worstExposureMicroUsd, "6800000");
  assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
});
test("legacy safe-stop derives its immutable physical profile and preserves exact source read-back", async () => {
  reset(); const service = await load();
  const { source, read } = await requestSafeStop();
  assert.equal(read.state, "pending"); assert.equal(read.requestKind, "safe_stop");
  assert.equal(read.sourceEvidenceId, source.evidenceId);
  assert.equal(read.sourceEvidenceDigest, source.evidenceDigest);
  assert.equal(read.workerProfileAlias, "profile-one");
  assert.deepEqual(read.profileWorkerNames, ["claude-test"]);
  assert.equal(read.targetUnit, "tomverse-amux-v22-sidecar@profile-one.service");
  assert.equal(typeof read.profileConfigDigest, "string");
  assert.deepEqual(await service.pendingAmuxV22RecoveryInspections("claude-test"), { requests: [] });
  const pending = await service.pendingAmuxV22LegacySafeStops();
  assert.equal(pending.requests.length, 1);
  assert.deepEqual(Object.keys(pending.requests[0]!).sort(), ["inspectionId", "priorAttemptId",
    "priorAttemptTaskRevision", "profileConfigDigest", "profileWorkerNames", "requestDigest",
    "requestKind", "requestedAt", "sourceEvidenceDigest", "sourceEvidenceId", "targetHost",
    "targetUnit", "taskId", "taskRevision", "workerGeneration", "workerInstanceId",
    "workerName", "workerProfileAlias"].sort());
});
test("verified safe-stop is audited once, remains permanently fenced, and authorizes only a new worker claim", async () => {
  reset(); const service = await load(); await requestSafeStop();
  const reported = await submitSafeStop();
  assert.equal(reported.verified, true); assert.equal(reported.reason, null);
  const safeRead = await service.readAmuxV22TaskRecovery(owner, "task-1234", safeStopRequestId);
  assert.equal(safeRead.state, "verified");
  assert.equal(safeRead.stopAcknowledgement, "acknowledged");
  assert.equal(safeRead.processState, "gone");
  const approval = await service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    requestId: approvalRequestId, inspectionId: safeRead.inspectionId!,
    evidenceId: safeRead.evidenceId!, evidenceDigest: safeRead.evidenceDigest!,
    costDigest: safeRead.cost!.costDigest });
  assert.equal(approval.state, "approved"); assert.equal(world.task.status, "todo");
  assert.equal(world.task.owner, null); assert.equal(world.attemptWrites + world.ledgerWrites, 0);
});
test("safe-stop closes request and report races when profile work appears", async () => {
  reset(); await requestLegacySafeStopSource(); world.otherWork = true;
  const service = await load();
  const source = world.evidence[0]!;
  await assert.rejects(service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    sourceEvidenceId: source.id as string, sourceEvidenceDigest: source.evidenceDigest as string,
    requestId: safeStopRequestId }), /safe_stop_other_work_present/);
  assert.equal(world.inspections.filter((item) => item.requestKind === "safe_stop").length, 0);

  reset(); await requestSafeStop(); world.otherWork = true;
  const reported = await submitSafeStop();
  assert.equal(reported.verified, false);
  assert.equal(reported.reason, "safe_stop_other_work_present");
  const safeInspection = world.inspections.find((item) => item.requestKind === "safe_stop")!;
  const safeEvidence = world.evidence.find((item) => item.inspectionId === safeInspection.id)!;
  const read = await service.readAmuxV22TaskRecovery(owner, "task-1234", safeStopRequestId);
  await assert.rejects(service.approveAmuxV22TaskRecovery({ session: owner,
    request: new Request("https://tomverse.test"), action: "approve_attempt",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    requestId: approvalRequestId, inspectionId: safeInspection.id as string,
    evidenceId: safeEvidence.id as string, evidenceDigest: safeEvidence.evidenceDigest as string,
    costDigest: read.cost!.costDigest }), /recovery_evidence_unverified/);
  assert.equal(world.task.status, "blocked");
});

test("v46: a re-registered worker keeps a legacy reason and its safe stop binds the live runtime", async () => {
  reset(); const service = await load();
  world.task.taskRole = "investigate";
  await requestInspection();
  // The bridge re-registers after the prior attempt: a new instance and generation.
  const liveInstance = "0f5a2c9e-6d1b-4e3a-9c7f-2b8d4e6a1c03";
  world.runtime.instanceId = liveInstance; world.runtime.generation = 7;
  const source = await submitEvidence({ hostInvocationId: null, reason: "legacy_invocation_unbound",
    proof: { terminalOutcome: "unknown", sameLiveInvocation: false,
      noActiveExecution: false, processTreeStopped: false, rootOwnedUnit: false,
      controlGroupBound: false, journalBound: false, socketTerminal: false,
      externalEffectsKnown: true, workspaceClean: true } });
  assert.equal(source.state, "unverified");
  assert.equal(source.reason, "legacy_invocation_unbound");
  const inspect = world.inspections.find((item) => item.requestKind === "inspect")!;
  assert.equal(inspect.workerInstanceId, instanceId);
  assert.equal(inspect.workerGeneration, 2);
  const read = await service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
    requestId: safeStopRequestId });
  assert.equal(read.state, "pending");
  const stop = world.inspections.find((item) => item.requestKind === "safe_stop")!;
  assert.equal(stop.workerInstanceId, liveInstance);
  assert.equal(stop.workerGeneration, 7);
  const pending = await service.pendingAmuxV22LegacySafeStops();
  assert.equal(pending.requests[0]!.workerInstanceId, liveInstance);
  assert.equal(pending.requests[0]!.workerGeneration, 7);
});

test("v46: a proof that would verify still refuses a changed runtime", async () => {
  reset(); await requestInspection();
  world.runtime.instanceId = "0f5a2c9e-6d1b-4e3a-9c7f-2b8d4e6a1c03"; world.runtime.generation = 7;
  const read = await submitEvidence();
  assert.equal(read.state, "unverified");
  assert.equal(read.reason, "runtime_observation_unverified");
});

test("v46: a safe stop bound to the live runtime cannot seed a chained re-request", async () => {
  reset(); const service = await load();
  world.task.taskRole = "investigate";
  await requestInspection();
  world.runtime.instanceId = "0f5a2c9e-6d1b-4e3a-9c7f-2b8d4e6a1c03"; world.runtime.generation = 7;
  const source = await submitEvidence({ hostInvocationId: null, reason: "legacy_invocation_unbound",
    proof: { terminalOutcome: "unknown", sameLiveInvocation: false,
      noActiveExecution: false, processTreeStopped: false, rootOwnedUnit: false,
      controlGroupBound: false, journalBound: false, socketTerminal: false,
      externalEffectsKnown: true, workspaceClean: true } });
  await service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    sourceEvidenceId: source.evidenceId!, sourceEvidenceDigest: source.evidenceDigest!,
    requestId: safeStopRequestId });
  const stop = world.inspections.find((item) => item.requestKind === "safe_stop")!;
  // A stored safe-stop evidence row stands in for the controller's report.
  const stopEvidenceId = "1d4e6f80-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
  world.evidence.push({ id: stopEvidenceId, inspectionId: stop.id, requestKind: "safe_stop",
    sourceEvidenceId: stop.sourceEvidenceId, sourceEvidenceDigest: stop.sourceEvidenceDigest,
    evidenceDigest: "e".repeat(64), verified: true, reason: null,
    authorizationAuditLogId: "audit-chained-stop", report: {}, recordedAt: new Date() });
  world.audits.push({ id: "audit-chained-stop", action: "amux.v22.recovery.safe_stop_reported",
    targetType: "AmuxV22TaskRecoveryEvidence", targetId: stopEvidenceId, entryHash: "d".repeat(64),
    actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
    metadata: { systemActor: "amux-v22-recovery-controller" } });
  stop.evidence = world.evidence.at(-1);
  const before = world.inspections.length;
  await assert.rejects(service.requestAmuxV22LegacySafeStop({ session: owner,
    request: new Request("https://tomverse.test"), action: "request_safe_stop",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    sourceEvidenceId: stopEvidenceId, sourceEvidenceDigest: "e".repeat(64),
    requestId: "8a1f3c5e-7b9d-4e2f-a6c8-0d2e4f6a8b1c" }), /safe_stop_source_mismatch/);
  assert.equal(world.inspections.length, before);
});

// Owner decision 2026-11-08: one click requests the inspection and records a
// single-use consent; verified evidence applies it with the manual checks.
async function preApprove(change: { costDigest?: string; taskId?: string } = {}) {
  const service = await load();
  const quote = await service.readAmuxV22RecoveryPreApprovalQuote(owner, "task-1234");
  assert.equal(quote.eligible, true); assert.equal(quote.expiresInMinutes, 30);
  return service.requestAmuxV22RecoveryPreApproval({ session: owner,
    request: new Request("https://tomverse.test"), action: "preapprove_attempt",
    taskId: change.taskId ?? "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    requestId, costDigest: change.costDigest ?? quote.cost!.costDigest, acceptRetry: true });
}
const actions = () => world.audits.map((row) => row.action);

test("one click: verified evidence after the consent opens exactly one capped attempt", async () => {
  reset(); const service = await load(); const old = structuredClone(world.attempt);
  const requested = await preApprove();
  assert.equal(requested.state, "pending"); assert.equal(requested.preApproval?.state, "waiting");
  assert.equal(world.task.status, "blocked"); assert.equal(world.approvals.length, 0);
  const pre = world.preApprovals[0]!;
  assert.equal((pre.expiresAt as Date).getTime() - (pre.requestedAt as Date).getTime(), 30 * 60_000);
  assert.equal(pre.additionalCapMicroUsd, BigInt(3_400_000));
  const pending = await service.pendingAmuxV22RecoveryInspections("claude-test");
  assert.equal(pending.requests[0]!.inspectionId, requested.inspectionId);
  const read = await submitEvidence();
  assert.equal(read.state, "approved"); assert.equal(read.preApproval?.state, "applied");
  assert.equal(read.preApproval?.approvalId, read.approvalId);
  assert.equal(world.task.status, "todo"); assert.equal(world.task.revision, 9);
  assert.equal(world.approvals.length, 1);
  assert.equal(world.approvals[0]!.preApprovalId, pre.id);
  assert.equal(world.approvals[0]!.approvedByUserId, "owner-1");
  assert.equal(world.approvals[0]!.ownerRequestId, requestId);
  assert.equal(world.preApprovalResults.length, 1);
  assert.equal(world.preApprovalResults[0]!.outcome, "applied");
  assert.deepEqual(actions(), ["amux.v22.recovery.requested", "amux.v22.recovery.preapproved",
    "amux.v22.recovery.inspected", "amux.v22.recovery.preapproval_applied",
    "amux.v22.recovery.preapproval_settled"]);
  const applied = world.audits.find((row) => row.action === "amux.v22.recovery.preapproval_applied")!;
  assert.equal((applied.metadata as Row).systemActor, "amux-v22-recovery-preapproval");
  assert.equal((applied.metadata as Row).preApprovalId, pre.id);
  // The applied consent accepts the earlier unknown-usage attempt for its owner.
  assert.deepEqual((applied.metadata as Row).acceptedUnknownUsageAttemptIds, [attemptId]);
  assert.deepEqual(world.usageAcceptances.map((row) => [row.attemptId, row.source,
    row.acceptedByUserId, row.authorizationAuditLogId]),
  [[attemptId, "recovery_approval", "owner-1", applied.id]]);
  const authority = await service.readAmuxV22RecoveryAuthority(tx as never, "task-1234", 9);
  assert.equal(authority?.id, read.approvalId);
  assert.deepEqual(world.attempt, old);
  assert.equal(world.changedOld + world.ledgerWrites + world.attemptWrites, 0);
});

test("one click: a consent is used once, and a replayed report or sweep opens nothing more", async () => {
  reset(); const service = await load(); await preApprove(); await submitEvidence();
  const audits = world.audits.length;
  await submitEvidence();
  await service.pendingAmuxV22RecoveryInspections("claude-test");
  assert.equal(await service.settleAmuxV22RecoveryPreApproval({
    id: world.preApprovals[0]!.id as string, taskId: "task-1234" }), "applied");
  assert.equal(world.approvals.length, 1); assert.equal(world.preApprovalResults.length, 1);
  assert.equal(world.audits.length, audits); assert.equal(world.task.revision, 9);
  // A reused request id cannot name another cost.
  await assert.rejects(service.requestAmuxV22RecoveryPreApproval({ session: owner,
    request: new Request("https://tomverse.test"), action: "preapprove_attempt",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId, requestId,
    costDigest: "0".repeat(64), acceptRetry: true }), /request_id_reused/);
});

test("one click: an expired consent, a failed proof or a changed revision opens nothing", async () => {
  for (const scenario of ["expired", "proof", "revision", "cost"] as const) {
    reset(); await preApprove();
    if (scenario === "expired") world.preApprovals[0]!.expiresAt = new Date(now.getTime() - 1);
    if (scenario === "revision") world.task.revision = 9;
    if (scenario === "cost") world.cap = "3500000";
    const read = await submitEvidence(scenario === "proof" ? { reason: "terminal_success",
      proof: { terminalOutcome: "succeeded", sameLiveInvocation: true, noActiveExecution: true,
        processTreeStopped: true, rootOwnedUnit: true, controlGroupBound: true, journalBound: true,
        socketTerminal: true, externalEffectsKnown: true, workspaceClean: true } } : {}).catch(() => null);
    assert.equal(world.approvals.length, 0, scenario);
    assert.equal(world.task.status, "blocked", scenario);
    assert.equal(world.preApprovalResults.length, 1, scenario);
    const result = world.preApprovalResults[0]!;
    assert.equal(result.outcome, "refused", scenario);
    assert.equal(result.reason, { expired: "preapproval_expired", proof: "terminal_success",
      revision: "recovery_identity_changed", cost: "recovery_cost_changed" }[scenario], scenario);
    assert.equal(actions().at(-1), "amux.v22.recovery.preapproval_settled", scenario);
    if (read && scenario !== "revision") {
      assert.equal(read.preApproval?.state, scenario === "expired" ? "expired" : "refused");
      assert.equal(read.preApproval?.reason, result.reason);
    }
  }
});

test("one click: the server cost binds the consent and the FIRST Task keeps its own steps", async () => {
  reset(); const service = await load();
  await assert.rejects(preApprove({ costDigest: "0".repeat(64) }), /recovery_cost_changed/);
  assert.equal(world.inspections.length, 0); assert.equal(world.preApprovals.length, 0);
  await assert.rejects(service.requestAmuxV22RecoveryPreApproval({ session: owner,
    request: new Request("https://tomverse.test"), action: "preapprove_attempt",
    taskId: AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, expectedRevision: 7,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID, requestId,
    costDigest: "0".repeat(64), acceptRetry: true }), /exact_target_only/);
  await preApprove();
  // A second consent for the same Task waits behind the first.
  await assert.rejects(service.requestAmuxV22RecoveryPreApproval({ session: owner,
    request: new Request("https://tomverse.test"), action: "preapprove_attempt",
    taskId: "task-1234", expectedRevision: 8, priorAttemptId: attemptId,
    requestId: approvalRequestId, costDigest: world.preApprovals[0]!.costDigest as string,
    acceptRetry: true }), /preapproval_pending/);
  const quote = await service.readAmuxV22RecoveryPreApprovalQuote(owner, "task-1234");
  assert.equal(quote.eligible, false); assert.equal(quote.reason, "preapproval_pending");
});

test("manual approval: blocked while a consent waits, and inspect evidence lasts 15 minutes", async () => {
  reset(); const service = await load(); await preApprove();
  world.preApprovals[0]!.expiresAt = new Date(now.getTime() + 60_000);
  // The consent alone may use its inspection while it waits.
  const pending = await service.readAmuxV22TaskRecovery(owner, "task-1234", requestId);
  assert.equal(pending.eligibility.approveAttempt, false);
  reset(); await requestInspection(); const input = await approvalInput();
  world.inspections[0]!.requestedAt = new Date(now.getTime() - 20 * 60_000);
  world.evidence[0]!.recordedAt = new Date(now.getTime() - 16 * 60_000);
  await assert.rejects(service.approveAmuxV22TaskRecovery(input), /recovery_evidence_expired/);
  const stale = await service.readAmuxV22TaskRecovery(owner, "task-1234", requestId);
  assert.equal(stale.reason, "evidence_stale");
  world.evidence[0]!.recordedAt = new Date(now.getTime() - 10 * 60_000);
  const read = await service.approveAmuxV22TaskRecovery(input);
  assert.equal(read.state, "approved"); assert.equal(world.approvals[0]!.preApprovalId, null);
});

// Operator report 2026-11-08: after an approved recovery the Task ran again,
// but the queue still showed the old escalation, and the next stop reused it.
test("an approval resolves the open escalation as a retry, and the next stop opens a new one", async () => {
  for (const path of ["manual", "one-click"] as const) {
    reset(); const service = await load();
    world.escalations.push({ id: "escalation-old", taskId: "task-1234", status: "acknowledged",
      reason: "outcome_unknown" }, { id: "escalation-other", taskId: "task-other", status: "open",
      reason: "outcome_unknown" });
    if (path === "manual") {
      await requestInspection(); await service.approveAmuxV22TaskRecovery(await approvalInput());
    } else { await preApprove(); await submitEvidence(); }
    assert.equal(world.task.status, "todo", path);
    const old = world.escalations.find((row) => row.id === "escalation-old")!;
    assert.equal(old.status, "resolved", path); assert.equal(old.resolutionOutcome, "retry", path);
    assert.equal(old.resolvedById, "owner-1", path);
    assert.ok(old.resolvedAt instanceof Date, path);
    assert.equal(world.escalations.find((row) => row.id === "escalation-other")!.status, "open", path);
    const audit = world.audits.find((row) => row.action === (path === "manual" ?
      "amux.v22.recovery.approved" : "amux.v22.recovery.preapproval_applied"))!;
    assert.deepEqual((audit.metadata as Row).resolvedEscalationIds, ["escalation-old"], path);
    const { openAmuxHumanEscalation } = await import(mod("lib/amux/escalation.ts"));
    const next = await openAmuxHumanEscalation(tx as never, { taskId: "task-1234",
      specialty: null, reason: "outcome_unknown", openedBy: "amux-system" });
    assert.notEqual(next.id, "escalation-old", path);
    assert.equal(world.escalations.filter((row) => row.taskId === "task-1234" &&
      row.status !== "resolved").length, 1, path);
  }
});

// Review 2026-11-08: an incident or halt that passes must not burn the
// consent; and a reopened card must find the waiting consent again.
test("one click: an incident leaves the consent waiting, and a fresh read nonce finds it", async () => {
  reset(); const service = await load(); await preApprove();
  world.incident = true;
  const waiting = await submitEvidence();
  assert.equal(world.preApprovalResults.length, 0); assert.equal(world.approvals.length, 0);
  assert.equal(waiting.preApproval?.state, "waiting");
  // A reopened card reads with another nonce and still sees this consent.
  const reopened = await service.readAmuxV22TaskRecovery(owner, "task-1234",
    "0c1a9db5-b13e-4bf6-97c4-672a024b4a75");
  assert.equal(reopened.preApproval?.id, world.preApprovals[0]!.id);
  assert.equal(reopened.inspectionId, world.preApprovals[0]!.inspectionId);
  assert.equal(reopened.preApproval?.ownerRequestId, requestId);
  // When the incident ends, the checker poll settles it once.
  world.incident = false;
  await service.pendingAmuxV22RecoveryInspections("claude-test");
  assert.equal(world.approvals.length, 1);
  assert.equal(world.preApprovalResults[0]!.outcome, "applied");
  assert.equal(world.task.status, "todo");
});

// Review 2026-11-08: a consent held back by an incident past its expiry still
// ends with a recorded preapproval_expired result.
test("one click: a consent held back past its expiry is recorded as expired", async () => {
  reset(); const service = await load(); await preApprove();
  world.incident = true; await submitEvidence();
  assert.equal(world.preApprovalResults.length, 0);
  world.preApprovals[0]!.expiresAt = new Date(now.getTime() - 1);
  await service.pendingAmuxV22RecoveryInspections("claude-test");
  assert.equal(world.preApprovalResults.length, 1);
  assert.equal(world.preApprovalResults[0]!.reason, "preapproval_expired");
  assert.equal(world.approvals.length, 0); assert.equal(world.task.status, "blocked");
});

// Review r-20261108-104122-945cf1: the receipt digest includes its calculation
// time, so a consent must still apply when the receipt is recomputed later.
test("one click: a later, time-stamped receipt at the same cost still applies the consent", async () => {
  reset(); world.costClock = new Date("2026-10-13T01:00:00.000Z");
  await preApprove();
  const consented = world.preApprovals[0]!.costReceiptDigest;
  const read = await submitEvidence();
  assert.equal(read.state, "approved"); assert.equal(world.approvals.length, 1);
  assert.notEqual(world.approvals[0]!.costReceiptDigest, consented);
  assert.equal(world.approvals[0]!.costDigest, world.preApprovals[0]!.costDigest);
});
