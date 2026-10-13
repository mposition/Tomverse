import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY,
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiActualLaunchScope,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiExecutionReceiptDigest,
  amuxV22ReadOnlyApiNominalLaunchScope,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
  matchAmuxV22ReadOnlyApiLaunchScopes,
  parseAmuxV22ReadOnlyApiExecutionFrame,
  parseAmuxV22ReadOnlyApiExecutionReceipt,
} from "../lib/amux/v22ReadOnlyApiProtocol.mjs";

const repositoryScope = { sourceRevision: "a".repeat(40),
  allowedPrefixes: ["docs", "lib"] };
const frame = (overrides = {}) => ({
  version: 1,
  executorKind: "read_only_api_retry_v1",
  provider: "anthropic",
  modelId: "claude-opus-5-5",
  routeId: "recovery:anthropic",
  routePolicyDigest: "1".repeat(64),
  catalogApprovalId: "catalog:approved",
  catalogVersion: "catalog-v1",
  catalogDigest: "2".repeat(64),
  pricingVersion: "pricing-v1",
  pricingSource: "verified-record",
  pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
  pricingExpiresAt: "2026-10-20T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 1_250_000,
  outputMicroUsdPerMillion: 5_000_000,
  tokenLimits: { uncachedInputTokens: 1_000, cacheReadTokens: 500,
    cacheWriteTokens: 500, outputTokens: 1_000 },
  maxProviderTurns: 8,
  maxOutputTokensPerTurn: 1_000,
  maxRetries: 0,
  maximumCostMicroUsd: 6_675,
  credentialProfileId: "first-task-recovery-anthropic",
  credentialMetadataDigest: "3".repeat(64),
  executorArtifactDigest: "4".repeat(64),
  settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  repositoryScopeDigest: amuxV22ReadOnlyApiRepositoryScopeDigest(repositoryScope),
  brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  ...overrides,
});

const receipt = (basis, overrides = {}) => {
  const body = {
    version: 1,
    executorKind: "read_only_api_retry_v1",
    attemptId: "00000000-0000-4000-8000-000000000001",
    invocationId: "00000000-0000-4000-8000-000000000002",
    selectedModelId: basis.modelId,
    actualModelId: basis.modelId,
    actualModelUniform: true,
    providerTurnCount: 2,
    uncachedInputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    outputTokens: 50,
    usageComplete: true,
    terminalStatus: "succeeded",
    apiExecutionFrameDigest: amuxV22ReadOnlyApiExecutionFrameDigest(basis),
    projectedCostMicroUsd: 365,
    ...overrides,
  };
  return { ...body, digest: amuxV22ReadOnlyApiExecutionReceiptDigest(body) };
};

test("broker policy v2 binds the fixed packed-object fallback without expanding model tools", () => {
  assert.equal(AMUX_V22_READ_ONLY_API_BROKER_POLICY.version, 2);
  assert.deepEqual(AMUX_V22_READ_ONLY_API_BROKER_POLICY.tools, ["Glob", "Grep", "Read"]);
  assert.deepEqual(AMUX_V22_READ_ONLY_API_BROKER_POLICY.repositoryProvenance, {
    nativeLooseObjects: true,
    packedObjectFallback: "fixed_protected_git_v1",
    fixedOperations: ["cat-file", "ls-tree", "rev-parse"],
    fixedBinary: "host_path_sha256_and_identity",
    inheritedEnvironment: false,
    systemGlobalConfig: "disabled",
    localConfig: "strict_core_plus_remote_origin_verified_but_not_loaded_by_child",
    childGitDir: "configless_reflog_directory_pre_and_post_verified",
    childTimeoutMs: 750,
    maxConcurrentChildren: 1,
    alternates: "refuse",
    replaceObjects: "disabled",
    lazyFetch: "disabled",
    network: "disabled",
    writes: "disabled",
  });
  assert.match(AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST, /^[a-f0-9]{64}$/);
});

