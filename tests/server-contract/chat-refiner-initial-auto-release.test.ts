import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { beforeEach, mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const runtime = {
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "11111111-1111-4111-8111-111111111111",
  AUTO_ROUTER_ROLLOUT_PERCENT: "5",
  AUTO_ROUTER_ELIGIBLE_PLANS: "Max,Plus,Max",
  AUTO_ROUTER_COHORT_SALT: "initial-release-salt-v1",
  TOMVERSE_AUTO_ROUTER_UI_ENABLED: "true",
  ROUTING_DISPATCH_INSTRUMENTATION: "enforce",
  MANIFEST_HASH_KEYS: `initial:${"k".repeat(32)}`,
  MANIFEST_HASH_ACTIVE_KEY_ID: "initial",
  ADMIN_AUDIT_INTEGRITY_SECRET: "synthetic-audit-key",
};
const evidenceRefs = {
  independentReviewJobId: "r-20261011-000000-abcdef",
  validationSealSha256: "b".repeat(64),
  deploymentReadbackSha256: "c".repeat(64),
} as const;

let rows: Array<Record<string, unknown>> = [];
let priceMatches = true;
let guardActive = true;
let guardInitializations = 0;
let nextAudit = 0;
let transactionCount = 0;
let storedRollout: string | null = null;
let sourceFingerprint = "d".repeat(64);

const tx = {
  adminAuditLog: {
    findMany: async ({ where, take, orderBy }: { where: {
      action: string | { in: string[] }; targetType?: string;
      targetId?: string;
    }; take?: number; orderBy?: Array<Record<string, string>> }) => {
      const actions = typeof where.action === "string"
        ? [where.action] : where.action.in;
      return rows.filter((row) => actions.includes(String(row.action)) &&
        (where.targetType === undefined || row.targetType === where.targetType) &&
        (where.targetId === undefined || row.targetId === where.targetId))
        .sort((left, right) => {
          const order = (left.createdAt as Date).getTime() -
            (right.createdAt as Date).getTime() ||
            String(left.id).localeCompare(String(right.id));
          return orderBy?.[0]?.createdAt === "desc" ? -order : order;
        }).slice(0, take);
    },
  },
  appSetting: {
    findUnique: async () => storedRollout === null ? null : { value: storedRollout },
    upsert: async ({ create, update }: { create: { value: string };
      update: { value: string } }) => {
      storedRollout = storedRollout === null ? create.value : update.value;
      return { value: storedRollout };
    },
  },
};

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeAdminAuditLog: async (input: Record<string, unknown>) => {
    nextAudit += 1;
    const previous = rows.at(-1);
    const row = { id: `audit-${nextAudit}`,
      actorUserId: "owner-id", actorEmail: "owner@example.test",
      action: input.action, targetType: input.targetType,
      targetId: input.targetId, summary: input.summary,
      metadata: input.metadata, ipAddress: null, userAgent: null,
      previousHash: previous?.entryHash ?? "prior-hash",
      entryHash: `entry-hash-${nextAudit}`,
      createdAt: new Date(1_000 + nextAudit) };
    rows.push(row);
    return row.id;
  },
} });
mock.module(mod("lib/chatReleaseSourceFingerprint.ts"), { namedExports: {
  currentChatReleaseSourceFingerprint: () => sourceFingerprint,
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic-audit-key"],
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (value: unknown) => unknown) => {
    transactionCount += 1;
    return callback(tx);
  },
} } });
mock.module(mod("lib/promptRefinerProductOperationalGuard.ts"), { namedExports: {
  PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID: "auto",
  latchPromptRefinerProductAutoStopInTransaction: async () => {
    throw new Error("valid_continuing_release_must_not_record_drift");
  },
  resumePromptRefinerProductAutoGuardInTransaction: async () => {
    throw new Error("continuing_release_must_not_resume_a_guard");
  },
  initializePromptRefinerProductAutoGuard: async () => {
    guardInitializations += 1;
    return { active: false, generation: 7, reasonCode: "unknown_dispatch_or_cost" };
  },
  readPromptRefinerProductAutoGuard: async () => ({ active: guardActive }),
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

const corePromise = import(mod("lib/chatRefinerInitialAutoRelease.ts"));
const storePromise = import(mod("lib/chatRefinerInitialAutoReleaseStore.ts"));
const rolloutStorePromise = import(mod("lib/chatRefinerInitialAutoRolloutStore.ts"));
const guestStorePromise = import(mod("lib/guestChatSmartAdaptiveReleaseStore.ts"));
const productStorePromise = import(mod("lib/promptRefinerProductReleaseStore.ts"));

beforeEach(() => {
  rows = []; priceMatches = true; guardActive = true;
  guardInitializations = 0; nextAudit = 0;
  transactionCount = 0;
  storedRollout = null;
  sourceFingerprint = "d".repeat(64);
});

test("runtime binding is content-free, deterministic and closes on critical controls", async () => {
  const core = await corePromise;
  const first = core.chatRefinerInitialAutoRuntimeBinding(runtime);
  const reordered = core.chatRefinerInitialAutoRuntimeBinding({ ...runtime,
    AUTO_ROUTER_ELIGIBLE_PLANS: "Plus,Max" });
  assert.equal(first.routerConfigDigest, reordered.routerConfigDigest);
  assert.deepEqual(first.eligiblePlans, ["Max", "Plus"]);
  assert.equal(JSON.stringify(first).includes("initial-release-salt-v1"), false);
  assert.equal(JSON.stringify(first).includes("k".repeat(32)), false);
  for (const env of [
    { ...runtime, ROUTING_DISPATCH_INSTRUMENTATION: "observe" },
    { ...runtime, MANIFEST_HASH_ACTIVE_KEY_ID: "missing" },
    { ...runtime, PROMPT_REFINER_KILL_SWITCH: "1" },
    { ...runtime, AUTO_ROUTER_KILL_SWITCH: "on" },
  ]) {
    assert.throws(() => core.chatRefinerInitialAutoRuntimeBinding(env));
  }
});

test("activation writes one adjacent pair, leaves rollout untouched and does not resume a pause", async () => {
  const store = await storePromise;
  const result = await store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id", email: "owner@example.test" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  }, runtime);
  assert.equal(result.rolloutChanged, false);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.action), [
    "chat_auto.initial_release_exception_activated",
    "prompt_refiner.product_initial_auto_release_activated",
  ]);
  assert.equal(rows[1].previousHash, rows[0].entryHash);
  assert.equal(guardInitializations, 1);
  assert.equal((rows[1].metadata as Record<string, unknown>)
    .routerExceptionAuditLogId, rows[0].id);
  assert.deepEqual((rows[0].metadata as Record<string, unknown>).evidenceRefs,
    evidenceRefs);
  assert.deepEqual((rows[1].metadata as Record<string, unknown>).evidenceRefs,
    evidenceRefs);
  assert.equal(rows[0].targetType, "ChatReleaseAuthority");
  assert.equal(rows[0].targetId, rows[1].targetId);
});

test("a changed Router control closes the old pair but allows a new exact Owner pair", async () => {
  const store = await storePromise;
  const core = await corePromise;
  const input = {
    session: { user: { id: "owner-id", email: "owner@example.test" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  };
  await store.activateChatRefinerInitialAutoRelease(input, runtime);
  const changed = { ...runtime, AUTO_ROUTER_ROLLOUT_PERCENT: "10" };
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(changed), null);
  await store.activateChatRefinerInitialAutoRelease(input, changed);
  assert.equal(rows.length, 4);
  assert.notEqual(rows[0].targetId, rows[2].targetId);
  assert.equal(rows[2].targetId,
    core.chatRefinerInitialAutoRuntimeBinding(changed).releaseAuthorityDigest);
  assert.ok(await store.readChatRefinerInitialAutoRouterAuthority(changed));
  assert.equal(rows[2].previousHash, rows[1].entryHash);
});

test("Owner activation survives changed source, commit and deployment without rewriting audit", async () => {
  const store = await storePromise;
  await store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id", email: "owner@example.test" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  }, runtime);
  const originalAudits = structuredClone(rows);
  sourceFingerprint = "e".repeat(64);
  const successor = { ...runtime,
    RAILWAY_GIT_COMMIT_SHA: "c".repeat(40),
    RAILWAY_DEPLOYMENT_ID: "22222222-2222-4222-8222-222222222222" };
  const authority = await store.readChatRefinerInitialAutoRouterAuthority(
    successor);
  assert.equal(authority?.runtimeCommitSha, successor.RAILWAY_GIT_COMMIT_SHA);
  assert.equal(authority?.runtimeDeploymentId, successor.RAILWAY_DEPLOYMENT_ID);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, originalAudits);
  // Exercise the actual execution admission as well as capability minting:
  // neither may retain a current-fingerprint prefilter after source changes.
  const productStore = await productStorePromise;
  const admitted = await productStore.admitPromptRefinerProductRelease(
    tx as never, successor);
  assert.equal(admitted.autoEnabled, true);
  assert.equal(admitted.approvalAuditLogId, rows[1].id);
  assert.equal(admitted.runtimeDeploymentId, successor.RAILWAY_DEPLOYMENT_ID);
  assert.deepEqual(rows, originalAudits);
  assert.equal((rows[0].metadata as Record<string, unknown>).runtimeCommitSha,
    runtime.RAILWAY_GIT_COMMIT_SHA);
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority({
    ...successor, AUTO_ROUTER_ROLLOUT_PERCENT: "10" }), null);
  priceMatches = false;
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(
    successor), null);
});

