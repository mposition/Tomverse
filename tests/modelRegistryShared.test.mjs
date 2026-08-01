import assert from "node:assert/strict";
import test from "node:test";
import {
  isApprovedProviderApiBaseUrl,
  isApprovedProviderApiKeyEnvName,
  isSafeProviderApiBaseUrl,
  normalizeApiBaseUrl,
  PROVIDER_API_CONFIGURATION,
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS,
  staticModelRegistryReconciliationRows,
} from "../lib/modelRegistryShared.ts";

test("provider registry defaults use public HTTPS endpoints and named environment keys", () => {
  for (const [provider, configuration] of Object.entries(
    PROVIDER_API_CONFIGURATION
  )) {
    assert.equal(isSafeProviderApiBaseUrl(configuration.baseUrl), true, provider);
    assert.match(configuration.apiKeyEnvName, /^[A-Z][A-Z0-9_]*$/);
  }
});

test("catalog reconciliation is exact-ID scoped and preserves operator-owned fields", () => {
  const rows = staticModelRegistryReconciliationRows();
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...STATIC_CATALOG_RECONCILIATION_MODEL_IDS].sort()
  );

  for (const row of rows) {
    assert.equal("catalogDeleted" in row.data, false, row.id);
    assert.equal("sortOrder" in row.data, false, row.id);
    assert.equal("apiBaseUrl" in row.data, false, row.id);
    assert.equal("apiKeyEnvName" in row.data, false, row.id);
  }

  const active = rows.find((row) => row.id === "gemini-2-5-flash");
  assert.ok(active);
  assert.equal(active.data.apiModel, "gemini-3.5-flash-lite");
  assert.equal("enabled" in active.data, false);
  assert.equal("status" in active.data, false);

  const scout = rows.find((row) => row.id === "llama-4-scout");
  assert.ok(scout);
  assert.equal(scout.data.enabled, false);
  assert.equal(scout.data.publiclyListed, false);
  assert.equal(scout.data.status, "disabled");
  assert.equal(scout.data.replacementModelId, "groq-gpt-oss-120b");
});

test("model registry URL validation blocks SSRF-oriented endpoints", () => {
  for (const value of [
    "http://api.example.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.1.2.3/v1",
    "https://192.168.1.20/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?secret=value",
  ]) {
    assert.equal(isSafeProviderApiBaseUrl(value), false, value);
  }
  assert.equal(isSafeProviderApiBaseUrl("https://gateway.example.com/v1"), true);
  assert.equal(normalizeApiBaseUrl("https://gateway.example.com/v1/"), "https://gateway.example.com/v1");
});

test("runtime provider connections accept only code-owned endpoint and key mappings", () => {
  for (const [provider, configuration] of Object.entries(PROVIDER_API_CONFIGURATION)) {
    assert.equal(
      isApprovedProviderApiBaseUrl(provider, configuration.baseUrl),
      true,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, configuration.apiKeyEnvName),
      true,
      provider
    );
    assert.equal(
      isApprovedProviderApiBaseUrl(provider, "https://attacker.example/collect"),
      false,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, "DATABASE_URL"),
      false,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, "STRIPE_SECRET_KEY"),
      false,
      provider
    );
  }
});
