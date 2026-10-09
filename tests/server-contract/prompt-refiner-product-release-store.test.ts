import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const runtime = { RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "22222222-2222-4222-8222-222222222222" };
const target = { stageId: "prompt-refiner-vnext-one-shot-v4",
  gateAuditLogId: "gate-audit", dispositionAuditLogId: "disposition-audit",
  limitedAuditReceiptId: "limited-audit",
  runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
  runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID } as const;
let activationRows: Array<Record<string, unknown>> = [];
let priceMatches = true;
let sourceMatches = true;
let queryFails = false;
const stopReasons: string[] = [];

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {}, writeAdminAuditLog: async () => "audit",
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic"],
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/promptRefinerProductOperationalGuard.ts"), { namedExports: {
  PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID: "auto",
  initializePromptRefinerProductAutoGuard: async () => ({ initialized: true,
    active: true, generation: 1 }),
  readPromptRefinerProductAutoGuard: async () => ({ active: true,
    generation: 1, reasonCode: null, transitionAuditLogId: "activation" }),
  resumePromptRefinerProductAutoGuardInTransaction: async () => ({ active: true,
    generation: 2 }),
  latchPromptRefinerProductAutoStopInTransaction: async (_tx: unknown,
    reason: string) => { stopReasons.push(reason); return { active: false }; },
} });
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: {
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot: async () => {
      if (!sourceMatches) throw new Error("synthetic_source_drift");
      return { candidateSourceVerified: true };
    },
  },
});
mock.module(mod("lib/promptRefinerVnextOneShotGateEvidence.ts"), { namedExports: {
  readPromptRefinerVnextOneShotGateEvidence: async () => ({ valid: true,
    gateAuditLogId: target.gateAuditLogId, gateOutcome: "fail",
    latencyOnlyFailure: true, reasonCodes: ["latency_ceiling_exceeded"] }),
  readPromptRefinerVnextOneShotDisposition: async () => ({ valid: true,
    dispositionAuditLogId: target.dispositionAuditLogId,
    finalDisposition: "fail" }),
} });
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), { namedExports: {
  promptRefinerVnextOneShotAuditReceiptIsValid: async () => true,
} });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => ({
    pricePinMatchesRegistry: priceMatches,
    problems: priceMatches ? [] : ["price_pin_mismatch"],
  }) },
});

const storePromise = import(mod("lib/promptRefinerProductReleaseStore.ts"));

const tx = async () => {
  const store = await storePromise;
  const limitedMetadata = store.promptRefinerProductLimitedAuditMetadata(
    target, 0);
  const limited = { id: target.limitedAuditReceiptId,
    actorUserId: "owner", summary:
      "Recorded the owner's content-free Prompt Refiner limited audit receipt.",
    metadata: limitedMetadata, createdAt: new Date() };
  return {
    adminAuditLog: { findMany: async ({ where }: { where: { action: string } }) => {
      if (queryFails) throw new Error("synthetic_db_unavailable");
      return where.action === "prompt_refiner.product_release_activated"
        ? activationRows : [limited];
    } },
    promptRefinerVnextOneShotStage: { findUnique: async () => ({
      id: target.stageId, approvedBy: "owner", sourceCommitSha: "b".repeat(40),
      sourceManifestDigest: "c".repeat(64),
    }) },
  };
};

beforeEach(async () => {
  stopReasons.length = 0; priceMatches = true; sourceMatches = true;
  queryFails = false;
  const store = await storePromise;
  activationRows = [{ id: "activation", actorUserId: "owner",
    createdAt: new Date("2026-10-10T00:00:00.000Z"),
    summary: "Activated the exact-deployment Prompt Refiner product release.",
    metadata: store.promptRefinerProductActivationMetadata(target) }];
});

test("release absence and database uncertainty close without inventing a stop", async () => {
  const store = await storePromise;
  activationRows = [];
  assert.equal((await store.readPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, []);
  queryFails = true;
  await assert.rejects(store.readPromptRefinerProductRelease(
    await tx() as never, runtime), /synthetic_db_unavailable/);
  assert.deepEqual(stopReasons, []);
});

test("an exactly bound activated release remains enabled", async () => {
  const store = await storePromise;
  const result = await store.readPromptRefinerProductRelease(
    await tx() as never, runtime);
  assert.deepEqual(stopReasons, []);
  assert.equal(result.explicitEnabled, true);
  assert.equal(result.autoEnabled, true);
});

test("an activated release latches source, price and approval drift", async () => {
  const store = await storePromise;
  sourceMatches = false;
  assert.equal((await store.readPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["critical_safety_failure"]);

  stopReasons.length = 0; sourceMatches = true; priceMatches = false;
  assert.equal((await store.readPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["unknown_dispatch_or_cost"]);

  stopReasons.length = 0;
  activationRows[0] = { ...activationRows[0], summary: "tampered" };
  assert.equal((await store.readPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["audit_failure"]);
});