test("deployment-bound v1 records do not silently become v2 authority", async () => {
  const store = await storePromise;
  await store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id", email: "owner@example.test" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  }, runtime);
  rows = rows.map((row) => ({ ...row, targetType: "RailwayDeployment",
    targetId: runtime.RAILWAY_DEPLOYMENT_ID }));
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime),
    null);
});

test("Guest release remains active on a new deployment but closes on guard drift", async () => {
  const base = await storePromise;
  const guest = await guestStorePromise;
  const session = { user: { id: "owner-id", email: "owner@example.test" } } as never;
  const request = new Request("https://tomverse.test", { method: "POST" });
  const guestRuntime = { ...runtime,
    CHAT_GUEST_SMART_ADAPTIVE_ROLLOUT_ENABLED: "1",
    CHAT_GUEST_SMART_ADAPTIVE_AUTHORITY_SECRET: "s".repeat(32) };
  await base.activateChatRefinerInitialAutoRelease({ session, request,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs }, guestRuntime);
  const activation = await guest.activateGuestChatSmartAdaptiveRelease({
    session, request, runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
  }, guestRuntime);
  assert.equal(activation.releaseKind, "guest_chat_smart_adaptive_v2");
  assert.equal(rows[2].targetType, "GuestChatReleaseFingerprint");
  const successor = { ...guestRuntime,
    RAILWAY_GIT_COMMIT_SHA: "c".repeat(40),
    RAILWAY_DEPLOYMENT_ID: "22222222-2222-4222-8222-222222222222" };
  sourceFingerprint = "e".repeat(64);
  const current = await guest.readGuestChatSmartAdaptiveRelease(successor);
  assert.equal(current?.binding.runtimeDeploymentId,
    successor.RAILWAY_DEPLOYMENT_ID);
  assert.equal(current?.activationAuditLogId, rows[2].id);
  assert.equal(rows.length, 3);
  assert.equal(current?.binding.releaseFingerprint, sourceFingerprint);
  rows.push({ ...rows[2], id: "duplicate-guest", createdAt: new Date(2_000) });
  assert.equal(await guest.readGuestChatSmartAdaptiveRelease(successor), null,
    "duplicate activation records are ambiguous, even if the newest is valid");
  rows.pop();
  rows.push({ ...rows[2], id: "invalid-new-guest", targetId: "f".repeat(64),
    metadata: { tampered: true }, createdAt: new Date(2_001) });
  assert.equal(await guest.readGuestChatSmartAdaptiveRelease(successor), null,
    "a newer invalid Guest activation cannot inherit the older valid one");
  rows.pop();
  guardActive = false;
  assert.equal(await guest.readGuestChatSmartAdaptiveRelease(successor), null);
});

