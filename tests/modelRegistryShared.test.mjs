import assert from "node:assert/strict";
import test from "node:test";
import {
  isApprovedProviderApiBaseUrl,
  isApprovedProviderApiKeyEnvName,
  isSafeProviderApiBaseUrl,
  normalizeApiBaseUrl,
  PROVIDER_API_CONFIGURATION,
} from "../lib/modelRegistryShared.ts";

test("provider registry defaults use public HTTPS endpoints and named environment keys", () => {
  for (const [provider, configuration] of Object.entries(
    PROVIDER_API_CONFIGURATION
  )) {
    assert.equal(isSafeProviderApiBaseUrl(configuration.baseUrl), true, provider);
    assert.match(configuration.apiKeyEnvName, /^[A-Z][A-Z0-9_]*$/);
  }
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
