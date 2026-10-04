import assert from "node:assert/strict";
import test from "node:test";

import {
  checkAmuxIdeaActualModel,
  checkAmuxIdeaFrontierSelection,
} from "../lib/amux/ideaFrontierSelectionCore.ts";

const now = new Date("2026-10-01T01:00:00.000Z");
const selected = () => ({ provider: "openai", modelId: "frontier-v1", reasoningEffort: "xhigh" });
const approval = () => ({
  id: "approval_00001", provider: "openai", modelId: "frontier-v1",
  allowedEfforts: ["high", "xhigh"], version: 1, status: "approved",
  approvedAt: new Date("2026-09-30T01:00:00.000Z"), revokedAt: null,
  approvedByUserId: "owner_0000001", approvalAuditLogId: "audit_00000001",
});

test("one current owner-approved Frontier selection is exact, not name-hardcoded", () => {
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [approval()], now),
    { decision: "selection_current", approvalId: "approval_00001", approvalVersion: 1 });
  const another = { ...approval(), id: "approval_00002", modelId: "different-frontier" };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { ...selected(), modelId: "different-frontier" }, [another], now),
  { decision: "selection_current", approvalId: "approval_00002", approvalVersion: 1 });
});

test("other providers, unapproved models and efforts cannot silently fall back", () => {
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { ...selected(), provider: "xai" }, [approval()], now),
  { decision: "reject", reason: "model_selection_unsupported" });
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { ...selected(), modelId: "other" }, [approval()], now),
  { decision: "reject", reason: "model_not_approved" });
  assert.deepEqual(checkAmuxIdeaFrontierSelection(
    { ...selected(), reasoningEffort: "low" }, [approval()], now),
  { decision: "reject", reason: "model_not_approved" });
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [], now),
    { decision: "reject", reason: "model_not_approved" });
});

test("revocation and future approvals cannot authorize a run", () => {
  const revoked = { ...approval(), status: "revoked",
    revokedAt: new Date("2026-10-01T00:59:00.000Z") };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [revoked], now),
    { decision: "reject", reason: "model_not_approved" });
  const laterRevocation = { ...revoked, id: "approval_00002", version: 2 };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [approval(), laterRevocation], now),
    { decision: "reject", reason: "model_not_approved" });
  const reapproved = { ...approval(), id: "approval_00003", version: 3,
    approvedAt: new Date("2026-10-01T01:00:00.000Z") };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(),
    [approval(), laterRevocation, reapproved], now),
  { decision: "selection_current", approvalId: "approval_00003", approvalVersion: 3 });
  const rollback = { ...reapproved, approvedAt: new Date("2026-09-29T01:00:00.000Z") };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(),
    [approval(), laterRevocation, rollback], now),
  { decision: "hold", reason: "model_catalog_conflict" });
  const future = { ...approval(), approvedAt: new Date("2026-10-01T01:01:00.000Z") };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [future], now),
    { decision: "reject", reason: "model_not_approved" });
});

test("duplicate active approvals and corrupt catalog fail closed", () => {
  const duplicate = { ...approval(), id: "approval_00002" };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [approval(), duplicate], now),
    { decision: "hold", reason: "model_catalog_conflict" });
  const noAudit = { ...approval(), approvalAuditLogId: "" };
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [noAudit], now),
    { decision: "hold", reason: "model_catalog_unverified" });
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [approval(), approval()], now),
    { decision: "hold", reason: "model_catalog_unverified" });
  assert.deepEqual(checkAmuxIdeaFrontierSelection(selected(), [approval()], new Date("invalid")),
    { decision: "hold", reason: "model_catalog_unverified" });
});

test("actual CLI substitution is a halt, not a model downgrade", () => {
  assert.deepEqual(checkAmuxIdeaActualModel(selected(), selected()), { decision: "matches" });
  for (const observed of [
    { ...selected(), provider: "anthropic" },
    { ...selected(), modelId: "cheaper-model" },
    { ...selected(), reasoningEffort: "high" },
    { ...selected(), modelId: "" },
  ]) {
    assert.deepEqual(checkAmuxIdeaActualModel(selected(), observed),
      { decision: "halt", reason: "model_substituted" });
  }
});
