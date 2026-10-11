import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const readerPromise = import(pathToFileURL(resolve(root,
  "lib/promptRefinerProductStageSnapshot.ts")).href);

const selected = [
  "id", "status", "sourceCommitSha", "sourceManifestDigest", "runnerDigest",
  "manifestRoot", "runtimeDeploymentId", "runtimeCommitSha", "pricePinDigest",
  "perRequestCostMicroUsd", "slotCount", "costCeilingMicroUsd", "approvedBy",
  "approvedAt", "stageApprovalAuditLogId", "runApprovalAuditLogId",
].sort();

test("the product Stage reader selects only the reviewed evidence fields", async () => {
  const { readPromptRefinerProductStageSnapshot } = await readerPromise;
  const observed: { query?: Record<string, unknown> } = {};
  const row = Object.fromEntries(selected.map((field) => [field, field]));
  const tx = { promptRefinerVnextOneShotStage: { findUnique: async (input: unknown) => {
    observed.query = input as Record<string, unknown>;
    return { ...row };
  } } };
  const result = await readPromptRefinerProductStageSnapshot(tx as never,
    "prompt-refiner-vnext-one-shot-v4");
  assert.ok(observed.query);
  assert.deepEqual(observed.query.where, { id: "prompt-refiner-vnext-one-shot-v4" });
  assert.deepEqual(Object.keys(observed.query.select as object).sort(), selected);
  assert.equal(Object.values(observed.query.select as object).every((value) => value === true),
    true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result ?? {}, "supersededAuditLogId"), false);
  assert.equal(Object.hasOwn(result ?? {}, "createdAt"), false);
  assert.equal(Object.hasOwn(result ?? {}, "updatedAt"), false);
});

test("an absent Stage remains absent", async () => {
  const { readPromptRefinerProductStageSnapshot } = await readerPromise;
  const tx = { promptRefinerVnextOneShotStage: { findUnique: async () => null } };
  assert.equal(await readPromptRefinerProductStageSnapshot(tx as never,
    "prompt-refiner-vnext-one-shot-v5"), null);
});
