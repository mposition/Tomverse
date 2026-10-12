import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const runtime = { RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "22222222-2222-4222-8222-222222222222",
  AUTO_ROUTER_ROLLOUT_PERCENT: "5",
  AUTO_ROUTER_ELIGIBLE_PLANS: "Max,Plus",
  AUTO_ROUTER_COHORT_SALT: "product-release-store-test-cohort",
  TOMVERSE_AUTO_ROUTER_UI_ENABLED: "true",
  ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
  MANIFEST_HASH_KEYS: `test-key:${"m".repeat(32)}`,
  MANIFEST_HASH_ACTIVE_KEY_ID: "test-key" };
const target = { stageId: "prompt-refiner-vnext-one-shot-v4",
  gateAuditLogId: "gate-audit", dispositionAuditLogId: "disposition-audit",
  limitedAuditReceiptId: "limited-audit",
  runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
  runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID } as const;
let activationRows: Array<Record<string, unknown>> = [];
let priceMatches = true;
let sourceMatches = true;
let queryFails = false;
let sourceReadCount = 0;
let stageReadCount = 0;
let priceReadCount = 0;
let auditValidationCount = 0;
let guardActive = true;
let guardGeneration = 1;
let guardReasonCode: string | null = null;
let guardTransitionAuditLogId = "activation";
let capturedAuditMetadata: unknown = null;
let initialInspection: Readonly<Record<string, unknown>> = { state: "absent" };
let priorSourceActivation = false;
const stopReasons: string[] = [];

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeAdminAuditLog: async (input: { metadata: unknown }) => {
    capturedAuditMetadata = input.metadata;
    return "resume-audit";
  },
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic"],
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (value: unknown) => unknown) => callback(await tx()),
} } });
mock.module(mod("lib/promptRefinerProductOperationalGuard.ts"), { namedExports: {
  PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID: "auto",
  initializePromptRefinerProductAutoGuard: async () => ({ initialized: true,
    active: true, generation: 1 }),
  readPromptRefinerProductAutoGuard: async () => ({ active: guardActive,
    generation: guardGeneration, reasonCode: guardReasonCode,
    transitionAuditLogId: guardTransitionAuditLogId }),
  resumePromptRefinerProductAutoGuardInTransaction: async () => {
    guardActive = true; guardGeneration += 1;
    guardReasonCode = null; guardTransitionAuditLogId = "resume-audit";
    return { active: true, generation: guardGeneration };
  },
  latchPromptRefinerProductAutoStopInTransaction: async (_tx: unknown,
    reason: string) => { stopReasons.push(reason); return { active: false }; },
} });
mock.module(mod("lib/chatRefinerInitialAutoReleaseStore.ts"), { namedExports: {
  inspectChatRefinerInitialAutoRelease: async () => initialInspection,
} });
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: {
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot: async () => {
      sourceReadCount += 1;
      if (!sourceMatches) throw new Error("synthetic_source_drift");
      return { candidateSourceVerified: true };
    },
  },
});
mock.module(mod("lib/promptRefinerProductStageSnapshot.ts"), { namedExports: {
  readPromptRefinerProductStageSnapshot: async () => {
    stageReadCount += 1;
    return { id: target.stageId, status: "closed", approvedBy: "owner",
      approvedAt: new Date("2026-10-09T00:00:00.000Z"),
      stageApprovalAuditLogId: "stage-audit",
      runApprovalAuditLogId: "run-audit", sourceCommitSha: "b".repeat(40),
      sourceManifestDigest: "c".repeat(64), runnerDigest: "d".repeat(64),
      manifestRoot: "e".repeat(64), runtimeDeploymentId: target.runtimeDeploymentId,
      runtimeCommitSha: target.runtimeCommitSha, pricePinDigest: "f".repeat(64),
      perRequestCostMicroUsd: BigInt(1), slotCount: 80,
      costCeilingMicroUsd: BigInt(80) };
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotGateEvidence.ts"), { namedExports: {
  readPromptRefinerVnextOneShotGateEvidence: async () => ({ valid: true,
    gateAuditLogId: target.gateAuditLogId, gateOutcome: "fail",
    latencyOnlyFailure: true, reasonCodes: ["latency_ceiling_exceeded"] }),
  readPromptRefinerVnextOneShotDisposition: async () => ({ valid: true,
    dispositionAuditLogId: target.dispositionAuditLogId,
    finalDisposition: "fail" }),
} });
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), { namedExports: {
  promptRefinerVnextOneShotAuditReceiptIsValid: async () => {
    auditValidationCount += 1;
    return true;
  },
} });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => {
    priceReadCount += 1;
    return { pricePinMatchesRegistry: priceMatches,
      problems: priceMatches ? [] : ["price_pin_mismatch"] };
  } },
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
    adminAuditLog: { findMany: async ({ where }: { where: {
      action: string | { in: string[] };
      targetType?: string;
    } }) => {
      if (queryFails) throw new Error("synthetic_db_unavailable");
      if (where.action === "prompt_refiner.product_release_activated") {
        return activationRows;
      }
      if (where.action ===
          "prompt_refiner.product_initial_auto_release_activated" &&
          where.targetType === "ChatReleaseAuthority") {
        return priorSourceActivation ? [{ id: "prior-v2-product" }] : [];
      }
      if (typeof where.action === "object") {
        return initialInspection.state === "absent" ? [] : [{ id: "initial" }];
      }
      return [limited];
    } },
  };
};

