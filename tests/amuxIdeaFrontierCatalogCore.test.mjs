import assert from "node:assert/strict";
import test from "node:test";

import { computeAdminAuditEntryHash } from "../lib/adminAuditIntegrityCore.ts";
import { verifyAmuxIdeaFrontierCatalog } from "../lib/amux/ideaFrontierCatalogCore.ts";
import { checkAmuxIdeaFrontierSelection } from "../lib/amux/ideaFrontierSelectionCore.ts";

const key = "synthetic-frontier-audit-key";
const approvedAt = new Date("2026-10-01T01:00:00.000Z");
const ownerId = "owner_0000001";
const approval = () => ({
  id: "approval_00001", provider: "openai", modelId: "frontier-v1",
  allowedEfforts: ["high", "xhigh"], version: 1, status: "approved",
  approvedAt, revokedAt: null, approvedByUserId: ownerId,
  approvalAuditLogId: "audit_00000001", revokedByUserId: null,
  revocationAuditLogId: null,
});

const makeAudit = (row, kind, previousHash = null) => {
  const isApproval = kind === "approved";
  const input = {
    previousHash,
    actorUserId: isApproval ? row.approvedByUserId : row.revokedByUserId,
    actorEmail: "owner@example.invalid",
    action: `amux.idea.frontier_model.${kind}`,
    targetType: "AmuxIdeaFrontierModelApproval",
    targetId: row.id,
    summary: `Synthetic frontier model ${kind}.`,
    metadata: isApproval ? {
      contractVersion: 1, provider: row.provider, modelId: row.modelId,
      allowedEfforts: row.allowedEfforts, version: row.version,
    } : {
      contractVersion: 1, approvalId: row.id, provider: row.provider,
      modelId: row.modelId, version: row.version,
    },
    ipAddress: null, userAgent: null,
    createdAt: (isApproval ? row.approvedAt : row.revokedAt).toISOString(),
  };
  return {
    ...input,
    id: isApproval ? row.approvalAuditLogId : row.revocationAuditLogId,
    entryHash: computeAdminAuditEntryHash(input, key),
  };
};

const verify = (rows, audits, predecessors = new Set()) =>
  verifyAmuxIdeaFrontierCatalog(rows, audits, predecessors, [key]);

test("only a bound, signed owner approval can become a selectable catalog row", () => {
  const row = approval();
  const audit = makeAudit(row, "approved");
  const result = verify([row], [audit]);
  assert.equal(result.ok, true);
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { provider: row.provider, modelId: row.modelId, reasoningEffort: "xhigh" },
    result.approvals, new Date("2026-10-01T01:01:00.000Z")),
  { decision: "selection_current", approvalId: row.id, approvalVersion: 1 });
});

test("missing or altered audit binding fails closed", () => {
  const row = approval();
  const audit = makeAudit(row, "approved");
  assert.deepEqual(verify([row], []),
    { ok: false, reason: "model_catalog_unverified" });
  assert.deepEqual(verify([{ ...row, approvalAuditLogId: null }], []),
    { ok: false, reason: "model_catalog_unverified" });
  for (const changed of [
    { ...audit, entryHash: "0".repeat(64) },
    { ...audit, targetId: "approval_99999" },
    { ...audit, actorUserId: "owner_9999999" },
    { ...audit, metadata: { ...audit.metadata, modelId: "other" } },
    { ...audit, metadata: { ...audit.metadata, extra: "unreviewed" } },
    { ...audit, createdAt: "2026-10-01T01:00:01.000Z" },
  ]) {
    assert.deepEqual(verify([row], [changed]),
      { ok: false, reason: "model_catalog_unverified" });
  }
  assert.equal(verify([row], [audit], new Set(["0".repeat(64)])).ok, true);
});

test("revocation requires its own signed actor decision and a known predecessor", () => {
  const row = { ...approval(), status: "revoked",
    revokedAt: new Date("2026-10-01T02:00:00.000Z"),
    revokedByUserId: ownerId, revocationAuditLogId: "audit_00000002" };
  const approved = makeAudit(row, "approved");
  const revoked = makeAudit(row, "revoked", approved.entryHash);
  assert.deepEqual(verify([row], [approved, revoked]),
    { ok: false, reason: "model_catalog_unverified" });
  const result = verify([row], [approved, revoked], new Set([approved.entryHash]));
  assert.equal(result.ok, true);
  assert.equal(result.approvals[0].status, "revoked");
  assert.deepEqual(verify([row], [approved, { ...revoked, metadata: {
    ...revoked.metadata, approvalId: "approval_99999",
  } }], new Set([approved.entryHash])),
  { ok: false, reason: "model_catalog_unverified" });
});

