import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { scanAmuxV4Input } from "./localIntakeCore.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { AMUX_EXECUTION_GRADE_CODE_LATCH } from "./executionGradeCore.ts";
import { calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog, inspectV52TaskCatalogGrades,
  type V4TaskCostCatalog } from
  "./v4TaskCostCatalogCore.ts";
import { readAmuxRegistryAndDerivedCatalog } from "./workerAssignmentCatalog.ts";
import { AMUX_TASK_CATALOG_GRADES, draftAmuxV4TaskCostCatalog,
  type AmuxTaskCatalogGradeCaps } from "./v4TaskCostCatalogDraftCore.ts";
import type { AmuxExecutionGrade } from "./executionGradeCore.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BYTES = 262_144;
export const AMUX_V4_TASK_CATALOG_WRITE_CODE_ENABLED = true;
export const AMUX_V4_TASK_CATALOG_WRITE_ENV =
  "TOMVERSE_AMUX_V4_TASK_CATALOG_WRITE";
export const amuxV4TaskCatalogWriteEnabled = (value: string | undefined) =>
  AMUX_V4_TASK_CATALOG_WRITE_CODE_ENABLED && value === "enabled";

export class AmuxV4TaskCatalogApprovalError extends Error {
  constructor(readonly code: "forbidden" | "schema_rejected" |
    "catalog_changed" | "evidence_unverified" | "unavailable" |
    "grade_route_mismatch" | "worker_registry_unavailable" |
    "outcome_unknown") {
    super(code);
    this.name = "AmuxV4TaskCatalogApprovalError";
  }
}

function inspectedCatalog(raw: unknown) {
  let serialized: string;
  try { serialized = amuxCanonicalJson(raw); }
  catch { throw new AmuxV4TaskCatalogApprovalError("schema_rejected"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
    throw new AmuxV4TaskCatalogApprovalError("schema_rejected");
  }
  const inspection = inspectV4TaskCostCatalog(raw);
  if (!inspection.ok) {
    throw new AmuxV4TaskCatalogApprovalError("schema_rejected");
  }
  const catalog = JSON.parse(serialized) as V4TaskCostCatalog;
  const labels = [catalog.catalogVersion, catalog.pricingVersion,
    catalog.gradeRulesVersion,
    ...catalog.gradeRules.flatMap((rule) => [rule.role, rule.grade]),
    ...catalog.routes.flatMap((route) => [route.routeId, route.workerName,
      route.provider, route.modelId, route.pricingSource,
      ...route.roles, ...route.grades])];
  if (labels.some((label) => !scanAmuxV4Input(label).ok)) {
    throw new AmuxV4TaskCatalogApprovalError("schema_rejected");
  }
  return { inspection, catalog };
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxV4TaskCatalogApprovalError("unavailable");
  }
  return rows[0].now;
}

/** Read-only cost evidence preview. Routes come from the worker registry and
 * prices from the model registry the owner manages (owner decision
 * 2026-10-25), never from a model's analysis text. */
export async function previewAmuxV4TaskCatalog(raw: unknown) {
  const { inspection, catalog } = inspectedCatalog(raw);
  const latest = await prisma.amuxV4TaskCostCatalogApproval.findFirst({
    orderBy: { version: "desc" },
    select: { version: true, catalogVersion: true, status: true },
  });
  return { catalogVersion: catalog.catalogVersion,
    pricingVersion: catalog.pricingVersion,
    catalogDigest: inspection.catalogDigest,
    ruleCount: inspection.ruleCount, routeCount: inspection.routeCount,
    expectedPreviousVersion: latest?.version ?? 0,
    currentStatus: latest?.status ?? "none",
    executionAuthorized: false as const };
}

/** An owner-approved immutable catalog version. Approval itself never starts
 * a Task or changes a user credit balance. */