beforeEach(async () => {
  stopReasons.length = 0; priceMatches = true; sourceMatches = true;
  queryFails = false; sourceReadCount = 0; priceReadCount = 0;
  auditValidationCount = 0; stageReadCount = 0;
  guardActive = true; guardGeneration = 1; guardReasonCode = null;
  guardTransitionAuditLogId = "activation"; capturedAuditMetadata = null;
  initialInspection = { state: "absent" };
  priorSourceActivation = false;
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

test("an authenticated view reads no source, price or audit proof", async () => {
  const store = await storePromise;
  const result = await store.readPromptRefinerProductRelease(
    await tx() as never, runtime);
  assert.deepEqual(stopReasons, []);
  assert.deepEqual({ sourceReadCount, priceReadCount, auditValidationCount },
    { sourceReadCount: 0, priceReadCount: 0, auditValidationCount: 0 });
  assert.equal(stageReadCount, 0);
  assert.equal(result.explicitEnabled, true);
  assert.equal(result.autoEnabled, true);
  const admitted = await store.admitPromptRefinerProductRelease(
    await tx() as never, runtime);
  assert.equal(admitted.explicitEnabled, true);
  assert.deepEqual({ sourceReadCount, priceReadCount, auditValidationCount },
    { sourceReadCount: 1, priceReadCount: 1, auditValidationCount: 2 });
  assert.equal(stageReadCount, 1);
});

test("fresh dispatch admission latches source, price and approval drift", async () => {
  const store = await storePromise;
  sourceMatches = false;
  assert.equal((await store.admitPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["critical_safety_failure"]);

  stopReasons.length = 0; sourceMatches = true; priceMatches = false;
  assert.equal((await store.admitPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["unknown_dispatch_or_cost"]);

  stopReasons.length = 0;
  activationRows[0] = { ...activationRows[0], summary: "tampered" };
  assert.equal((await store.admitPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, ["audit_failure"]);
});

test("a malformed view closes without mutating the operational guard", async () => {
  const store = await storePromise;
  activationRows[0] = { ...activationRows[0], summary: "tampered" };
  const result = await store.readPromptRefinerProductRelease(
    await tx() as never, runtime);
  assert.equal(result.explicitEnabled, false);
  assert.deepEqual(stopReasons, []);
  assert.deepEqual({ sourceReadCount, priceReadCount, auditValidationCount },
    { sourceReadCount: 0, priceReadCount: 0, auditValidationCount: 0 });
});

test("invalid or changed v2 controls latch on dispatch and never inherit a prior pair", async () => {
  const store = await storePromise;
  activationRows = [];
  priorSourceActivation = true;
  assert.equal((await store.admitPromptRefinerProductRelease(
    await tx() as never, { ...runtime, AUTO_ROUTER_KILL_SWITCH: "on" }))
    .autoEnabled, false);
  assert.deepEqual(stopReasons, ["critical_safety_failure"]);
  stopReasons.length = 0;
  assert.equal((await store.admitPromptRefinerProductRelease(
    await tx() as never, { ...runtime, AUTO_ROUTER_ROLLOUT_PERCENT: "10" }))
    .autoEnabled, false);
  assert.deepEqual(stopReasons, ["audit_failure"]);
  stopReasons.length = 0;
  assert.equal((await store.readPromptRefinerProductRelease(
    await tx() as never, runtime)).autoEnabled, false);
  assert.deepEqual(stopReasons, []);
});

test("a legacy exact-deployment row cannot revive an earlier v2 source pair", async () => {
  const store = await storePromise;
  priorSourceActivation = true;
  const result = await store.admitPromptRefinerProductRelease(
    await tx() as never, { ...runtime, AUTO_ROUTER_ROLLOUT_PERCENT: "10" });
  assert.equal(result.autoEnabled, false);
  assert.deepEqual(stopReasons, ["audit_failure"]);
});

test("initial release resume records the current policy and exact authority pair", async () => {
  const store = await storePromise;
  activationRows = [];
  initialInspection = { state: "active",
    binding: { runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID },
    routerActivationAuditLogId: "router-audit",
    productActivationAuditLogId: "product-audit",
    actorUserId: "owner", approvedAt: "2026-10-11T00:00:00.000Z" };
  guardActive = false; guardGeneration = 7;
  guardReasonCode = "unknown_dispatch_or_cost";
  guardTransitionAuditLogId = "pause-audit";
  const previous = {
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID,
    ADMIN_AUDIT_INTEGRITY_SECRET: process.env.ADMIN_AUDIT_INTEGRITY_SECRET,
  };
  Object.assign(process.env, runtime, {
    ADMIN_AUDIT_INTEGRITY_SECRET: "synthetic",
  });
  try {
    const result = await store.resumePromptRefinerProductAuto({
      session: { user: { id: "owner" } } as never,
      request: new Request("https://tomverse.test", { method: "POST" }),
      expectedGeneration: 7,
      expectedReasonCode: "unknown_dispatch_or_cost",
      expectedPauseAuditLogId: "pause-audit",
    });
    assert.equal(result.generation, 8);
    assert.deepEqual(capturedAuditMetadata, {
      version: "prompt-refiner-product-auto-resume-v3",
      releaseKind: "initial_auto_v2",
      policyCommit: "3aeb001a4abde2d93e945ed5e5de61b10c412c0b",
      policySha256:
        "a9dbe509a056152015a59a45fd6438304fac36f36521a1319c11f8d1704970f9",
      continuityPolicySha256:
        "b7a3a7da53cebd12530d0609bd6967297390a53e3b1d95408f20b0ae0757309c",
      operatorConfirmedReasonCode: "unknown_dispatch_or_cost",
      pauseAuditLogId: "pause-audit",
      priorGeneration: 7,
      runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
      runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
      routerExceptionAuditLogId: "router-audit",
      productActivationAuditLogId: "product-audit",
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("legacy activation refuses an initial authority for the same deployment", async () => {
  const store = await storePromise;
  initialInspection = { state: "active" };
  const previous = {
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    RAILWAY_DEPLOYMENT_ID: process.env.RAILWAY_DEPLOYMENT_ID,
    ADMIN_AUDIT_INTEGRITY_SECRET: process.env.ADMIN_AUDIT_INTEGRITY_SECRET,
  };
  Object.assign(process.env, runtime, {
    ADMIN_AUDIT_INTEGRITY_SECRET: "synthetic",
  });
  try {
    await assert.rejects(store.activatePromptRefinerProductRelease({
      session: { user: { id: "owner" } } as never,
      request: new Request("https://tomverse.test", { method: "POST" }),
      target,
    }), /initial_authority_present/);
    assert.equal(stageReadCount, 0);
    assert.equal(capturedAuditMetadata, null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