test("an unreferenced revocation audit cannot reactivate its row", () => {
  const revoked = { ...approval(), status: "revoked",
    revokedAt: new Date("2026-10-01T02:00:00.000Z"),
    revokedByUserId: ownerId, revocationAuditLogId: "audit_00000002" };
  const approvedAudit = makeAudit(revoked, "approved");
  const revocationAudit = makeAudit(revoked, "revoked", approvedAudit.entryHash);
  const rolledBack = approval();
  assert.deepEqual(verify([rolledBack], [approvedAudit, revocationAudit],
    new Set([approvedAudit.entryHash])),
  { ok: false, reason: "model_catalog_conflict" });
});

test("a partially present revocation never counts as an active approval", () => {
  const row = approval();
  const audit = makeAudit(row, "approved");
  for (const partial of [
    { ...row, revokedByUserId: ownerId },
    { ...row, revocationAuditLogId: "audit_00000002" },
    { ...row, revokedAt: new Date("2026-10-01T02:00:00.000Z") },
  ]) {
    assert.deepEqual(verify([partial], [audit]),
      { ok: false, reason: "model_catalog_unverified" });
  }
});

test("model revision history cannot fork, skip a version or retain older active rows", () => {
  const first = approval();
  const firstAudit = makeAudit(first, "approved");
  const second = { ...first, id: "approval_00002", version: 2,
    approvalAuditLogId: "audit_00000002", approvedAt: new Date("2026-10-01T03:00:00.000Z") };
  const secondAudit = makeAudit(second, "approved", firstAudit.entryHash);
  assert.deepEqual(verify([first, second], [firstAudit, secondAudit],
    new Set([firstAudit.entryHash])),
  { ok: false, reason: "model_catalog_conflict" });
  const skipped = { ...second, version: 3 };
  assert.deepEqual(verify([skipped], [makeAudit(skipped, "approved")]),
    { ok: false, reason: "model_catalog_conflict" });
});

test("revoked v1 followed by an owner-approved v2 remains a valid revision chain", () => {
  const first = { ...approval(), status: "revoked",
    revokedAt: new Date("2026-10-01T02:00:00.000Z"),
    revokedByUserId: ownerId, revocationAuditLogId: "audit_00000002" };
  const firstAudit = makeAudit(first, "approved");
  const revokeAudit = makeAudit(first, "revoked", firstAudit.entryHash);
  const second = { ...approval(), id: "approval_00002", version: 2,
    approvedAt: new Date("2026-10-01T03:00:00.000Z"),
    approvalAuditLogId: "audit_00000003" };
  const secondAudit = makeAudit(second, "approved", revokeAudit.entryHash);
  const predecessors = new Set([firstAudit.entryHash, revokeAudit.entryHash]);
  const result = verify([first, second], [firstAudit, revokeAudit, secondAudit], predecessors);
  assert.equal(result.ok, true);
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { provider: "openai", modelId: "frontier-v1", reasoningEffort: "high" },
    result.approvals, new Date("2026-10-01T04:00:00.000Z")),
  { decision: "selection_current", approvalId: second.id, approvalVersion: 2 });
  const tooEarly = { ...second, approvedAt: first.revokedAt };
  assert.deepEqual(verify([first, tooEarly],
    [firstAudit, revokeAudit, makeAudit(tooEarly, "approved", revokeAudit.entryHash)],
    predecessors),
  { ok: false, reason: "model_catalog_conflict" });
});

test("one audit decision cannot authorize two model rows", () => {
  const first = approval();
  const second = { ...approval(), id: "approval_00002", provider: "anthropic" };
  assert.deepEqual(verify([first, second], [makeAudit(first, "approved")]),
    { ok: false, reason: "model_catalog_conflict" });
});

test("different approved providers have independent revision histories", () => {
  const openai = approval();
  const anthropic = { ...approval(), id: "approval_00002",
    provider: "anthropic", modelId: "different-frontier",
    approvalAuditLogId: "audit_00000002" };
  const result = verify([openai, anthropic],
    [makeAudit(openai, "approved"), makeAudit(anthropic, "approved")]);
  assert.equal(result.ok, true);
  assert.equal(result.approvals.length, 2);
});

test("an unrecognized audit action for a catalog row cannot be ignored", () => {
  const row = approval();
  const audit = makeAudit(row, "approved");
  const unexpected = { ...audit, id: "audit_00000002",
    action: "amux.idea.frontier_model.other" };
  assert.deepEqual(verify([row], [audit, unexpected]),
    { ok: false, reason: "model_catalog_conflict" });
});

test("missing integrity key and invalid row shape never become permission", () => {
  const row = approval();
  const audit = makeAudit(row, "approved");
  assert.deepEqual(verifyAmuxIdeaFrontierCatalog([row], [audit], new Set(), []),
    { ok: false, reason: "model_catalog_unverified" });
  assert.deepEqual(verify([{ ...row, provider: "xai" }], [audit]),
    { ok: false, reason: "model_catalog_unverified" });
});
