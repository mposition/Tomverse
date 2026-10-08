import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES,
  decideFrontierCatalogApprovalVersion,
  frontierApprovalAuditMetadata,
  frontierCatalogReadPermitted,
  frontierCatalogWritePermitted,
  frontierRevocationAuditMetadata,
  inspectFrontierCatalogWrite,
} from "../lib/amux/ideaFrontierCatalogWriteCore.ts";

const approvalId = "12345678-1234-4123-8123-123456789abc";
const approve = () => ({
  schemaVersion: 1, action: "approve", approvalId,
  provider: "openai", modelId: "frontier-v1",
  allowedEfforts: ["ultra", "high", "low"],
  expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
});
const inspect = (value) => inspectFrontierCatalogWrite(JSON.stringify(value));

test("the owner approval request sorts efforts before storage and audit binding", () => {
  const result = inspect(approve());
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.allowedEfforts, ["low", "high", "ultra"]);
  assert.deepEqual(frontierApprovalAuditMetadata(result.request, 1), {
    contractVersion: 1,
    provider: "openai",
    modelId: "frontier-v1",
    allowedEfforts: ["low", "high", "ultra"],
    version: 1,
  });
});

test("unsupported providers, malformed IDs, missing consent and duplicate efforts are refused", () => {
  for (const candidate of [
    { ...approve(), provider: "xai" },
    { ...approve(), approvalId: "not-uuid" },
    { ...approve(), ownerConfirmedFrontierEligibility: false },
    { ...approve(), allowedEfforts: ["high", "high"] },
    { ...approve(), allowedEfforts: [] },
    { ...approve(), extra: true },
    { ...approve(), modelId: "../secret" },
  ]) {
    assert.deepEqual(inspect(candidate), { ok: false, code: "schema_rejected" });
  }
  const huge = " ".repeat(AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES + 1);
  assert.deepEqual(inspectFrontierCatalogWrite(huge),
    { ok: false, code: "too_large" });
});

test("revocation binds an exact approved row and explicit owner confirmation", () => {
  const result = inspect({ schemaVersion: 1, action: "revoke", approvalId,
    expectedVersion: 2, ownerConfirmedRevocation: true });
  assert.equal(result.ok, true);
  assert.equal(result.request.action, "revoke");
  assert.deepEqual(frontierRevocationAuditMetadata({
    id: approvalId, provider: "anthropic", modelId: "frontier-v2", version: 2,
  }), {
    contractVersion: 1, approvalId, provider: "anthropic",
    modelId: "frontier-v2", version: 2,
  });
  assert.deepEqual(inspect({ schemaVersion: 1, action: "revoke", approvalId,
    expectedVersion: 2, ownerConfirmedRevocation: false }),
  { ok: false, code: "schema_rejected" });
});

test("approval version only advances from absent or revoked latest history", () => {
  assert.deepEqual(decideFrontierCatalogApprovalVersion(null, 0),
    { decision: "allow", nextVersion: 1 });
  assert.deepEqual(decideFrontierCatalogApprovalVersion({
    version: 1, status: "revoked",
  }, 1), { decision: "allow", nextVersion: 2 });
  assert.deepEqual(decideFrontierCatalogApprovalVersion({
    version: 1, status: "approved",
  }, 1), { decision: "conflict", reason: "catalog_revision_changed" });
  assert.deepEqual(decideFrontierCatalogApprovalVersion({
    version: 2, status: "revoked",
  }, 1), { decision: "conflict", reason: "catalog_revision_changed" });
  assert.deepEqual(decideFrontierCatalogApprovalVersion({
    version: 0, status: "revoked",
  }, 0), { decision: "hold", reason: "catalog_state_unverified" });
});

test("the new catalog writer and reader require their dedicated environment values", () => {
  assert.equal(frontierCatalogWritePermitted(undefined), false);
  assert.equal(frontierCatalogWritePermitted("enabled"), true);
  assert.equal(frontierCatalogReadPermitted(undefined), false);
  assert.equal(frontierCatalogReadPermitted("enabled"), true);
});

test("only the catalog service may call its latch-bypassing transaction body", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const consumers = [];
  const walk = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && /\.[cm]?[jt]sx?$/.test(item.name) &&
        readFileSync(path, "utf8").includes("commitFrontierCatalogDecision")) {
        consumers.push(path.slice(root.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  walk(join(root, "app"));
  walk(join(root, "lib"));
  assert.deepEqual(consumers, ["lib/amux/ideaFrontierCatalogWrite.ts"]);
});
