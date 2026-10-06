import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let receiptValid = true;
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), {
  namedExports: { promptRefinerVnextOneShotAuditReceiptIsValid: async () => receiptValid },
});
const { promptRefinerVnextOneShotPaidAuthorizationMetadata,
  readPromptRefinerVnextOneShotPaidAuthorization } = await import(
    mod("lib/promptRefinerVnextOneShotPaidAuthorization.ts"));
const stage = {
  id: "prompt-refiner-vnext-one-shot-v4", status: "run_approved",
  approvedBy: "synthetic-owner", stageApprovalAuditLogId: "stage-audit",
  runApprovalAuditLogId: "run-audit",
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "33333333-3333-4333-8333-333333333333",
  runtimeCommitSha: "e".repeat(40), pricePinDigest: "f".repeat(64),
  perRequestCostMicroUsd: 29918n, slotCount: 80,
  costCeilingMicroUsd: 2393440n,
};
const shadowAt = new Date("2026-10-05T00:00:00.000Z");
const paid = {
  id: "paid-audit", actorUserId: stage.approvedBy,
  action: "prompt_refiner.vnext_one_shot.paid_dispatch_authorized",
  targetType: "PromptRefinerVnextOneShotStage", targetId: stage.id,
  summary: "Separately authorized the bounded Prompt Refiner vNext one-shot paid dispatch.",
  metadata: promptRefinerVnextOneShotPaidAuthorizationMetadata(stage, "shadow-audit"),
  createdAt: new Date(shadowAt.getTime() + 1000),
};
let rows = [];
const tx = { adminAuditLog: {
  findMany: async () => rows,
  findUnique: async () => ({ createdAt: shadowAt }),
} };
const read = () => readPromptRefinerVnextOneShotPaidAuthorization(
  tx, stage, "shadow-audit",
);

test("missing, duplicate and drifted paid audits never authorize a slot", async () => {
  rows = [];
  assert.deepEqual(await read(), { present: false, valid: false, auditLogId: null });
  rows = [paid, paid];
  assert.deepEqual(await read(), { present: true, valid: false, auditLogId: null });
  rows = [{ ...paid, metadata: { ...paid.metadata, manifestRoot: "0".repeat(64) } }];
  assert.deepEqual(await read(), { present: true, valid: false, auditLogId: null });
  rows = [paid]; receiptValid = false;
  assert.deepEqual(await read(), { present: true, valid: false, auditLogId: null });
  receiptValid = true;
  assert.deepEqual(await read(), { present: true, valid: true, auditLogId: "paid-audit" });
});
