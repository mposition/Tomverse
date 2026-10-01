import { timingSafeEqual } from "node:crypto";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  type AdminAuditHashInput,
} from "../adminAuditIntegrityCore.ts";
import {
  validAmuxIdeaFrontierApproval,
  type AmuxIdeaFrontierApproval,
} from "./ideaFrontierSelectionCore.ts";

/** Read-side verification only. This does not authorize a CLI invocation. */
export type AmuxIdeaFrontierCatalogRow = AmuxIdeaFrontierApproval & {
  revokedByUserId: string | null;
  revocationAuditLogId: string | null;
};

export type AmuxIdeaFrontierAuditRow = AdminAuditHashInput & {
  id: string;
  entryHash: string | null;
};

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const same = (left: string, right: string): boolean =>
  SHA256.test(left) && SHA256.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

const exactMetadata = (actual: unknown, expected: Record<string, unknown>): boolean => {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const record = actual as Record<string, unknown>;
  const keys = Object.keys(expected).sort();
  if (Object.keys(record).sort().join("\0") !== keys.join("\0")) return false;
  return keys.every((key) => Array.isArray(expected[key])
    ? Array.isArray(record[key]) &&
      JSON.stringify(record[key]) === JSON.stringify(expected[key])
    : record[key] === expected[key]);
};