export async function approveAmuxV4TaskCatalog(input: {
  session: Session; request: Request; catalog: unknown;
  approvalId: string;
  catalogDigest: string; evidenceDigest: string;
  expectedPreviousVersion: number; ownerConfirmedEvidence: true;
}) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner") {
    throw new AmuxV4TaskCatalogApprovalError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV4TaskCatalogWriteEnabled(
      process.env[AMUX_V4_TASK_CATALOG_WRITE_ENV])) {
    throw new AmuxV4TaskCatalogApprovalError("unavailable");
  }
  const { inspection, catalog } = inspectedCatalog(input.catalog);
  if (!DIGEST.test(input.catalogDigest) ||
      !UUID.test(input.approvalId) ||
      inspection.catalogDigest !== input.catalogDigest ||
      !Number.isSafeInteger(input.expectedPreviousVersion) ||
      input.expectedPreviousVersion < 0 ||
      input.expectedPreviousVersion >= 2_147_483_647 ||
      input.ownerConfirmedEvidence !== true) {
    throw new AmuxV4TaskCatalogApprovalError("catalog_changed");
  }
  if (!DIGEST.test(input.evidenceDigest)) {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  const approvalId = input.approvalId;
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const now = await databaseNow(tx);
      if (catalog.routes.some((route) => route.enabled &&
          (route.pricingVerifiedAt > now.toISOString() ||
            route.pricingExpiresAt <= now.toISOString()))) {
        throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
      }
      if (AMUX_EXECUTION_GRADE_CODE_LATCH) {
        const { registrations } = await readAmuxRegistryAndDerivedCatalog(tx);
        const workerGrades = registrations ? new Map(registrations.map(
          (registration) => [registration.workerName, registration.roleCeiling] as const)) : null;
        const gradeCheck = inspectV52TaskCatalogGrades(catalog, workerGrades);
        if (!gradeCheck.ok) {
          throw new AmuxV4TaskCatalogApprovalError(
            gradeCheck.code === "worker_registry_unavailable" ?
              "worker_registry_unavailable" : "grade_route_mismatch");
        }
      }
      const latest = await tx.amuxV4TaskCostCatalogApproval.findFirst({
        orderBy: { version: "desc" }, select: { version: true },
      });
      if ((latest?.version ?? 0) !== input.expectedPreviousVersion) {
        throw new AmuxV4TaskCatalogApprovalError("catalog_changed");
      }
      const version = input.expectedPreviousVersion + 1;
      const auditId = await writeAdminAuditLog({ tx,
        session: input.session, request: input.request,
        action: "amux.v4.task_catalog.approve",
        targetType: "AmuxV4TaskCostCatalogApproval", targetId: approvalId,
        summary: "Approved one versioned Agent worker/model cost catalog without starting execution.",
        metadata: { version, catalogVersion: catalog.catalogVersion,
          pricingVersion: catalog.pricingVersion,
          catalogDigest: inspection.catalogDigest,
          evidenceDigest: input.evidenceDigest,
          ruleCount: inspection.ruleCount,
          routeCount: inspection.routeCount,
          executionStarted: false },
      });
      await tx.amuxV4TaskCostCatalogApproval.create({ data: {
        id: approvalId, version, status: "approved",
        catalogVersion: catalog.catalogVersion,
        pricingVersion: catalog.pricingVersion,
        catalog: catalog as Prisma.InputJsonValue,
        catalogDigest: inspection.catalogDigest,
        evidenceDigest: input.evidenceDigest,
        approvedByUserId: actorUserId, approvalAuditLogId: auditId,
        approvedAt: now,
      } });
      callbackReturned = true;
      return { approvalId, version, catalogDigest: inspection.catalogDigest,
        auditId, executionAuthorized: false as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4TaskCatalogApprovalError) {
      throw error;
    }
    throw new AmuxV4TaskCatalogApprovalError("outcome_unknown");
  }
}

/** A catalog drafted from the worker registry and the model registry prices,
 * with the owner's grade caps, plus the preview the approval needs. Nothing
 * is written: approving the returned catalog is the existing audited step. */
export async function draftAmuxV4TaskCatalog(
  caps: Readonly<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>>) {
  const inputs = await prisma.$transaction(async (tx) => {
    const { registrations, derived } = await readAmuxRegistryAndDerivedCatalog(tx);
    if (!registrations || !derived) {
      throw new AmuxV4TaskCatalogApprovalError("worker_registry_unavailable");
    }
    const ceilings = new Map(registrations.map((registration) =>
      [registration.workerName, registration.roleCeiling]));
    const workers = derived.v22.map((entry) => ({ workerName: entry.worker_name,
      modelId: entry.model,
      roleCeiling: ceilings.get(entry.worker_name) ?? null }));
    const models = [...new Set(workers.map((worker) => worker.modelId))];
    const rows = models.length === 0 ? [] : await tx.modelRegistryEntry.findMany({
      where: { catalogDeleted: false, provider: "anthropic",
        OR: [{ id: { in: models } }, { apiModel: { in: models } }] },
      select: { id: true, apiModel: true, inputUsdPerMillionTokens: true,
        outputUsdPerMillionTokens: true, cachedInputPriceMultiplier: true },
    });
    // A worker names the provider's model id; the registry row may carry it
    // as its id or as the API model it calls. An exact id match wins.
    const prices = models.flatMap((modelId) => {
      const row = rows.find((candidate) => candidate.id === modelId) ??
        rows.find((candidate) => candidate.apiModel === modelId);
      return row ? [{ modelId, inputUsdPerMillionTokens: row.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: row.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: row.cachedInputPriceMultiplier }] : [];
    });
    return { workers, prices, now: await databaseNow(tx) };
  });
  const draft = draftAmuxV4TaskCostCatalog({ workers: inputs.workers,
    prices: inputs.prices, caps, nowIso: inputs.now.toISOString() });
  if (!draft.ok) return draft;
  return { ...draft, preview: await previewAmuxV4TaskCatalog(draft.catalog) };
}

/** What the owner sees before drafting: the latest version, its state, when
 * its prices expire and the caps it set. Never the raw catalog JSON. */