test("strict API frame binds authoritative v4 price, caps, fixed settings and current expiry", () => {
  const value = frame();
  assert.equal(parseAmuxV22ReadOnlyApiExecutionFrame(value, {
    now: "2026-10-13T01:00:00.000Z",
  }), value);
  assert.match(amuxV22ReadOnlyApiExecutionFrameDigest(value), /^[a-f0-9]{64}$/);
  for (const mutation of [
    { settingsDigest: "0".repeat(64) },
    { brokerPolicyDigest: "0".repeat(64) },
    { toolSchemaDigest: "0".repeat(64) },
    { maxProviderTurns: 7 }, { maxRetries: 1 }, { maximumCostMicroUsd: 3_400_001 },
    { maxOutputTokensPerTurn: 999 },
    { pricingExpiresAt: "2026-10-13T01:00:00.000Z" },
    { cacheReadMicroUsdPerMillion: 0 },
  ]) assert.throws(() => parseAmuxV22ReadOnlyApiExecutionFrame(frame(mutation), {
    now: "2026-10-13T01:00:00.000Z",
  }), /read_only_api_frame_invalid/);
  assert.throws(() => parseAmuxV22ReadOnlyApiExecutionFrame(frame({
    maximumCostMicroUsd: 6_674,
  })), /read_only_api_frame_invalid/, "worst-case category ceilings must fit the route cap");
  assert.throws(() => parseAmuxV22ReadOnlyApiExecutionFrame({ ...frame(), extra: true }),
    /read_only_api_frame_invalid/);
});

test("nominal to actual scope may replace only opaque launcherConfigDigest", () => {
  const nominal = amuxV22ReadOnlyApiNominalLaunchScope(frame(), "5".repeat(64));
  const actual = amuxV22ReadOnlyApiActualLaunchScope(nominal, "6".repeat(64));
  assert.equal(matchAmuxV22ReadOnlyApiLaunchScopes(nominal, actual), true);
  assert.equal(actual.launcherConfigDigest, "6".repeat(64));
  assert.equal(matchAmuxV22ReadOnlyApiLaunchScopes(nominal, {
    ...actual, apiExecutionFrameDigest: "7".repeat(64),
  }), false);
  assert.equal(matchAmuxV22ReadOnlyApiLaunchScopes(nominal, { ...actual, extra: true }), false);
});

test("repository scope digest requires deterministic UTF-8 bytewise prefix order", () => {
  assert.match(amuxV22ReadOnlyApiRepositoryScopeDigest(repositoryScope), /^[a-f0-9]{64}$/);
  assert.throws(() => amuxV22ReadOnlyApiRepositoryScopeDigest({
    ...repositoryScope, allowedPrefixes: ["lib", "docs"],
  }), /read_only_api_frame_invalid/);
  for (const prefix of ["/lib", "../lib", "lib\\x", "lib/.git", "lib\0x"])
    assert.throws(() => amuxV22ReadOnlyApiRepositoryScopeDigest({
      ...repositoryScope, allowedPrefixes: [prefix],
    }), /read_only_api_frame_invalid/);
});

test("content-free receipt requires exact model, complete categories, caps, cost and digest", () => {
  const basis = frame();
  const value = receipt(basis);
  assert.equal(parseAmuxV22ReadOnlyApiExecutionReceipt(value, basis), value);
  for (const mutation of [
    { actualModelId: "claude-other" }, { actualModelUniform: false },
    { usageComplete: false }, { cacheWriteTokens: null },
    { providerTurnCount: 9 }, { outputTokens: 1_001 },
    { projectedCostMicroUsd: 0 }, { digest: "0".repeat(64) },
  ]) {
    const changed = { ...value, ...mutation };
    if (!Object.hasOwn(mutation, "digest")) {
      const body = { ...changed }; delete body.digest;
      changed.digest = amuxV22ReadOnlyApiExecutionReceiptDigest(body);
    }
    assert.throws(() => parseAmuxV22ReadOnlyApiExecutionReceipt(changed, basis),
      /read_only_api_receipt_incomplete/);
  }
  assert.equal(JSON.stringify(value).includes("prompt"), false);
  assert.equal(JSON.stringify(value).includes("path"), false);
});