test("a newer invalid activation never falls back to a valid older Owner pair", async () => {
  const store = await storePromise;
  await store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  }, runtime);
  rows.push({ ...rows[1], id: "invalid-newer", targetId: "f".repeat(64),
    createdAt: new Date(2_000), metadata: { tampered: true } });
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime), null);
});

test("activation rejects malformed evidence before opening a transaction", async () => {
  const store = await storePromise;
  await assert.rejects(store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs: { ...evidenceRefs,
      deploymentReadbackSha256: "not-a-digest" } as never,
  }, runtime), /activation_evidence_invalid/);
  assert.equal(transactionCount, 0);
  assert.equal(rows.length, 0);
});

test("activation preserves an existing rollout and rollout enable needs the exact pair", async () => {
  const store = await storePromise;
  const rolloutStore = await rolloutStorePromise;
  const session = { user: { id: "owner-id", email: "owner@example.test" } } as never;
  const request = new Request("https://tomverse.test", { method: "POST" });
  storedRollout = "true";
  await store.activateChatRefinerInitialAutoRelease({ session, request,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs }, runtime);
  assert.equal(storedRollout, "true");

  rows = []; storedRollout = null;
  await assert.rejects(rolloutStore.setChatRefinerInitialAutoRollout({
    session, request, enabled: true,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
  }, runtime), /rollout_authority_invalid/);
  assert.equal(storedRollout, null);
  const disabled = await rolloutStore.setChatRefinerInitialAutoRollout({
    session, request, enabled: false,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
  }, runtime);
  assert.equal(disabled.enabled, false);
  assert.equal(storedRollout, "false");
  await store.activateChatRefinerInitialAutoRelease({ session, request,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs }, runtime);
  const enabled = await rolloutStore.setChatRefinerInitialAutoRollout({
    session, request, enabled: true,
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
  }, runtime);
  assert.equal(enabled.enabled, true);
  assert.equal(storedRollout, "true");
});