export async function readCurrentAmuxV4TaskCatalog() {
  const latest = await prisma.amuxV4TaskCostCatalogApproval.findFirst({
    orderBy: { version: "desc" },
    select: { version: true, catalogVersion: true, status: true,
      revokedAt: true, approvedAt: true, catalog: true },
  });
  if (!latest) return { status: "none" as const };
  let catalog: V4TaskCostCatalog;
  try { ({ catalog } = inspectedCatalog(latest.catalog)); }
  catch { return { status: "unreadable" as const, version: latest.version }; }
  const now = await prisma.$transaction((tx) => databaseNow(tx));
  const enabled = catalog.routes.filter((route) => route.enabled);
  const expiresAt = enabled.map((route) => route.pricingExpiresAt).sort()[0] ?? null;
  const status = latest.status !== "approved" || latest.revokedAt ? "revoked" as const
    : expiresAt === null || expiresAt <= now.toISOString() ? "expired" as const
      : "approved" as const;
  const caps = Object.fromEntries(AMUX_TASK_CATALOG_GRADES.flatMap((grade) => {
    const rule = catalog.gradeRules.find((entry) => entry.grade === grade);
    return rule ? [[grade, { inputTokens: rule.caps.uncachedInputTokens,
      outputTokens: rule.caps.outputTokens, maxAttempts: rule.caps.maxAttempts }]] : [];
  }));
  return { status, version: latest.version, catalogVersion: latest.catalogVersion,
    approvedAt: latest.approvedAt.toISOString(), pricesExpireAt: expiresAt, caps,
    routes: enabled.map((route) => ({ workerName: route.workerName,
      modelId: route.modelId, grade: route.grades[0] ?? null,
      inputUsdPerMillion: route.uncachedInputMicroUsdPerMillion / 1_000_000,
      outputUsdPerMillion: route.outputMicroUsdPerMillion / 1_000_000 })) };
}

/** Exact-ID read-back after a lost approval response. Absence does not grant
 * permission to retry a write blindly. */
export async function readAmuxV4TaskCatalogApproval(session: Session,
  approvalId: string) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) ||
      getAdminRole(session) !== "owner") {
    throw new AmuxV4TaskCatalogApprovalError("forbidden");
  }
  const row = await prisma.amuxV4TaskCostCatalogApproval.findFirst({
    where: { id: approvalId, approvedByUserId: actorUserId },
    select: { id: true, version: true, status: true, catalogDigest: true,
      approvalAuditLogId: true },
  });
  if (!row) return { state: "not_visible", retryWrite: false } as const;
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.approvalAuditLogId },
    select: { action: true, actorUserId: true, targetId: true,
      targetType: true, entryHash: true },
  });
  if (!audit?.entryHash || audit.action !== "amux.v4.task_catalog.approve" ||
      audit.actorUserId !== actorUserId || audit.targetId !== row.id ||
      audit.targetType !== "AmuxV4TaskCostCatalogApproval") {
    return { state: "integrity_unavailable", retryWrite: false } as const;
  }
  return { state: row.status, approvalId: row.id, version: row.version,
    catalogDigest: row.catalogDigest, retryWrite: false } as const;
}

/** Called from the same registration transaction as the prepared receipt.
 * A revoked/latest missing catalog or stale price is a hold, never zero cost. */
export async function calculateCurrentApprovedAmuxV4TaskCost(
  tx: Prisma.TransactionClient, role: string, grade: string,
  options: { asOf?: Date } = {}) {
  const row = await tx.amuxV4TaskCostCatalogApproval.findFirst({
    orderBy: { version: "desc" },
  });
  if (!row || row.status !== "approved" || row.revokedAt !== null) {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  let inspection: ReturnType<typeof inspectedCatalog>;
  try { inspection = inspectedCatalog(row.catalog); }
  catch { throw new AmuxV4TaskCatalogApprovalError("catalog_changed"); }
  if (inspection.inspection.catalogDigest !== row.catalogDigest) {
    throw new AmuxV4TaskCatalogApprovalError("catalog_changed");
  }
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: row.approvalAuditLogId },
    select: { action: true, actorUserId: true, targetId: true,
      targetType: true, entryHash: true },
  });
  if (!audit?.entryHash || audit.action !== "amux.v4.task_catalog.approve" ||
      audit.actorUserId !== row.approvedByUserId ||
      audit.targetId !== row.id ||
      audit.targetType !== "AmuxV4TaskCostCatalogApproval") {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  const now = await databaseNow(tx);
  // The receipt digest includes its calculation time. A caller that must match
  // a receipt stored earlier (the v39 read-only retry chain) pins that time;
  // the price must still be valid now, so the live calculation always runs.
  const live = calculateV4TaskCeilingFromCatalog({
    rawCatalog: row.catalog, role, grade, asOfIso: now.toISOString(),
  });
  const result = options.asOf && live.ok ? calculateV4TaskCeilingFromCatalog({
    rawCatalog: row.catalog, role, grade, asOfIso: options.asOf.toISOString(),
  }) : live;
  if (!live.ok || !result.ok) {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  return { approvalId: row.id, version: row.version,
    catalogDigest: row.catalogDigest, catalog: inspection.catalog,
    receipt: result.receipt };
}