const auditMatches = (
  row: AmuxIdeaFrontierCatalogRow,
  audit: AmuxIdeaFrontierAuditRow | undefined,
  kind: "approved" | "revoked",
  keys: readonly string[],
): boolean => {
  const auditId = kind === "approved" ? row.approvalAuditLogId : row.revocationAuditLogId;
  const actorId = kind === "approved" ? row.approvedByUserId : row.revokedByUserId;
  const at = kind === "approved" ? row.approvedAt : row.revokedAt;
  if (!audit || !auditId || !actorId || !at ||
      audit.id !== auditId || audit.actorUserId !== actorId ||
      audit.action !== `amux.idea.frontier_model.${kind}` ||
      audit.targetType !== "AmuxIdeaFrontierModelApproval" ||
      audit.targetId !== row.id || audit.createdAt !== at.toISOString() ||
      typeof audit.entryHash !== "string" || !SHA256.test(audit.entryHash) ||
      (audit.previousHash !== null && !SHA256.test(audit.previousHash))) return false;
  const metadata = kind === "approved" ? {
    contractVersion: 1, provider: row.provider, modelId: row.modelId,
    allowedEfforts: [...row.allowedEfforts], version: row.version,
  } : {
    contractVersion: 1, approvalId: row.id, provider: row.provider,
    modelId: row.modelId, version: row.version,
  };
  if (!exactMetadata(audit.metadata, metadata)) return false;
  const input: AdminAuditHashInput = {
    previousHash: audit.previousHash,
    actorUserId: audit.actorUserId,
    actorEmail: audit.actorEmail,
    action: audit.action,
    targetType: audit.targetType,
    targetId: audit.targetId,
    summary: audit.summary,
    metadata: audit.metadata,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
    createdAt: audit.createdAt,
  };
  return keys.some((key) => {
    const variants = adminAuditEntryHashVariants(input, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some((order) =>
      same(variants[order], audit.entryHash!));
  });
};

/**
 * Fail closed on a partial or forged catalog. The caller must load these rows
 * and audit entries from one database snapshot, prove any non-null previousHash
 * exists in that snapshot, and repeat this check immediately before a call.
 * Predecessor existence is not a full chain proof. The future owner-only write
 * path must enforce owner role and recent authentication; a historical audit
 * row alone cannot prove the actor's role at that time. This reader relies on
 * the catalog migration's one-way revoked status and refusal of DELETE and
 * populated TRUNCATE: audit-tail deletion alone cannot reactivate a revoked
 * row. The three refusals are exercised by
 * tests/integration/amux-v4-frontier-model.db.test.mjs. Bypassing those DB
 * triggers is outside the DML threat boundary.
 * The migration sets approvedAt/revokedAt from each audit createdAt, and the
 * future writer must preserve allowedEfforts order in the audit metadata.
 */
export function verifyAmuxIdeaFrontierCatalog(
  rows: readonly AmuxIdeaFrontierCatalogRow[],
  audits: readonly AmuxIdeaFrontierAuditRow[],
  predecessorHashes: ReadonlySet<string>,
  integrityKeys: readonly string[],
): { ok: true; approvals: AmuxIdeaFrontierApproval[] } |
   { ok: false; reason: "model_catalog_unverified" | "model_catalog_conflict" } {
  const unverified = { ok: false as const, reason: "model_catalog_unverified" as const };
  const conflict = { ok: false as const, reason: "model_catalog_conflict" as const };
  if (!Array.isArray(rows) || !Array.isArray(audits) ||
      !(predecessorHashes instanceof Set) || !Array.isArray(integrityKeys) ||
      rows.length > 256 || audits.length > 512 || integrityKeys.length === 0 ||
      integrityKeys.some((key) => typeof key !== "string" || key.length === 0)) return unverified;
  const byAudit = new Map<string, AmuxIdeaFrontierAuditRow>();
  for (const audit of audits) {
    if (!audit || !ID.test(audit.id) || byAudit.has(audit.id)) return unverified;
    byAudit.set(audit.id, audit);
  }
  const usedAudits = new Set<string>();
  const byModel = new Map<string, AmuxIdeaFrontierCatalogRow[]>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (!validAmuxIdeaFrontierApproval(row) || ids.has(row.id)) return unverified;
    ids.add(row.id);
    // This check is deliberately local, even though the selection core also
    // validates it: only revocation is optional, never the approval audit.
    if (!ID.test(row.approvalAuditLogId)) return unverified;
    const revocationFields = [row.revokedAt, row.revokedByUserId,
      row.revocationAuditLogId];
    const allRevocationFieldsSet = revocationFields.every((value) => value !== null);
    if ((!allRevocationFieldsSet &&
          !revocationFields.every((value) => value === null)) ||
        (row.status === "revoked") !== allRevocationFieldsSet ||
        (row.revokedByUserId !== null && !ID.test(row.revokedByUserId)) ||
        (row.revocationAuditLogId !== null && !ID.test(row.revocationAuditLogId))) return unverified;
    const decisions = [
      [row.approvalAuditLogId, "approved"],
      ...(row.revocationAuditLogId === null ? [] :
        [[row.revocationAuditLogId, "revoked"]]),
    ] as const;
    for (const [auditId, kind] of decisions) {
      if (usedAudits.has(auditId)) return conflict;
      usedAudits.add(auditId);
      const audit = byAudit.get(auditId);
      if (!auditMatches(row, audit, kind, integrityKeys) ||
          (audit!.previousHash !== null &&
            !predecessorHashes.has(audit!.previousHash))) return unverified;
    }
    const modelKey = `${row.provider}\0${row.modelId}`;
    byModel.set(modelKey, [...(byModel.get(modelKey) ?? []), row]);
  }
  // The caller supplies every audit event for each returned row target, not
  // just the IDs the row still references. A removed revocation reference
  // must not silently turn a revoked approval back into a usable one. New
  // audit action types on this target need a contract revision, not skipping.
  if (usedAudits.size !== audits.length) return conflict;
  for (const history of byModel.values()) {
    history.sort((a, b) => a.version - b.version);
    for (const [index, row] of history.entries()) {
      if (row.version !== index + 1) return conflict;
      if (index < history.length - 1 && row.status !== "revoked") return conflict;
      if (index > 0 && row.approvedAt <= history[index - 1].revokedAt!) return conflict;
    }
  }
  return { ok: true, approvals: rows.map((row) => ({
    id: row.id, provider: row.provider, modelId: row.modelId,
    allowedEfforts: [...row.allowedEfforts], version: row.version,
    status: row.status, approvedAt: row.approvedAt, revokedAt: row.revokedAt,
    approvedByUserId: row.approvedByUserId,
    approvalAuditLogId: row.approvalAuditLogId,
  })) };
}