test("initial activation refuses a legacy authority for the same deployment", async () => {
  const store = await storePromise;
  rows = [{ id: "legacy-activation", actorUserId: "owner-id",
    action: "prompt_refiner.product_release_activated",
    targetType: "RailwayDeployment",
    targetId: runtime.RAILWAY_DEPLOYMENT_ID,
    summary: "legacy", metadata: {}, previousHash: "prior",
    entryHash: "legacy-hash", createdAt: new Date(500) }];
  await assert.rejects(store.activateChatRefinerInitialAutoRelease({
    session: { user: { id: "owner-id" } } as never,
    request: new Request("https://tomverse.test", { method: "POST" }),
    runtimeCommitSha: runtime.RAILWAY_GIT_COMMIT_SHA,
    runtimeDeploymentId: runtime.RAILWAY_DEPLOYMENT_ID,
    evidenceRefs,
  }, runtime), /legacy_activation_present/);
  assert.equal(rows.length, 1);
  assert.equal(guardInitializations, 0);
});

test("missing, ambiguous, drifted and current-price-invalid pairs mint no authority", async () => {
  const core = await corePromise;
  const store = await storePromise;
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime), null);
  const binding = core.chatRefinerInitialAutoRuntimeBinding(runtime);
  const router = { id: "router", actorUserId: "owner", actorEmail: null,
    action: core.CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION,
    targetType: "ChatReleaseAuthority", targetId: binding.releaseAuthorityDigest,
    summary: core.CHAT_REFINER_INITIAL_AUTO_ROUTER_SUMMARY,
    metadata: core.chatRefinerInitialAutoRouterMetadata(binding, evidenceRefs),
    ipAddress: null, userAgent: null, previousHash: "prior",
    entryHash: "router-hash", createdAt: new Date(1_000) };
  const product = { ...router, id: "product",
    action: core.CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION,
    summary: core.CHAT_REFINER_INITIAL_AUTO_PRODUCT_SUMMARY,
    metadata: core.chatRefinerInitialAutoProductMetadata(
      binding, "router", evidenceRefs),
    previousHash: "router-hash", entryHash: "product-hash",
    createdAt: new Date(1_001) };
  rows = [router, product];
  assert.ok(await store.readChatRefinerInitialAutoRouterAuthority(runtime));
  rows.push({ ...product, id: "duplicate" });
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime), null);
  rows = [router, { ...product, metadata: { tampered: true } }];
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime), null);
  rows = [router, product]; priceMatches = false;
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority(runtime), null);
});

test("default-off runtime closes before a database transaction", async () => {
  const store = await storePromise;
  assert.equal(await store.readChatRefinerInitialAutoRouterAuthority({
    RAILWAY_GIT_COMMIT_SHA: runtime.RAILWAY_GIT_COMMIT_SHA,
    RAILWAY_DEPLOYMENT_ID: runtime.RAILWAY_DEPLOYMENT_ID,
  }), null);
  assert.equal(transactionCount, 0);
});
